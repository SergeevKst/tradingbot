/**
 * Stop-check decision (fast loss/trend guard).
 *
 * A tighter, more frequent check than the main 15-minute monitor. It evaluates
 * each open position purely through the lens of "is this objectively losing or
 * turning losing, and do news/trend warrant closing it now?" It runs every few
 * minutes in the background AND on demand via /stopcheck.
 *
 * Auto-close ONLY when code (meaningful loss + trend against) and the model
 * (CLOSE) agree; everything else is proposed via buttons.
 *
 * @module telegram/stopcheck
 */

export const STOPCHECK_PROMPT_VERSION = 'stopcheck-v2';

export const STOPCHECK_SYSTEM_PROMPT = [
  'You are a fast loss-protection reviewer inside a deterministic trading system. Code has already detected a position in meaningful loss; you decide whether the loss is likely to grow (CLOSE) or is normal volatility inside the prevailing trend (HOLD). You never touch prices.',
  'Respond with ONLY a JSON object: {"action":"CLOSE"|"HOLD","reason":"one short concrete sentence","confidence":0..1}',
  'You receive: the position {symbol, side, avgPrice, markPrice, stopLoss, takeProfit, unrealisedPnl, leverage, kind}, the last 30 HOURLY candles of that symbol (oldest first, {o,h,l,c,v}), atr14h, a precomputed trend block {ema21h, change4hPct, bias}, a precomputed BTC block {bias}, and news headlines.',
  'Decide CLOSE when the evidence says the move AGAINST the position continues:',
  '- the precomputed trend bias is against the position AND the candles confirm (broken swing, momentum continuation), or',
  '- adverse news plausibly extends the move against the position — name the headline.',
  'For alt positions, weigh the BTC block explicitly: an alt LONG with BTC bias=down is at risk; an alt SHORT with BTC bias=up is at risk. Name the BTC bias in your reason.',
  'Decide HOLD when the loss looks like normal noise inside the prevailing trend: the trend block is not against the position, price still respects the key swing, no adverse news.',
  'confidence: how sure you are (0.5 = coin flip, 0.9 = unambiguous). It is logged for review only.',
  'Use ONLY the data provided. If data/news is insufficient, HOLD and say so.',
].join('\n');

/**
 * Pure gate: the LLM is consulted ONLY when the loss is already meaningful.
 * Healthy positions cost zero LLM tokens per tick.
 *
 * @param {{ lossMeaningful: boolean }} input
 * @returns {boolean}
 */
export function shouldConsultStopcheck({ lossMeaningful }) {
  return lossMeaningful === true;
}

/**
 * True when the precomputed trend bias points against the position side.
 *
 * @param {'LONG' | 'SHORT'} side
 * @param {'up' | 'down' | 'flat' | null | undefined} bias
 * @returns {boolean}
 */
export function isTrendAgainst(side, bias) {
  return (side === 'LONG' && bias === 'down') || (side === 'SHORT' && bias === 'up');
}

/**
 * Final stop-check decision. AUTO_CLOSE requires agreement of code AND model:
 * meaningful loss (code) + trend against (code) + model votes CLOSE (advisory).
 * Any other CLOSE is only proposed to the human.
 *
 * @param {{ llmAction: 'CLOSE' | 'HOLD', lossMeaningful: boolean, trendAgainst: boolean }} input
 * @returns {'AUTO_CLOSE' | 'PROPOSE_CLOSE' | 'HOLD'}
 */
export function decideStopcheckAction({ llmAction, lossMeaningful, trendAgainst }) {
  if (llmAction === 'CLOSE') {
    if (lossMeaningful && trendAgainst) return 'AUTO_CLOSE';
    return 'PROPOSE_CLOSE';
  }
  return 'HOLD';
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: { action: 'CLOSE'|'HOLD', reason: string, confidence: number } } | { ok: false, issues: string[] }}
 */
export function parseStopcheckResponse(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return { ok: false, issues: ['stopcheck response is not valid JSON'] }; }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, issues: ['stopcheck response must be a JSON object'] };
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  const issues = [];
  if (obj.action !== 'CLOSE' && obj.action !== 'HOLD') issues.push('action must be CLOSE or HOLD');
  if (typeof obj.reason !== 'string' || obj.reason.trim() === '') issues.push('reason must be a non-empty string');
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) issues.push('confidence must be a number in [0,1]');
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: Object.freeze({
      action: /** @type {'CLOSE' | 'HOLD'} */ (obj.action),
      reason: /** @type {string} */ (obj.reason.trim()),
      confidence: /** @type {number} */ (obj.confidence),
    }),
  };
}

/**
 * @param {{ position: object, market: object, newsText: string }} input
 * @returns {{ version: string, system: string, user: string }}
 */
export function buildStopcheckPrompt({ position, market, newsText }) {
  // Cache-friendly layout: shared NEWS first, per-position payload last — the
  // stop-check runs every few minutes over the same set of positions, so a
  // stable prefix earns real cache hits.
  const shared = JSON.stringify({ news: newsText || '(no news available)' });
  const specific = JSON.stringify({ position, market });
  return {
    version: STOPCHECK_PROMPT_VERSION,
    system: STOPCHECK_SYSTEM_PROMPT,
    user: `NEWS:\n${shared}\n\nPOSITION:\n${specific}`,
  };
}
