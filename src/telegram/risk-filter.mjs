/**
 * Risk filter (Phase 3) — prompt + schema for DeepSeek "reasoner" guard.
 *
 * The scout (deepseek-chat) proposes ideas; this guard (deepseek-reasoner)
 * adversarially validates each one against the risk rules before anything can
 * be approved or executed. Hard numeric rules are enforced deterministically in
 * `precheckIdea` BEFORE the LLM guard is invoked.
 *
 * Output contract is strict and fail-closed: any unparseable verdict is a
 * REJECT, never a pass. The guard ONLY approves/rejects/annotates — it never
 * sizes, never adjusts the order, never executes.
 *
 * @module telegram/risk-filter
 */

export const RISK_FILTER_PROMPT_VERSION = 'risk-guard-v2';

export const PRECHECK_STOP_RANGE_MULT = 1.5;
export const PRECHECK_MIN_REWARD_RISK = 1.5;
export const PRECHECK_CHASE_PCT = 8;

const MAX_REASON_LENGTH = 800;

/**
 * The system instruction for the risk guard (deepseek-reasoner).
 */
export const GUARD_SYSTEM_PROMPT = Object.freeze(
  [
    'You are a risk guard inside a deterministic trading system. You are adversarial: your job is to REJECT bad trades, not to approve them.',
    'Hard numeric rules (stop width vs volatility, reward/risk >= 1.5, entry near market, anti-chase vs the true 24h range, BTC-cluster direction) are ALREADY enforced by code before you see an idea. Do NOT recompute them. Your job is what code cannot judge: coherence, liquidity and sentiment extremes, chop, and news conflicts.',
    'You receive ONE trade idea {symbol, side, entry, stopLoss, takeProfit}, a market snapshot for THAT symbol (lastPrice, bid, ask, true high24h/low24h, avgRange14h, the last 30 HOURLY candles oldest-first as {o,h,l,c,v}), a precomputed BTC block {lastPrice, ema21h, change4hPct, bias: up|down|flat} and, when available, SENTIMENT (Fear&Greed, funding, 24h turnover, open interest) and NEWS headlines.',
    'Respond with a single JSON object and nothing else:',
    '- verdict: "APPROVED" or "REJECTED"',
    '- confidence: a number in [0, 1]',
    '- reasons: an array of 1..5 short strings (each max ~120 chars)',
    '',
    'REJECT when ANY of these hold:',
    '1. The idea is incoherent with the data: levels named in the rationale do not exist in the candles, or the stop is not beyond the nearest 1h swing (below the swing low for LONG, above the swing high for SHORT).',
    '2. SENTIMENT clearly contradicts the trade: a LONG into extremely crowded-long funding plus Extreme Greed (blow-off top), or a SHORT into extremely crowded-short funding plus Extreme Fear (snap-back squeeze). Discretionary veto — only when unambiguous and extreme; name the numbers.',
    '3. RANGE/CHOP veto: the market oscillates in a narrow band relative to avgRange14h with no trend, so any stop will be whipsawed before the take-profit. You CANNOT adjust prices — in clear chop, REJECT with reason "no tradable trend".',
    '4. NEWS clearly fights the trade: an active bearish catalyst against a LONG or an active bullish one against a SHORT. Name the headline.',
    '',
    'CONFIDENCE = a COMPOSITE score, NOT a price prediction. Start at 0.5. Add up to +0.2 when the setup is clean with margin. Add up to +0.2 when sentiment ALIGNS with the trade (funding not crowded against you, Fear&Greed not extreme, turnover healthy — the move looks LIQUID, not a fake-out). Add up to +0.1 when the news supports the direction. Subtract up to -0.3 when sentiment is ambiguous, the move looks illiquid/overheated, or the market is choppy. Clamp to [0,1]. Never report above 0.85 — reserve headroom for genuine uncertainty. Confidence describes HOW WELL THE SETUP HOLDS UP, not the probability of profit.',
    'Never invent missing data. If a datum is absent, say "unknown" in reasons; do NOT reject for missing sentiment alone. Use the precomputed BTC block as-is — do not compute your own indicators.',
  ].join('\n'),
);

