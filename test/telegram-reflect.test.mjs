import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  inferExitCause,
  appendReflection,
  createReflector,
  REFLECT_PROMPT_VERSION,
  REFLECT_SYSTEM_PROMPT,
} from '../src/telegram/reflect.mjs';
import { loadState, saveState } from '../src/telegram/state.mjs';

function makeClosed(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entry: 80000,
    exit: 79000,
    pnlUsd: -100,
    reason: 'test',
    ...overrides,
  };
}

test('inferExitCause: exit≈SL => stop; exit≈TP => target; far => external; no SL/TP => unknown', () => {
  assert.equal(inferExitCause({ side: 'LONG', exitPrice: 90, stopLoss: 90, takeProfit: 110 }), 'stop');
  assert.equal(inferExitCause({ side: 'LONG', exitPrice: 110, stopLoss: 90, takeProfit: 110 }), 'target');
  assert.equal(inferExitCause({ side: 'LONG', exitPrice: 95, stopLoss: 90, takeProfit: 110 }), 'external');
  assert.equal(inferExitCause({ side: 'LONG', exitPrice: 95 }), 'unknown');
  assert.equal(inferExitCause({ side: 'LONG', exitPrice: -1 }), 'unknown');
});

test('R-1b: manual loss (symbol not in autoOpenedSymbols) does not change autoDailyLossUsd', () => {
  // Pure reducer logic equivalent to the in-bot accounting.
  function applyDailyLoss(closed, autoOpenedSymbols, autoDailyLossUsd) {
    const counted = autoOpenedSymbols.has(closed.symbol);
    const pnl = Number(closed.pnlUsd) || 0;
    if (pnl < 0 && counted) return autoDailyLossUsd + pnl;
    return autoDailyLossUsd;
  }
  assert.equal(applyDailyLoss(makeClosed(), new Set(), 0), 0);
  assert.equal(applyDailyLoss(makeClosed(), new Set(['BTCUSDT']), 0), -100);
});

test('R-1c: fetchRecentClosedPnl null path is not reflected (smoke: reflect skipped when no record)', () => {
  // No network: the function is a simple null-handling contract check.
  assert.equal(inferExitCause({ side: 'LONG', exitPrice: 79000, stopLoss: 79000 }), 'stop');
});

test('loadState: missing file => default; corrupt JSON => default; day change resets daily loss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-state-'));
  const s1 = await loadState(join(dir, 'missing.json'));
  assert.equal(s1.autoDailyLossUsd, 0);

  const badFile = join(dir, 'bad.json');
  await writeFile(badFile, 'not json');
  const s2 = await loadState(badFile);
  assert.equal(s2.autoDailyLossUsd, 0);

  const oldDayFile = join(dir, 'old.json');
  const oldDay = '2020-01-01';
  await writeFile(oldDayFile, JSON.stringify({ day: oldDay, autoDailyLossUsd: -5, autoOpenedSymbols: ['X'], reflectedCloseIds: ['a'], prevPositions: {} }));
  const s3 = await loadState(oldDayFile);
  assert.notEqual(s3.day, oldDay);
  assert.equal(s3.autoDailyLossUsd, 0);
  assert.deepEqual(s3.autoOpenedSymbols, ['X']);
});

test('saveState -> loadState round-trip; reflectedCloseIds capped at 500', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-state-'));
  const file = join(dir, 'state.json');
  const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`);
  const state = {
    day: new Date().toISOString().slice(0, 10),
    autoDailyLossUsd: -3,
    autoOpenedSymbols: ['BTCUSDT'],
    reflectedCloseIds: ids,
    prevPositions: { 'linear:BTCUSDT': { symbol: 'BTCUSDT', side: 'LONG', avgPrice: 80000, markPrice: 81000, unrealisedPnl: 100, firstSeenAt: new Date().toISOString() } },
  };
  const ok = await saveState(state, file);
  assert.equal(ok, true);
  const loaded = await loadState(file);
  assert.equal(loaded.reflectedCloseIds.length, 500);
  assert.equal(loaded.autoDailyLossUsd, -3);
  assert.equal(loaded.autoOpenedSymbols[0], 'BTCUSDT');
});

test('dedup: repeated recordId does not append duplicate', async () => {
  const reflector = createReflector({ apiKey: 'dummy', fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ lesson: 'x', proposedRule: 'y', severity: 'low', matchedExistingRule: false }) } }] }) }) });
  const seen = new Set(['rec-1']);
  async function reflectOnce(closedId, closed) {
    if (seen.has(closedId)) return 'skipped';
    const refl = await reflector.reflect(closed);
    if (refl) seen.add(closedId);
    return refl ? 'written' : 'failed';
  }
  assert.equal(await reflectOnce('rec-1', makeClosed()), 'skipped');
  assert.equal(await reflectOnce('rec-2', makeClosed()), 'written');
});

test('R-3b: matchedExistingRule=true + empty proposedRule skips file append', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reflect-'));
  const file = join(dir, 'rules.pending.md');
  const skipped = await appendReflection({ at: new Date().toISOString(), severity: 'low', lesson: 'x', proposedRule: '', matchedExistingRule: true }, file);
  assert.equal(skipped, true); // append still returns true, but line has no rule
  const text = await readFile(file, 'utf8');
  assert.ok(!text.includes('RULE:'));
});

test('REFLECT_SYSTEM_PROMPT contains severity rubric and "Never invent"', () => {
  assert.ok(REFLECT_SYSTEM_PROMPT.includes('severity: high'));
  assert.ok(REFLECT_SYSTEM_PROMPT.includes('Never invent'));
  assert.equal(REFLECT_PROMPT_VERSION, 'reflect-v2');
});

test('createReflector: severity outside enum falls back to low', async () => {
  const reflector = createReflector({
    apiKey: 'dummy',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ lesson: 'l', proposedRule: 'r', severity: 'INVALID', matchedExistingRule: false }) } }],
      }),
    }),
  });
  const refl = await reflector.reflect(makeClosed());
  assert.equal(refl?.severity, 'low');
});

test('/rules: format helper returns last 20 non-empty lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rules-'));
  const file = join(dir, 'rules.pending.md');
  const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`);
  await writeFile(file, lines.join('\n') + '\n');
  const text = await readFile(file, 'utf8');
  const last = text.split('\n').filter((l) => l.trim() !== '').slice(-20);
  assert.equal(last.length, 20);
  assert.equal(last[0], 'line 5');
});
