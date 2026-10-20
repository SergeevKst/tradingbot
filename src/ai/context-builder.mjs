/**
 * AI context builder (MASTER_SPEC §37).
 *
 * Assembles the ONLY thing a runtime model is allowed to see: a small,
 * whitelisted view of market, position, portfolio, strategy and risk limits.
 * Every field is copied explicitly, so a credential, an environment variable or
 * an arbitrary file can never ride along by accident.
 *
 * Safety invariants, asserted by tests:
 *   - no `quantity` and no `leverage` are ever copied from a position, so the
 *     model cannot be nudged into sizing advice;
 *   - candle history and order-book depth are capped, bounding prompt size;
 *   - the result is frozen, so a caller cannot mutate what the model will read.
 *
 * @module ai/context-builder
 */
import { ConfigError } from '../config/config-error.mjs';

/** Version of the context shape. Bump when a field is added or removed. */
export const AI_CONTEXT_SCHEMA_VERSION = '1';

/** Hard cap on candles sent to a model. */
export const MAX_CONTEXT_CANDLES = 100;
/** Hard cap on order-book levels per side. */
export const MAX_ORDERBOOK_LEVELS = 10;

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function numberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Copy only the fields a model needs from an open position. `quantity` and
 * `leverage` are deliberately omitted (see the module note).
 *
 * @param {object | null | undefined} position
 */
function sanitizePosition(position) {
  if (position === null || position === undefined || typeof position !== 'object') return null;
  const input = /** @type {Record<string, unknown>} */ (position);
  const symbol = stringOrNull(input.symbol);
  if (symbol === null) return null;
  return Object.freeze({
    symbol,
    side: stringOrNull(input.side),
    entryPrice: numberOrNull(input.entryPrice),
    markPrice: numberOrNull(input.markPrice),
    unrealizedPnlUsd: numberOrNull(input.unrealizedPnlUsd),
    stopLossPrice: numberOrNull(input.stopLossPrice),
    takeProfitPrice: numberOrNull(input.takeProfitPrice),
    status: stringOrNull(input.status),
  });
}

/**
 * @param {object | null | undefined} portfolio
 */
function sanitizePortfolio(portfolio) {
  if (portfolio === null || portfolio === undefined || typeof portfolio !== 'object') return null;
  const input = /** @type {Record<string, unknown>} */ (portfolio);
  const positions = Array.isArray(input.positions) ? input.positions : [];
  return Object.freeze({
    equityUsd: numberOrNull(input.equityUsd),
    availableBalanceUsd: numberOrNull(input.availableBalanceUsd),
    openPositions: positions.length,
  });
}

/**
 * Risk LIMITS are safe to share and keep a model's suggestion inside the
 * envelope the deterministic engine will enforce. Leverage is intentionally not
 * included: it is a sizing control, not analysis input.
 *
 * @param {object | null | undefined} risk
 */
function sanitizeRisk(risk) {
  if (risk === null || risk === undefined || typeof risk !== 'object') return null;
  const input = /** @type {Record<string, unknown>} */ (risk);
  return Object.freeze({
    riskPerTradePct: numberOrNull(input.riskPerTradePct),
    maxDailyLossPct: numberOrNull(input.maxDailyLossPct),
    maxOpenPositions: numberOrNull(input.maxOpenPositions),
    minRiskReward: numberOrNull(input.minRiskReward),
  });
}

/**
 * @param {object | null | undefined} strategy
 */
function sanitizeStrategy(strategy) {
  if (strategy === null || strategy === undefined || typeof strategy !== 'object') return null;
  const input = /** @type {Record<string, unknown>} */ (strategy);
  const id = stringOrNull(input.id);
  if (id === null) return null;
  return Object.freeze({ id, state: stringOrNull(input.state) });
}

/**
 * @param {unknown} candles
 */
function sanitizeCandles(candles) {
  if (!Array.isArray(candles)) return Object.freeze([]);
  return Object.freeze(
    candles.slice(-MAX_CONTEXT_CANDLES).map((raw) => {
      const input = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
      return Object.freeze({
        startTime: numberOrNull(input.startTime),
        open: numberOrNull(input.open),
        high: numberOrNull(input.high),
        low: numberOrNull(input.low),
        close: numberOrNull(input.close),
        volume: numberOrNull(input.volume),
      });
    }),
  );
}

/**
 * @param {unknown} value
 */
function sanitizeLevels(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.slice(0, MAX_ORDERBOOK_LEVELS).map((level) => {
      if (!Array.isArray(level)) return Object.freeze([numberOrNull(level), null]);
      return Object.freeze([numberOrNull(level[0]), numberOrNull(level[1])]);
    }),
  );
}

/**
 * @param {object | null | undefined} orderbook
 */
function sanitizeOrderbook(orderbook) {
  if (orderbook === null || orderbook === undefined || typeof orderbook !== 'object') return null;
  const input = /** @type {Record<string, unknown>} */ (orderbook);
  return Object.freeze({
    bids: sanitizeLevels(input.bids),
    asks: sanitizeLevels(input.asks),
  });
}

/**
 * @param {unknown} value
 */
function sanitizeIndicators(value) {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, number>} */
  const out = {};
  for (const [key, raw] of Object.entries(input)) {
    const parsed = numberOrNull(raw);
    if (parsed !== null) out[key] = parsed;
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : null;
}

/**
 * Build the controlled context a runtime model receives.
 *
 * @param {{
 *   market: object,
 *   position?: object | null,
 *   portfolio?: object | null,
 *   strategy?: object | null,
 *   risk?: object | null,
 *   orderbook?: object | null,
 *   now?: () => number,
 * }} options
 * @returns {Readonly<object>}
 * @throws {ConfigError} when the market snapshot is missing or has no symbol
 */
export function buildAIContext(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('buildAIContext requires an options object', { field: 'options' });
  }
  const market = options.market;
  if (market === null || typeof market !== 'object' || Array.isArray(market)) {
    throw new ConfigError('buildAIContext requires a market snapshot', { field: 'market' });
  }
  const symbol = stringOrNull(/** @type {any} */ (market).symbol);
  if (symbol === null) {
    throw new ConfigError('buildAIContext requires a market snapshot with a symbol', { field: 'market.symbol' });
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const indicators = sanitizeIndicators(/** @type {any} */ (market).indicators);

  return Object.freeze({
    schemaVersion: AI_CONTEXT_SCHEMA_VERSION,
    generatedAt: now(),
    market: Object.freeze({
      symbol,
      timeframe: stringOrNull(/** @type {any} */ (market).candleTimeframe),
      lastPrice: numberOrNull(/** @type {any} */ (market).lastPrice),
      markPrice: numberOrNull(/** @type {any} */ (market).markPrice),
      bid: numberOrNull(/** @type {any} */ (market).bid),
      ask: numberOrNull(/** @type {any} */ (market).ask),
      spread: numberOrNull(/** @type {any} */ (market).spread),
      volume24h: numberOrNull(/** @type {any} */ (market).volume),
      candles: sanitizeCandles(/** @type {any} */ (market).candles),
      indicators,
      orderbook: sanitizeOrderbook(options.orderbook),
    }),
    position: sanitizePosition(options.position),
    portfolio: sanitizePortfolio(options.portfolio),
    strategy: sanitizeStrategy(options.strategy),
    risk: sanitizeRisk(options.risk),
  });
}