/**
 * Deterministic hard-rule precheck for one scout idea against the market
 * context. Runs BEFORE the LLM guard: a failed idea never reaches (or pays
 * for) the reasoner call. Fail-closed: missing market data = not pass.
 *
 * @param {Record<string, any>} idea  valid idea from the scout stage
 * @param {{ symbols?: Array<Record<string, any>>, btc?: Record<string, any> | null }} context
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function precheckIdea(idea, context) {
  const symbols = Array.isArray(context?.symbols) ? context.symbols : [];
  const snap = symbols.find((s) => s && s.symbol === idea.symbol) ?? null;
  if (!snap) {
    return { pass: false, reasons: [`precheck: no market data for ${idea.symbol}`] };
  }
  const reasons = [];

  // 1. Stop width vs the shared volatility unit (skipped when unit absent).
  const ar = snap.avgRange14h;
  if (typeof ar === 'number' && Number.isFinite(ar) && ar > 0) {
    const stopDist = Math.abs(idea.entry - idea.stopLoss);
    // Boundary must pass; tiny relative epsilon absorbs float noise (as in S-3).
    if (stopDist < PRECHECK_STOP_RANGE_MULT * ar * (1 - 1e-9)) {
      reasons.push(`precheck: stop distance ${stopDist} < ${PRECHECK_STOP_RANGE_MULT}x avgRange14h (${ar})`);
    }
  }

  // 2. Reward/risk (second layer after scout S-3 — defense in depth).
  const risk = Math.abs(idea.entry - idea.stopLoss);
  const reward = Math.abs(idea.takeProfit - idea.entry);
  // Boundary must pass; tiny relative epsilon absorbs float noise (see ideas.mjs S-3).
  if (risk > 0 && reward < PRECHECK_MIN_REWARD_RISK * risk * (1 - 1e-9)) {
    reasons.push(`precheck: reward/risk ${(reward / risk).toFixed(2)} < ${PRECHECK_MIN_REWARD_RISK}`);
  }

  // 3. Anti-chase vs the TRUE 24h range (meaningful only after S-2).
  if (idea.side === 'LONG' && typeof snap.low24h === 'number' && snap.low24h > 0) {
    const above = ((idea.entry - snap.low24h) / snap.low24h) * 100;
    if (above > PRECHECK_CHASE_PCT) {
      reasons.push(`precheck: LONG entry ${above.toFixed(1)}% above 24h low (max ${PRECHECK_CHASE_PCT}%)`);
    }
  }
  if (idea.side === 'SHORT' && typeof snap.high24h === 'number' && snap.high24h > 0) {
    const below = ((snap.high24h - idea.entry) / snap.high24h) * 100;
    if (below > PRECHECK_CHASE_PCT) {
      reasons.push(`precheck: SHORT entry ${below.toFixed(1)}% below 24h high (max ${PRECHECK_CHASE_PCT}%)`);
    }
  }

  // 4. BTC-cluster direction (precomputed in G-2; skip BTC itself and flat/unknown).
  const bias = context?.btc?.bias;
  if (idea.symbol !== 'BTCUSDT' && (bias === 'up' || bias === 'down')) {
    if (bias === 'down' && idea.side === 'LONG') reasons.push('precheck: alt LONG against BTC bias=down');
    if (bias === 'up' && idea.side === 'SHORT') reasons.push('precheck: alt SHORT against BTC bias=up');
  }

  return { pass: reasons.length === 0, reasons };
}

/**
 * Decide whether an unattended auto-entry is still valid at the live price.
 * Mirrors the manual approve-flow thresholds (loadApproveThresholds).
 *
 * @param {{ idea: Record<string, any>, live: number, slippagePct: number, refreshPct: number }} input
 * @returns {{ skip: boolean, reason: string }}
 */
export function shouldSkipAutoEntry({ idea, live, slippagePct, refreshPct }) {
  if (!Number.isFinite(live) || live <= 0) return { skip: true, reason: 'no live price' };
  const diffPct = (Math.abs(live - idea.entry) / idea.entry) * 100;
  if (diffPct > refreshPct) return { skip: true, reason: `price drifted ${diffPct.toFixed(2)}% (> ${refreshPct}%)` };
  const sane = idea.side === 'LONG'
    ? live > idea.stopLoss && live < idea.takeProfit
    : live < idea.stopLoss && live > idea.takeProfit;
  if (!sane) return { skip: true, reason: 'live price already beyond SL/TP of the idea' };
  return { skip: false, reason: `drift ${diffPct.toFixed(2)}% ok` };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: object } | { ok: false, issues: string[] }}
 */
export function parseGuardResponse(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, issues: ['guard response is not valid JSON'] };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, issues: ['guard response must be a JSON object'] };
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);

  const issues = [];
  if (obj.verdict !== 'APPROVED' && obj.verdict !== 'REJECTED') {
    issues.push('verdict must be APPROVED or REJECTED');
  }
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) {
    issues.push('confidence must be a number in [0,1]');
  }
  if (
    !Array.isArray(obj.reasons)
    || obj.reasons.length === 0
    || obj.reasons.length > 5
    || obj.reasons.some((r) => typeof r !== 'string' || r.trim() === '' || r.trim().length > MAX_REASON_LENGTH)
  ) {
    issues.push('reasons must be 1..5 non-empty strings, each <= 800 chars');
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: Object.freeze({
      verdict: /** @type {'APPROVED' | 'REJECTED'} */ (obj.verdict),
      confidence: /** @type {number} */ (obj.confidence),
      reasons: Object.freeze((/** @type {string[]} */ (obj.reasons)).map((r) => r.trim())),
    }),
  };
}

/**
 * Build the guard prompt for one idea.
 *
 * @param {{ idea: object, market: object, sentiment?: string, news?: string }} input
 * @returns {{ version: string, system: string, user: string }}
 */
export function buildGuardPrompt({ idea, market, sentiment, news }) {
  // CACHE-FRIENDLY LAYOUT (do not reorder without reason).
  //
  // DeepSeek's prompt cache matches on an exact PREFIX and a hit costs roughly
  // 50x less than a miss. The guard runs once per idea in a scan cycle (up to 15
  // in parallel). Within one cycle the SHARED parts are: the BTC cluster block
  // and the news headlines. The PER-IDEA parts are: the idea, its own symbol
  // snapshot, and its sentiment line.
  //
  // So: everything shared goes first, everything idea-specific goes last. Any
  // unique byte at the front of the user message makes the whole call a miss.
  const shared = JSON.stringify({
    btc: market?.btc ?? null,
    news: news || null,
  });
  const specific = JSON.stringify({
    sentiment: sentiment || null,
    market: { symbol: market?.symbol ?? null },
    idea,
  });
  return {
    version: RISK_FILTER_PROMPT_VERSION,
    system: GUARD_SYSTEM_PROMPT,
    user: `SHARED CONTEXT:\n${shared}\n\nIDEA TO VALIDATE:\n${specific}`,
  };
}
