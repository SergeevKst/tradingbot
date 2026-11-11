/**
 * PaperDecisionSink — the AI → PAPER bridge (blockers B3/B5 of
 * `docs/paper-readiness/AI_PIPELINE_READINESS.md`).
 *
 * An AI analysis is *advisory*: a `BULLISH`/`BEARISH` bias with a confidence. It
 * carries no quantity, no leverage and no order. This module is the one place
 * that turns such a bias into a *proposal* and hands it to the PAPER session,
 * and it does so without ever touching an exchange:
 *
 *   AIAnalysis → deterministic price geometry → PaperSession.submit()
 *                                                     ↓
 *                                          deterministic Risk Engine
 *                                                     ↓
 *                                            virtual PAPER fill
 *
 * SAFETY PROPERTIES (asserted by tests):
 *   - PAPER only. The module imports the paper session by injection and no
 *     exchange, order or signing module at all, so an AI decision has no path to
 *     a real order;
 *   - the model never sizes: `quantity`/`leverage` are not in the proposal;
 *     stop distance is a deterministic function of the market snapshot (ATR when
 *     present, a bounded fraction of price otherwise);
 *   - disabled by default (`enabled: false`) and additionally bounded by a
 *     per-hour decision budget and a duplicate-decision window;
 *   - stale market data never trades (B5). The gate sits here, at the loop
 *     boundary, because the PAPER session deliberately does not own staleness;
 *   - an unusable outcome (`ok: false`), a `NEUTRAL` bias or a confidence below
 *     the configured floor is NO TRADE — the sink never invents a proposal.
 *
 * @module ai/paper-decision-sink
 */
import { ConfigError } from '../config/config-error.mjs';
import { silentLogger } from '../util/logger.mjs';

/** Reason codes owned by the sink (the Risk Engine owns its own). */
export const SINK_REASON = Object.freeze({
  DISABLED: 'SINK_DISABLED',
  AI_OUTCOME_UNAVAILABLE: 'AI_OUTCOME_UNAVAILABLE',
  AI_NEUTRAL: 'AI_NEUTRAL',
  AI_CONFIDENCE_BELOW_FLOOR: 'AI_CONFIDENCE_BELOW_FLOOR',
  STALE_MARKET: 'STALE_MARKET',
  MARKET_UNAVAILABLE: 'MARKET_UNAVAILABLE',
  DUPLICATE_DECISION: 'DUPLICATE_DECISION',
  BUDGET_EXHAUSTED: 'SINK_BUDGET_EXHAUSTED',
  INVALID_INPUT: 'SINK_INVALID_INPUT',
});

const DEFAULTS = Object.freeze({
  enabled: false,
  stalenessMs: 60000,
  dedupeWindowMs: 300000,
  maxDecisionsPerHour: 6,
  minConfidence: 0.55,
  riskReward: 2,
  minStopDistanceFraction: 0.002,
  maxStopDistanceFraction: 0.02,
  fallbackStopDistanceFraction: 0.005,
});

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} field
 * @returns {number}
 */
function positiveNumber(value, fallback, field) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value) || /** @type {number} */ (value) <= 0) {
    throw new ConfigError(`${field} must be a positive finite number`, { field, value });
  }
  return /** @type {number} */ (value);
}

/**
 * Deterministic stop distance for a decision.
 *
 * When the snapshot carries an ATR the distance is `atrMultiple * ATR`, clamped
 * to a sane fraction of price so a bad indicator value cannot produce a hair-thin
 * or absurd stop. Without ATR the configured fallback fraction is used. The model
 * has no say in this number.
 *
 * @param {any} market
 * @param {{ minStopDistanceFraction: number, maxStopDistanceFraction: number, fallbackStopDistanceFraction: number, atrMultiple?: number }} policy
 * @returns {number | null} distance in price units, or null when no price exists
 */
export function computeStopDistance(market, policy) {
  const price = Number(market?.lastPrice ?? market?.markPrice ?? market?.close);
  if (!Number.isFinite(price) || price <= 0) return null;
  const atr = Number(market?.indicators?.atr);
  const atrMultiple = Number.isFinite(policy.atrMultiple) ? policy.atrMultiple : 1.5;
  const fraction = Number.isFinite(atr) && atr > 0
    ? (atr * atrMultiple) / price
    : policy.fallbackStopDistanceFraction;
  const clamped = Math.min(policy.maxStopDistanceFraction, Math.max(policy.minStopDistanceFraction, fraction));
  return price * clamped;
}

/**
 * Build a side-aware, model-independent proposal from an analysis bias.
 *
 * @param {{ analysis: any, market: any, price: number, stopDistance: number, riskReward: number, strategyId: string }} input
 * @returns {Readonly<object>}
 */
