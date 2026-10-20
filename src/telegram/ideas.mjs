/**
 * Trade-idea generation (Phase 2) — prompt + schema for DeepSeek "scout".
 *
 * The scout PROPOSES ideas with a permissive, clear prompt; the strict risk
 * filtering happens separately in `risk-filter.mjs` (the guard). This separation
 * fixes a real failure mode: an over-strict scout returns `{"ideas":[]}` for
 * every market, which is indistinguishable from "the model never ran".
 *
 * The scout must ALWAYS try to propose something when the market is tradeable;
 * the guard then rejects the bad ones. Output is still validated fail-closed,
 * and the model never sizes positions.
 *
 * @module telegram/ideas
 */

export const IDEAS_PROMPT_VERSION = 'scout-ideas-v4';

export const MAX_IDEAS = 15;

export const ALLOWED_SIDES = Object.freeze(['LONG', 'SHORT']);

export const ENTRY_MAX_DEVIATION_PCT = 1.5;
export const STOP_MIN_RANGE_MULT = 1.5;
export const MIN_REWARD_RISK = 1.5;

const MAX_RATIONALE_LENGTH = 600;

/**
 * A concise, example-anchored system prompt. English is used deliberately:
 * deepseek-chat is markedly more reliable producing structured JSON from a
 * compact English instruction than from a long multilingual rule list.
 */
export const SCOUT_SYSTEM_PROMPT = Object.freeze(
  [
    'You are a crypto trade scout inside a deterministic trading system. You propose short-horizon (1h–12h) trade ideas from the market data you are given. Code validates your numbers; a separate risk guard re-validates each idea.',
    'Respond with ONLY a JSON object of this exact shape (no prose, no fences):',
    '{"ideas":[{"symbol":"BTCUSDT","side":"LONG","entry":82800,"stopLoss":81000,"takeProfit":86200,"rationale":"short reason"}]}',
    '',
    'DATA YOU RECEIVE (one entry per symbol in "symbols"):',
    '- lastPrice, bid, ask: current top of book.',
    '- high24h / low24h: the TRUE 24-hour high/low.',
    '- avgRange14h: average (high - low) of the last 14 HOURLY candles. Use it as the volatility unit.',
    '- candles: the last 30 HOURLY candles, OLDEST FIRST, each {o,h,l,c,v}, without timestamps.',
    '- "news" (optional): Fear & Greed reading and recent headlines.',
    '- "openPositions" (optional): array of currently open positions, each {symbol, side}.',
    '',
    'Field rules:',
    '- symbol: exactly one of the symbols in the data — never any other ticker.',
    '- side: "LONG" or "SHORT".',
    '- entry: a limit entry within ~1% of lastPrice. Not a chase, not a deep pullback order.',
    '- stopLoss: at least 1.5 x avgRange14h away from entry, AND beyond the nearest 1h swing (below the swing low for LONG, above the swing high for SHORT).',
    '- takeProfit: at least 1.5x further from entry than stopLoss is (reward/risk >= 1.5). Code numerically discards ideas that fail this.',
    '- rationale: one short concrete sentence naming the level, volatility or trend you used.',
    '- Do NOT emit quantity, position size, leverage, dollars or risk percent.',
    '',
    'SELECTIVITY (important):',
    '- Propose AT MOST 5 ideas — the cleanest setups only, at most one per symbol.',
    '- Never propose an idea on a symbol that already has an open position, and do not pick a direction that fights your existing correlated exposure (see "openPositions").',
    '- 0 to 2 ideas is a normal, healthy output. An idea for every symbol means you are forcing setups; do not do that.',
    '- If you genuinely see no tradeable setup, return {"ideas":[]}.',
    '',
    'CORRELATION RULE: most altcoins move with BTC over this horizon. Do NOT propose simultaneous opposing trades on correlated assets unless their 1h paths have clearly diverged in the data you see. If BTC is trending up, the default bias for correlated alts is LONG; if down, SHORT. Only a coin with an independent, coin-specific driver (unique news, aggressive funding, clear divergence in the candles) may carry the opposite side.',
    '',
    'NEWS RULE: use "news" as a bias filter: do NOT propose SHORT into a coin with an active bullish catalyst (ETF inflows, adoption, upgrades, favorable regulation), and do NOT propose LONG into a coin with an active bearish catalyst (hacks, bans, delistings, lawsuits). If news and technicals conflict, skip the idea or state the conflict in the rationale.',
    '',
    'Use ONLY the numbers present in the data. Never invent prices, levels, funding rates or news.',
  ].join('\n'),
);

