/**
 * UAI-06B — structural inventory of AI-derived exchange writes in `bot.mjs`.
 *
 * The behavioural proof lives in `telegram-ai-effect-gateway.test.mjs`; this
 * test protects the wiring. It fails if a future edit adds an exchange write to
 * an AI path without routing it through the effect gateway, or if the
 * deterministic protection paths (trailing stops, harvest, time-stop, the close
 * helper) start depending on the AI control plane — protection must keep running
 * in every phase, including QUIESCING and PAUSED.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const BOT = readFileSync(new URL('../src/telegram/bot.mjs', import.meta.url), 'utf8');
const LINES = BOT.split('\n');

/** Exchange writes that change state on Bybit. */
const WRITE_CALLS = Object.freeze([
  /placeMarketOrder\(/,
  /placeSpotMarketOrder\(/,
  /placeLimitOrder\(/,
  /placeSpotConditionalOrder\(/,
  /setLeverage\(/,
  /setTradingStopBySymbol\(/,
  /cancelSpotOrder\(/,
  /closePosition\(/,
]);

/**
 * The nearest marker above a call site decides how that write is reached:
 * a gateway plan (AI-derived), or deterministic protection (never gated).
 */
const MARKERS = Object.freeze([
  { pattern: /aiEffects\.(dispatch|dispatchInScope)\(/, kind: 'ai' },
  { pattern: /async function closePosition\(/, kind: 'helper' },
  { pattern: /\/\/ T-1: harvest retrace lock/, kind: 'deterministic' },
  { pattern: /\/\/ T-4: time-stop/, kind: 'deterministic' },
  { pattern: /\/\/ --- Deterministic trailing \(auto\) ---/, kind: 'deterministic' },
]);

/**
 * @param {number} index
 * @returns {{ kind: string, line: number, text: string } | null}
 */
function enclosingMarker(index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const line = LINES[cursor];
    for (const marker of MARKERS) {
      if (marker.pattern.test(line)) return { kind: marker.kind, line: cursor + 1, text: line.trim() };
    }
  }
  return null;
}

test('UAI-06B: every AI-derived exchange write is reached through the effect gateway', () => {
  const offenders = [];
  for (let index = 0; index < LINES.length; index += 1) {
    const line = LINES[index];
    if (!WRITE_CALLS.some((pattern) => pattern.test(line))) continue;
    const marker = enclosingMarker(index);
    if (marker !== null && marker.kind !== 'unmarked') continue;
    offenders.push(`${index + 1}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [], 'no exchange write outside a gateway plan or a deterministic block');
});

test('UAI-06B: the fence inventory is exactly four AI dispatch lanes', () => {
  const dispatches = LINES.map((line, index) => ({ line, index })).filter(({ line }) => /aiEffects\.(dispatch|dispatchInScope)\(/.test(line));
  assert.equal(dispatches.length, 4, 'exec, doexit, stop-check auto-close and unattended entry');
  const laneLines = LINES.filter((line) => /lane:\s*['`]/.test(line));
  assert.equal(laneLines.length, 4, 'every dispatch plan is labelled so the audit trail names the lane');
});

test('UAI-06B: deterministic protection does not consult the AI control plane', () => {
  const harvestStart = LINES.findIndex((line) => /\/\/ T-1: harvest retrace lock/.test(line));
  const timeStopStart = LINES.findIndex((line) => /\/\/ T-4: time-stop/.test(line));
  const gateStart = LINES.findIndex((line, index) => index > timeStopStart && /const lossBig = pnlUsd <= -2;/.test(line));
  assert.ok(harvestStart > 0 && timeStopStart > harvestStart && gateStart > timeStopStart);
  const deterministicBlock = LINES.slice(harvestStart, gateStart).join('\n');
  assert.match(deterministicBlock, /closePosition\(/, 'the deterministic locks still close positions directly');
  assert.doesNotMatch(deterministicBlock, /aiEffects|beginWork|guard\.check/, 'no AI work token in deterministic protection');

  const trailingStart = LINES.findIndex((line) => /\/\/ --- Deterministic trailing \(auto\) ---/.test(line));
  const trailingEnd = LINES.findIndex((line, index) => index > trailingStart && /\/\/ --- LLM review \(guard\) for HOLD\/EXIT ---/.test(line));
  assert.ok(trailingStart > 0 && trailingEnd > trailingStart);
  const trailingBlock = LINES.slice(trailingStart, trailingEnd).join('\n');
  assert.match(trailingBlock, /setTradingStopBySymbol\(|placeSpotConditionalOrder\(/, 'trailing stops still move on every phase');
  assert.doesNotMatch(trailingBlock, /aiEffects|beginWork|guard\.check/, 'trailing protection never acquires an AI work token');
});

test('UAI-06B: every ticket-bound dispatch plan prepares before it writes', () => {
  // A textual "the write sits under a dispatch marker" check is what produced
  // false assurance before: a write inside a never-invoked `prepare`/`effect`
  // closure still counted as "reached through the gateway". So assert the plan
  // shapes too — an entry/exit dispatch must carry a `prepare` step declared
  // before its `effect`, because `bot.mjs` depends on what preparation produces
  // (spot quantity, leverage, the drift decision, the position a close uses).
  const sites = LINES
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /aiEffects\.(dispatch|dispatchInScope)\(/.test(line));
  assert.ok(sites.length > 0, 'the gateway call sites are found');

  for (let cursor = 0; cursor < sites.length; cursor += 1) {
    const site = sites[cursor];
    const end = cursor + 1 < sites.length ? sites[cursor + 1].index : LINES.length;
    const plan = LINES.slice(site.index, end).join('\n');
    const effectAt = plan.search(/\beffect:\s/);
    assert.ok(effectAt > 0, `line ${site.index + 1}: the plan must declare an effect`);
    if (/aiEffects\.dispatch\(/.test(site.line)) {
      const prepareAt = plan.search(/\bprepare:\s/);
      assert.ok(prepareAt > 0, `line ${site.index + 1}: an AI-derived entry/exit dispatch must carry a prepare step`);
      assert.ok(prepareAt < effectAt, `line ${site.index + 1}: prepare must be declared before the effect`);
    }
  }
});

test('UAI-06B: an AI exit proposal is fenced but an operator /orders close is not', () => {
  // Operator-initiated closes from /orders stay non-AI controls (architecture §5).
  assert.match(BOT, /reason: 'manual \/orders close', aiDerived: false/);
  // Every AI proposal records its provenance so the close button can be checked.
  const aiProposals = LINES.filter((line) => /exitProposals\.set\(pid, \{[^}]*aiDerived: work !== null/.test(line));
  assert.equal(aiProposals.length, 2, 'monitor and stop-check proposals carry AI provenance');
  const fences = LINES.filter((line) => /work\.rearm\(exitEffectKey\(pid\)/.test(line));
  assert.equal(fences.length, 2, 'both proposal paths bind the generation sidecar');
});