export function buildProposalFromAnalysis(input) {
  const { analysis, price, stopDistance, riskReward, strategyId, market } = input;
  const side = analysis.bias === 'BULLISH' ? 'LONG' : 'SHORT';
  const direction = side === 'LONG' ? 1 : -1;
  const stopLossPrice = price - direction * stopDistance;
  const takeProfitPrice = price + direction * stopDistance * riskReward;
  return Object.freeze({
    symbol: market.symbol,
    side,
    entryPrice: price,
    stopLossPrice,
    takeProfitPrice,
    strategyId,
    // Confidence is metadata for the journal only; the Risk Engine never sizes
    // from it (`calculatePositionSize` has no confidence input at all).
    confidence: analysis.confidence,
    timestamp: analysis.generatedAt,
  });
}

/**
 * @typedef {object} PaperDecisionSinkOptions
 * @property {{ submit: (input: object) => Promise<object> }} paperSession PAPER session (never a live adapter)
 * @property {boolean} [enabled] default false — production AI dispatch is opt-in
 * @property {number} [stalenessMs]
 * @property {number} [dedupeWindowMs]
 * @property {number} [maxDecisionsPerHour]
 * @property {number} [minConfidence]
 * @property {number} [riskReward]
 * @property {string} [strategyId]
 * @property {() => number} [clock]
 * @property {(event: object) => void} [audit]
 * @property {object} [logger]
 */

/**
 * @param {PaperDecisionSinkOptions} options
 */
