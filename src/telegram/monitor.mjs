/**
 * Open-position monitor (MVP-2).
 *
 * Turns the one-shot scout into a continuous position guardian. Every interval
 * it re-reads each open position, gathers fresh market + news context, and asks
 * the guard (deepseek-reasoner) whether to HOLD or EXIT.
 *
 * Safety model (agreed with the operator):
 *   - EXIT is PROPOSED to the user and executed only after an explicit approve.
 *   - Trailing stops and take-profits are managed by code (`trailing.mjs`); the
 *     LLM monitor NEVER touches prices.
 *
 * @module telegram/monitor
 */

export const MONITOR_PROMPT_VERSION = 'monitor-v2';

export const MONITOR_SYSTEM_PROMPT = [
  'You are a position guardian inside a deterministic trading system. Review ONE open trade and decide whether the original thesis still holds.',
  'Trailing stops and take-profits are managed by code — you NEVER touch prices. Your only question: HOLD or EXIT.',
  'Respond with ONLY a JSON object: {"action":"HOLD"|"EXIT","reason":"one short concrete sentence","confidence":0..1}',
  'You receive: the position {symbol, side, avgPrice, markPrice, stopLoss, takeProfit, unrealisedPnl, leverage, kind}, a market snapshot for that symbol (lastPrice, bid, ask, the last 30 HOURLY candles oldest-first as {o,h,l,c,v}, atr14h, a precomputed trend block {ema21h, change4hPct, bias}), a precomputed BTC block {bias}, and recent news headlines.',
  'Rules:',
  '- HOLD: the thesis is intact; normal open-PnL noise is NOT a reason to exit.',
  '- EXIT: the thesis is broken — the precomputed trend bias has flipped against the position AND the candles confirm (broken swing, failed retest), or adverse news with clear continuation risk. Name the evidence (bias, level, headline) in the reason.',
  '- A human reviews every EXIT before execution — recommend it only when you would defend it with numbers.',
  '- Use ONLY the data provided; never invent prices, indicators or news. If the data is insufficient, HOLD and say so.',
].join('\n');

/**
 * Build the user prompt for one position.
 *
 * @param {{ position: object, market: object, newsText: string }} input
 * @returns {{ system: string, user: string, version: string }}
 */
export function buildMonitorPrompt({ position, market, newsText }) {
  // Cache-friendly layout: the shared NEWS block comes first (identical across
  // every position reviewed in one pass and across passes while the feed is
  // unchanged), the per-position payload last. DeepSeek's cache matches on an
  // exact prefix, so anything unique at the front would defeat it.
  const shared = JSON.stringify({ news: newsText || '(no news available)' });
  const specific = JSON.stringify({ position, market });
  return {
    version: MONITOR_PROMPT_VERSION,
    system: MONITOR_SYSTEM_PROMPT,
    user: `NEWS:\n${shared}\n\nPOSITION:\n${specific}`,
  };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: object } | { ok: false, issues: string[] }}
 */
export function parseMonitorResponse(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, issues: ['monitor response is not valid JSON'] };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, issues: ['monitor response must be a JSON object'] };
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  const issues = [];
  if (obj.action !== 'HOLD' && obj.action !== 'EXIT') {
    issues.push('action must be HOLD or EXIT');
  }
  if (typeof obj.reason !== 'string' || obj.reason.trim() === '') {
    issues.push('reason must be a non-empty string');
  }
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) {
    issues.push('confidence must be a number in [0,1]');
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: Object.freeze({
      action: /** @type {'HOLD' | 'EXIT'} */ (obj.action),
      reason: /** @type {string} */ (obj.reason.trim()),
      confidence: /** @type {number} */ (obj.confidence),
    }),
  };
}

/**
 * @param {object} deps
 * @param {object} deps.chat the deepseek chat client (must expose a raw complete or monitor method)
 * @param {(position: object, market: object, newsText: string) => Promise<object>} deps.complete low-level completion returning {raw, parsed}
 */
export function createMonitor(deps) {
  const complete = deps.complete;

  /**
   * Review one open position and return a structured decision.
   *
   * @param {{ position: object, market: object, newsText: string }} input
   * @returns {Promise<{ ok: boolean, value?: object, issues: string[] }>}
   */
  async function review(input) {
    const prompt = buildMonitorPrompt(input);
    let result;
    try {
      result = await complete(prompt);
    } catch (error) {
      return { ok: false, issues: [error instanceof Error ? error.message : String(error)] };
    }
    return {
      ok: result.parsed.ok,
      value: result.parsed.ok ? result.parsed.value : undefined,
      issues: result.parsed.ok ? [] : result.parsed.issues,
    };
  }

  return { review };
}
