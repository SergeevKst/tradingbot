/**
 * Strategy contract and MarketContext.
 *
 * A strategy is a pure, deterministic function from a MarketContext to a
 * TradeProposal or `null` ("no signal"). It never calls an exchange, never
 * reads credentials and never sizes a position: the deterministic Risk Engine
 * stays the only gate between a proposal and a filled order.
 *
 * @module strategy/strategy-interface
 */
import { ConfigError } from '../config/config-error.mjs';

/** Indicator periods a context is built with unless a strategy overrides them. */
export const DEFAULT_INDICATOR_CONFIG = Object.freeze({ fastPeriod: 3, slowPeriod: 6, atrPeriod: 5 });

/**
 * The only thing a strategy is allowed to see.
 *
 * @typedef {object} MarketContext
 * @property {string} symbol
 * @property {string | null} timeframe
 * @property {unknown} instrument
 * @property {unknown} snapshot
 * @property {readonly import('../market/market-snapshot.mjs').Candle[]} candles
 * @property {number | null} timestamp epoch milliseconds
 * @property {Readonly<{ fastPeriod: number, slowPeriod: number, atrPeriod: number, smaFast: number | null, smaSlow: number | null, atr: number | null, lastClose: number | null }>} indicators
 */

/**
 * The Strategy interface (MASTER_SPEC §25, §26): a pure, deterministic function
 * from a MarketContext to a TradeProposal or `null` ("no signal"). It receives
 * no credentials, account state or execution internals, and never sizes.
 *
 * @typedef {object} Strategy
 * @property {string} id stable, unique strategy identifier
 * @property {(context: Readonly<MarketContext>) => import('../domain/proposal.mjs').TradeProposal | null} evaluate
 * @property {Readonly<{ fastPeriod: number, slowPeriod: number, atrPeriod: number }>} indicators
 */

/** Build a frozen strategy; throws ConfigError on a malformed definition. */
export function defineStrategy(definition) {
  if (definition === null || typeof definition !== 'object') {
    throw new ConfigError('defineStrategy requires a definition object');
  }
  if (typeof definition.id !== 'string' || definition.id.trim() === '') {
    throw new ConfigError('strategy id must be a non-empty string');
  }
  if (typeof definition.evaluate !== 'function') {
    throw new ConfigError(`strategy "${definition.id}" must provide an evaluate(context) function`);
  }
  return Object.freeze({
    id: definition.id.trim(),
    evaluate: definition.evaluate,
    indicators: Object.freeze({ ...DEFAULT_INDICATOR_CONFIG, ...(definition.indicators ?? {}) }),
  });
}

/** @throws {ConfigError} unless the value is a usable strategy. */
export function assertStrategy(strategy) {
  if (
    strategy === null ||
    typeof strategy !== 'object' ||
    typeof strategy.id !== 'string' ||
    typeof strategy.evaluate !== 'function'
  ) {
    throw new ConfigError('expected a strategy with an id and an evaluate(context) function');
  }
  return /** @type {any} */ (strategy);
}

/** Simple moving average of the most recent `period` values, or null when undefined. */
export function sma(values, period) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) return null;
    sum += value;
  }
  return sum / period;
}

/** Average true range over the most recent `period` candles (plain mean, not Wilder). */
export function atr(candles, period) {
  if (!Array.isArray(candles) || !Number.isInteger(period) || period <= 0 || candles.length < period + 1) return null;
  let sum = 0;
  for (let index = candles.length - period; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    if (!candle || !previous || ![candle.high, candle.low, previous.close].every(Number.isFinite)) return null;
    sum += Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close),
    );
  }
  return sum / period;
}

/**
 * Build an immutable MarketContext from a normalized market snapshot. This is
 * the ONLY thing a strategy sees — no credentials, account state or execution
 * internals.
 */
export function buildMarketContext(market, indicators = {}) {
  if (market === null || typeof market !== 'object') {
    throw new ConfigError('buildMarketContext requires a market snapshot');
  }
  const config = { ...DEFAULT_INDICATOR_CONFIG, ...indicators };
  const candles = Array.isArray(market.candles) ? market.candles : [];
  const closes = candles.map((candle) => candle.close);
  const timestamp = typeof market.timestamp === 'string' ? Date.parse(market.timestamp) : Number.NaN;

  return Object.freeze({
    symbol: market.symbol,
    timeframe: market.candleTimeframe ?? null,
    instrument: market.instrument ?? null,
    snapshot: market,
    candles: Object.freeze([...candles]),
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    indicators: Object.freeze({
      fastPeriod: config.fastPeriod,
      slowPeriod: config.slowPeriod,
      atrPeriod: config.atrPeriod,
      smaFast: sma(closes, config.fastPeriod),
      smaSlow: sma(closes, config.slowPeriod),
      atr: atr(candles, config.atrPeriod),
      lastClose: closes.length > 0 ? closes[closes.length - 1] : null,
    }),
  });
}