export function createPaperDecisionSink(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createPaperDecisionSink requires an options object');
  }
  const paperSession = options.paperSession;
  if (paperSession === null || typeof paperSession !== 'object' || typeof paperSession.submit !== 'function') {
    throw new ConfigError('paper decision sink requires a PAPER session with submit()', { field: 'paperSession' });
  }
  const enabled = options.enabled === undefined ? DEFAULTS.enabled : options.enabled;
  if (typeof enabled !== 'boolean') {
    throw new ConfigError('paper decision sink enabled must be a boolean', { field: 'enabled' });
  }
  const stalenessMs = positiveNumber(options.stalenessMs, DEFAULTS.stalenessMs, 'stalenessMs');
  const dedupeWindowMs = positiveNumber(options.dedupeWindowMs, DEFAULTS.dedupeWindowMs, 'dedupeWindowMs');
  const maxDecisionsPerHour = positiveNumber(
    options.maxDecisionsPerHour,
    DEFAULTS.maxDecisionsPerHour,
    'maxDecisionsPerHour',
  );
  const riskReward = positiveNumber(options.riskReward, DEFAULTS.riskReward, 'riskReward');
  const minConfidence = options.minConfidence === undefined ? DEFAULTS.minConfidence : options.minConfidence;
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new ConfigError('minConfidence must be a number in [0, 1]', { field: 'minConfidence', value: minConfidence });
  }
  const policy = Object.freeze({
    minStopDistanceFraction: positiveNumber(
      options.minStopDistanceFraction,
      DEFAULTS.minStopDistanceFraction,
      'minStopDistanceFraction',
    ),
    maxStopDistanceFraction: positiveNumber(
      options.maxStopDistanceFraction,
      DEFAULTS.maxStopDistanceFraction,
      'maxStopDistanceFraction',
    ),
    fallbackStopDistanceFraction: positiveNumber(
      options.fallbackStopDistanceFraction,
      DEFAULTS.fallbackStopDistanceFraction,
      'fallbackStopDistanceFraction',
    ),
    atrMultiple: options.atrMultiple,
  });
  const strategyId = typeof options.strategyId === 'string' && options.strategyId.trim() !== ''
    ? options.strategyId.trim()
    : 'ai-codex-analysis';
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const logger = options.logger ?? silentLogger;
  const audit = typeof options.audit === 'function' ? options.audit : null;

  /** @type {number[]} timestamps of decisions actually submitted */
  const submittedAt = [];
  /** @type {Map<string, number>} decision key → submission timestamp */
  const lastKeyAt = new Map();

  /**
   * @param {object} event
   */
  function record(event) {
    const entry = Object.freeze({ at: clock(), ...event });
    if (audit !== null) {
      try {
        audit(entry);
      } catch {
        // An audit sink must never be able to change a trading decision.
      }
    }
    return entry;
  }

  /** @param {string} reasonCode @param {object} [extra] */
  function refuse(reasonCode, extra = {}) {
    logger.info('paper decision sink refused', { reasonCode, ...extra });
    record({ event: 'AI_PAPER_DECISION_REFUSED', reasonCode, ...extra });
    return Object.freeze({ submitted: false, reasonCode, proposal: null, riskOutcome: null, ...extra });
  }

  /**
   * Consume one validated analysis outcome and, when everything is admissible,
   * submit the derived proposal to the PAPER session.
   *
   * @param {{ outcome: any, market: any }} input
   * @returns {Promise<Readonly<object>>}
   */
  async function applyAnalysis(input) {
    if (!enabled) return refuse(SINK_REASON.DISABLED);
    if (input === null || typeof input !== 'object' || !input.outcome || !input.market) {
      return refuse(SINK_REASON.INVALID_INPUT);
    }
    const { outcome, market } = input;

    const analysis = outcome?.analysis ?? null;
    if (outcome.ok !== true || analysis === null || typeof analysis !== 'object') {
      return refuse(SINK_REASON.AI_OUTCOME_UNAVAILABLE, { issues: Array.isArray(outcome?.issues) ? outcome.issues : [] });
    }
    if (analysis.symbol !== market.symbol) {
      // A decision about another instrument must never trade this one.
      return refuse(SINK_REASON.INVALID_INPUT, { symbol: market.symbol, analysisSymbol: analysis.symbol });
    }
    if (analysis.bias !== 'BULLISH' && analysis.bias !== 'BEARISH') {
      return refuse(SINK_REASON.AI_NEUTRAL, { bias: analysis.bias ?? null });
    }
    if (!(Number(analysis.confidence) >= minConfidence)) {
      return refuse(SINK_REASON.AI_CONFIDENCE_BELOW_FLOOR, {
        confidence: analysis.confidence ?? null,
        minConfidence,
      });
    }

    // B5 — the loop, not the PAPER session, owns the freshness gate.
    const marketTs = Date.parse(String(market.timestamp ?? ''));
    if (!Number.isFinite(marketTs)) return refuse(SINK_REASON.MARKET_UNAVAILABLE, { symbol: market.symbol });
    const ageMs = clock() - marketTs;
    if (ageMs > stalenessMs) {
      return refuse(SINK_REASON.STALE_MARKET, { ageMs: Math.round(ageMs), stalenessMs });
    }

    const price = Number(market.lastPrice ?? market.markPrice);
    if (!Number.isFinite(price) || price <= 0) {
      return refuse(SINK_REASON.MARKET_UNAVAILABLE, { symbol: market.symbol });
    }
    const stopDistance = computeStopDistance(market, policy);
    if (stopDistance === null || stopDistance <= 0) {
      return refuse(SINK_REASON.MARKET_UNAVAILABLE, { symbol: market.symbol });
    }

    const nowMs = clock();
    const windowStart = nowMs - 3600000;
    while (submittedAt.length > 0 && submittedAt[0] <= windowStart) submittedAt.shift();
    if (submittedAt.length >= maxDecisionsPerHour) {
      return refuse(SINK_REASON.BUDGET_EXHAUSTED, { maxDecisionsPerHour });
    }

    // Duplicate suppression: the same instrument, bias and time bucket must not
    // produce two decisions, whatever a retrying loop or a replayed outcome says.
    const bucket = Math.floor(Number(analysis.generatedAt) / dedupeWindowMs);
    const key = `${analysis.symbol}:${analysis.bias}:${bucket}`;
    const previous = lastKeyAt.get(key);
    if (previous !== undefined && nowMs - previous < dedupeWindowMs) {
      return refuse(SINK_REASON.DUPLICATE_DECISION, { key, symbol: analysis.symbol, bias: analysis.bias });
    }

    const proposal = buildProposalFromAnalysis({
      analysis,
      market,
      price,
      stopDistance,
      riskReward,
      strategyId,
    });

    record({
      event: 'AI_PAPER_PROPOSAL',
      symbol: proposal.symbol,
      side: proposal.side,
      bias: analysis.bias,
      confidence: analysis.confidence,
      modelId: analysis.modelId ?? null,
      promptVersion: outcome?.promptVersion ?? null,
      stopDistanceFraction: stopDistance / price,
    });

    /** @type {any} */
    let riskOutcome;
    try {
      riskOutcome = await paperSession.submit({ proposal, market });
    } catch (error) {
      // Fail closed: a throwing session is a refusal, never a silent pass.
      record({
        event: 'AI_PAPER_SUBMIT_FAILED',
        symbol: proposal.symbol,
        error: error instanceof Error ? error.message : String(error),
      });
      return Object.freeze({
        submitted: false,
        reasonCode: 'INTERNAL_ERROR',
        proposal,
        riskOutcome: null,
      });
    }

    submittedAt.push(nowMs);
    lastKeyAt.set(key, nowMs);
    // Keep the dedupe map from growing without bound in a long-running loop.
    if (lastKeyAt.size > 256) {
      for (const [entryKey, at] of lastKeyAt) {
        if (nowMs - at >= dedupeWindowMs) lastKeyAt.delete(entryKey);
      }
    }

    const reasonCode = riskOutcome?.reasonCode ?? 'UNKNOWN';
    record({
      event: 'AI_PAPER_DECISION',
      symbol: proposal.symbol,
      side: proposal.side,
      approved: riskOutcome?.approved === true,
      executed: riskOutcome?.executed === true,
      reasonCode,
    });

    return Object.freeze({
      submitted: true,
      reasonCode,
      proposal,
      riskOutcome,
    });
  }

  return Object.freeze({
    applyAnalysis,
    enabled: () => enabled,
    stats: () =>
      Object.freeze({
        submittedInWindow: submittedAt.length,
        maxDecisionsPerHour,
        trackedDecisionKeys: lastKeyAt.size,
      }),
  });
}