/**
 * Validate one idea object. Returns a list of issues; empty list = valid.
 *
 * @param {unknown} raw
 * @param {number} index
 * @returns {string[]}
 */
function ideaIssues(raw, index) {
  const at = `ideas[${index}]`;
  const issues = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`${at} must be an object`];
  }
  const idea = /** @type {Record<string, unknown>} */ (raw);

  for (const key of Object.keys(idea)) {
    if (!['symbol', 'side', 'entry', 'stopLoss', 'takeProfit', 'rationale'].includes(key)) {
      issues.push(`${at}.${key} is not an allowed field`);
    }
  }
  if (typeof idea.symbol !== 'string' || idea.symbol.trim() === '') {
    issues.push(`${at}.symbol must be a non-empty string`);
  }
  if (!ALLOWED_SIDES.includes(/** @type {string} */ (idea.side))) {
    issues.push(`${at}.side must be LONG or SHORT`);
  }
  for (const field of ['entry', 'stopLoss', 'takeProfit']) {
    const v = idea[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      issues.push(`${at}.${field} must be a positive finite number`);
    }
  }
  if (typeof idea.entry === 'number' && typeof idea.stopLoss === 'number' && typeof idea.takeProfit === 'number') {
    const { side, entry, stopLoss, takeProfit } = /** @type {any} */ (idea);
    if (side === 'LONG' && !(stopLoss < entry && takeProfit > entry)) {
      issues.push(`${at}: LONG requires stopLoss < entry < takeProfit`);
    }
    if (side === 'SHORT' && !(stopLoss > entry && takeProfit < entry)) {
      issues.push(`${at}: SHORT requires stopLoss > entry > takeProfit`);
    }
    const risk = Math.abs(entry - stopLoss);
    const reward = Math.abs(takeProfit - entry);
    // Boundary must pass (R/R == 1.5 is valid); the tiny relative epsilon
    // absorbs float noise like 2.55/1.70 = 1.4999… in binary arithmetic.
    if (risk > 0 && reward < MIN_REWARD_RISK * risk * (1 - 1e-9)) {
      issues.push(`${at}: reward/risk must be >= ${MIN_REWARD_RISK} (got ${(reward / risk).toFixed(2)})`);
    }
  }
  if (typeof idea.rationale !== 'string' || idea.rationale.trim() === '') {
    issues.push(`${at}.rationale must be a non-empty string`);
  } else if (idea.rationale.trim().length > MAX_RATIONALE_LENGTH) {
    issues.push(`${at}.rationale must be at most ${MAX_RATIONALE_LENGTH} chars`);
  }
  return issues;
}

/**
 * Market-aware validation of parsed scout ideas.
 * Drops ideas that reference unknown symbols, already-open symbols, or violate
 * numeric sanity against the actual market snapshot. Fail-closed per idea.
 *
 * @param {ReadonlyArray<Record<string, any>>} ideas  valid ideas from parseScoutResponse
 * @param {{ symbols?: Array<Record<string, any>>, openPositions?: Array<Record<string, any>> }} market  the SAME context object sent to the model
 * @returns {{ ideas: ReadonlyArray<object>, issues: string[] }}
 */
