/**
 * Post-trade reflector (Phase 6 / MVP-2).
 *
 * After a position closes, a cheap LLM call reviews the outcome and writes a
 * proposed rule change to a durable pending file. The change is NOT applied
 * automatically — it accumulates in `data/telegram/rules.pending.md` and is
 * reviewed/applied by a human after N trades (or manually). This protects the
 * deterministic core from prompt drift caused by a single noisy result.
 *
 * @module telegram/reflect
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const REFLECT_MODEL = 'deepseek-chat';
const KIMI_REFLECT_MODEL = 'kimi-k2-7';

export const REFLECT_PROMPT_VERSION = 'reflect-v2';

export const REFLECT_SYSTEM_PROMPT = [
  'You review ONE closed trade and propose a small, concrete rule improvement for a trading system.',
  'Respond with ONLY a JSON object: {"lesson":"one sentence","proposedRule":"short concrete rule or empty string","severity":"high"|"medium"|"low","matchedExistingRule":true|false}',
  'You receive: the trade {symbol, side, entry, exit, realized pnlUsd, exitCause ("stop"|"target"|"external"|"unknown"), holdMinutes when known} and the CURRENT pending rules.',
  'Rules:',
  '- Ground every number in the input. Never invent prices, durations or causes. If exitCause explains the close (a normal stop or target), say so — not every closed trade needs a rule; then proposedRule = "".',
  '- If the lesson repeats one of the CURRENT pending rules, set matchedExistingRule=true and proposedRule="".',
  '- severity: high = a concrete system rule was violated, with numbers; medium = an actionable, repeatable pattern; low = noise or a single observation.',
  '- Propose only rules that are checkable by code or by a prompt instruction. No strategy redesigns.',
].join('\n');

/**
 * Infer the exit cause by comparing the actual exit price with the position's
 * last known SL/TP. 'unknown' whenever the inputs are insufficient — never guess.
 *
 * @param {{ side: 'LONG'|'SHORT', exitPrice: number, stopLoss?: number|null, takeProfit?: number|null, tolerancePct?: number }} input
 * @returns {'stop' | 'target' | 'external' | 'unknown'}
 */
export function inferExitCause({ side, exitPrice, stopLoss = null, takeProfit = null, tolerancePct = 0.15 }) {
  const near = (a, b) => typeof a === 'number' && typeof b === 'number' && b > 0
    && (Math.abs(a - b) / b) * 100 <= tolerancePct;
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) return 'unknown';
  if (near(exitPrice, stopLoss)) return 'stop';
  if (near(exitPrice, takeProfit)) return 'target';
  if (stopLoss == null && takeProfit == null) return 'unknown';
  return 'external';
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {boolean} [opts.useKimi] use Moonshot AI (Kimi) instead of DeepSeek
 */
export function createReflector(opts) {
  const useKimi = opts.useKimi ?? false;
  const apiKey = opts.apiKey;
  const baseUrl = (opts.baseUrl ?? (useKimi ? 'https://api.moonshot.cn' : 'https://api.deepseek.com')).replace(/\/+$/, '');
  // api.moonshot.ai (international endpoint) rejects any temperature other
  // than 1 on current Kimi models — override locally when that host is used.
  const forcedTemp = /moonshot\.ai/.test(baseUrl) ? 1 : null;
  const model = opts.model ?? (useKimi ? KIMI_REFLECT_MODEL : REFLECT_MODEL);
  const timeoutMs = opts.timeoutMs ?? 45000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  /**
   * @param {{ symbol: string, side: string, entry: number, exit: number, pnlUsd: number, reason: string, exitCause?: string, holdMinutes?: number|null, existingRules?: string|null, newsText?: string, mfeUsd?: number|null }} trade
   * @returns {Promise<object | null>} parsed reflection, or null on any failure (never throws)
   */
  async function reflect(trade) {
    const existingRules = trade.existingRules ?? null;
    const user = JSON.stringify({ trade, existingRules });
    let content;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: REFLECT_SYSTEM_PROMPT },
              { role: 'user', content: user },
            ],
            temperature: forcedTemp ?? 0,
            stream: false,
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      const payload = await res.json();
      content = payload?.choices?.[0]?.message?.content;
    } catch {
      return null;
    }
    if (typeof content !== 'string' || content.trim() === '') return null;
    try {
      const obj = JSON.parse(content);
      return {
        lesson: typeof obj.lesson === 'string' ? obj.lesson : '',
        proposedRule: typeof obj.proposedRule === 'string' ? obj.proposedRule : '',
        severity: obj.severity === 'high' || obj.severity === 'medium' || obj.severity === 'low' ? obj.severity : 'low',
        matchedExistingRule: obj.matchedExistingRule === true,
        at: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  return { reflect };
}

/**
 * Append a reflection as a markdown bullet to the pending rules file.
 * Creates the directory as needed. Never throws.
 *
 * @param {object} reflection
 * @param {string} [file] target file path
 * @returns {Promise<boolean>} true on success
 */
export async function appendReflection(reflection, file = 'data/telegram/rules.pending.md') {
  try {
    await mkdir(dirname(file), { recursive: true });
    const line = [
      `- [${reflection.at ?? new Date().toISOString()}] (${reflection.severity})`,
      reflection.lesson ? ` ${reflection.lesson}` : '',
      reflection.proposedRule ? ` → RULE: ${reflection.proposedRule}` : '',
      reflection.matchedExistingRule ? ' [matched existing rule]' : '',
    ].filter(Boolean).join('').replace(/\n/g, ' ');
    await appendFile(file, line + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the tail of the pending rules file for grounded dedup. Never throws.
 *
 * @param {string} [file]
 * @param {number} [lines]
 * @returns {Promise<string|null>}
 */
export async function readPendingRulesTail(file = 'data/telegram/rules.pending.md', lines = 20) {
  try {
    const text = await readFile(file, 'utf8');
    const all = text.split('\n').filter((l) => l.trim() !== '');
    return all.slice(-lines).join('\n') || null;
  } catch {
    return null;
  }
}