export function validateIdeasWithMarket(ideas, market) {
  const symbols = Array.isArray(market?.symbols) ? market.symbols : [];
  const bySymbol = new Map();
  for (const s of symbols) {
    if (s && typeof s.symbol === 'string') bySymbol.set(s.symbol, s);
  }
  const open = Array.isArray(market?.openPositions) ? market.openPositions : [];
  const kept = [];
  const issues = [];
  ideas.forEach((idea, index) => {
    const at = `ideas[${index}]`;
    const snap = bySymbol.get(idea.symbol);
    if (!snap) {
      issues.push(`${at}.symbol ${JSON.stringify(idea.symbol)} is not in the market context`);
      return;
    }
    if (open.some((p) => p && p.symbol === idea.symbol)) {
      issues.push(`${at}.symbol ${JSON.stringify(idea.symbol)} already has an open position`);
      return;
    }
    const last = snap.lastPrice;
    if (typeof last === 'number' && Number.isFinite(last) && last > 0) {
      const devPct = (Math.abs(idea.entry - last) / last) * 100;
      if (devPct > ENTRY_MAX_DEVIATION_PCT) {
        issues.push(`${at}.entry deviates ${devPct.toFixed(2)}% from lastPrice (max ${ENTRY_MAX_DEVIATION_PCT}%)`);
        return;
      }
    }
    const ar = snap.avgRange14h;
    if (typeof ar === 'number' && Number.isFinite(ar) && ar > 0) {
      const stopDist = Math.abs(idea.entry - idea.stopLoss);
      // Boundary must pass; tiny relative epsilon absorbs float noise (as in S-3).
      if (stopDist < STOP_MIN_RANGE_MULT * ar * (1 - 1e-9)) {
        issues.push(`${at}.stopLoss distance ${stopDist} < ${STOP_MIN_RANGE_MULT}x avgRange14h (${ar})`);
        return;
      }
    }
    kept.push(idea);
  });
  return { ideas: Object.freeze(kept), issues };
}

/**
 * Parse + validate a scout response. Valid ideas kept; invalid dropped.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, ideas: ReadonlyArray<object>, issues: string[] } | { ok: false, issues: string[] }}
 */
export function parseScoutResponse(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, issues: ['scout response is not valid JSON'] };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, issues: ['scout response must be a JSON object'] };
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  if (!Array.isArray(obj.ideas)) {
    return { ok: false, issues: ['scout response must contain an "ideas" array'] };
  }

  const valid = [];
  const allIssues = [];
  obj.ideas.slice(0, MAX_IDEAS).forEach((idea, index) => {
    const issues = ideaIssues(idea, index);
    if (issues.length === 0) valid.push(Object.freeze(idea));
    else allIssues.push(...issues);
  });
  return { ok: true, ideas: Object.freeze(valid), issues: allIssues };
}

/**
 * Build the scout prompt from market context.
 *
 * @param {object} context
 * @returns {{ version: string, system: string, user: string }}
 */
export function buildScoutPrompt(context) {
  const slimSymbols = Array.isArray(context?.symbols)
    ? context.symbols.map(({ instrument, ...rest }) => rest)
    : context?.symbols;
  // Cache-friendly layout: the large static-ish NEWS block goes first and the
  // (price-bearing, therefore always-changing) symbol data last. DeepSeek's
  // prompt cache matches on an exact prefix, and `generatedAt` used to be
  // written before the news — a timestamp near the front of the prompt makes
  // every single call a guaranteed cache miss.
  const { news, generatedAt, ...rest } = context ?? {};
  const head = JSON.stringify({ news: news ?? null });
  const tail = JSON.stringify({ ...rest, symbols: slimSymbols, generatedAt });
  return {
    version: IDEAS_PROMPT_VERSION,
    system: SCOUT_SYSTEM_PROMPT,
    user: `NEWS:\n${head}\n\nMARKET:\n${tail}`,
  };
}
