/**
 * Normalized market snapshot.
 *
 * The boundary between "Bybit's payload" and "what the core sees". Every field
 * is optional-by-nature except `symbol`, because a snapshot is assembled from
 * several exchange calls and a missing piece must be representable — a paper
 * fill that lacks a bid is a REFUSAL, not a reason to invent a price.
 *
 * `candles` carries normalized OHLCV rows; no indicator is computed here and no
 * trading signal is derived (this stage implements no strategy).
 *
 * @module market/market-snapshot
 */
import { ConfigError } from '../config/config-error.mjs';
import { normalizeInstrumentInfo } from './instrument-info.mjs';

/** Candle intervals accepted by the adapter, matching Bybit's interval codes. */
export const CANDLE_INTERVALS = Object.freeze(['1', '3', '5', '15', '30', '60', '120', '240', '360', '720', 'D', 'W', 'M']);

/**
 * @typedef {object} Candle
 * @property {number} startTime epoch milliseconds
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume
 * @property {number} turnover
 */

/**
 * @typedef {object} MarketSnapshot
 * @property {string} symbol
 * @property {string} timestamp ISO timestamp the snapshot was assembled
 * @property {number | null} lastPrice
 * @property {number | null} markPrice
 * @property {number | null} bid best bid (price a seller receives)
 * @property {number | null} ask best ask (price a buyer pays)
 * @property {number | null} spread ask - bid
 * @property {number | null} volume 24h volume in base units
 * @property {string | null} candleTimeframe
 * @property {Candle[]} candles
 * @property {import('./instrument-info.mjs').InstrumentInfo | null} instrument
 */

/**
 * @param {unknown} raw
 * @param {string} field
 * @returns {number | null}
 */
function optionalNumber(raw, field) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) {
    throw new ConfigError(`MarketSnapshot.${field} must be a finite number or absent, got ${JSON.stringify(raw)}`, {
      field,
      value: raw,
    });
  }
  if (value < 0) {
    throw new ConfigError(`MarketSnapshot.${field} must not be negative, got ${value}`, { field, value: raw });
  }
  return value;
}

/**
 * Normalize a raw candle row.
 *
 * @param {unknown} raw
 * @returns {Candle}
 * @throws {ConfigError}
 */
export function normalizeCandle(raw) {
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigError('Candle must be an object', { field: 'candle' });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  const candle = {
    startTime: optionalNumber(input.startTime, 'candle.startTime'),
    open: optionalNumber(input.open, 'candle.open'),
    high: optionalNumber(input.high, 'candle.high'),
    low: optionalNumber(input.low, 'candle.low'),
    close: optionalNumber(input.close, 'candle.close'),
    volume: optionalNumber(input.volume, 'candle.volume') ?? 0,
    turnover: optionalNumber(input.turnover, 'candle.turnover') ?? 0,
  };

  for (const field of ['startTime', 'open', 'high', 'low', 'close']) {
    if (candle[field] === null) {
      throw new ConfigError(`Candle.${field} is required`, { field: `candle.${field}`, value: input[field] });
    }
  }
  if (candle.high < candle.low) {
    throw new ConfigError(`Candle.high (${candle.high}) must be >= low (${candle.low})`, { field: 'candle.high' });
  }

  return Object.freeze(candle);
}

/**
 * Assemble a frozen, normalized snapshot.
 *
 * `bid`/`ask` are preserved as `null` when absent rather than being filled from
 * `lastPrice`, because the paper executor must be able to see that the market
 * data is incomplete and refuse to trade on it.
 *
 * @param {unknown} raw
 * @returns {Readonly<MarketSnapshot>}
 * @throws {ConfigError}
 */
export function createMarketSnapshot(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('MarketSnapshot must be an object', { field: 'market' });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  if (typeof input.symbol !== 'string' || input.symbol.trim() === '') {
    throw new ConfigError('MarketSnapshot.symbol is required', { field: 'symbol', value: input.symbol });
  }
  const symbol = input.symbol.trim().toUpperCase();

  const lastPrice = optionalNumber(input.lastPrice, 'lastPrice');
  const markPrice = optionalNumber(input.markPrice, 'markPrice');
  const bid = optionalNumber(input.bid, 'bid');
  const ask = optionalNumber(input.ask, 'ask');
  const volume = optionalNumber(input.volume, 'volume');

  // A crossed book is corrupt data, not an opportunity.
  if (bid !== null && ask !== null && ask < bid) {
    throw new ConfigError(`MarketSnapshot has a crossed book: bid ${bid} > ask ${ask}`, { field: 'orderbook' });
  }

  const spread = bid !== null && ask !== null ? ask - bid : null;

  let candleTimeframe = null;
  /** @type {Candle[]} */
  let candles = [];
  if (input.candles !== undefined && input.candles !== null) {
    if (!Array.isArray(input.candles)) {
      throw new ConfigError('MarketSnapshot.candles must be an array', { field: 'candles' });
    }
    candles = input.candles.map(normalizeCandle);
    if (input.candleTimeframe !== undefined && input.candleTimeframe !== null) {
      const tf = String(input.candleTimeframe);
      if (!CANDLE_INTERVALS.includes(tf)) {
        throw new ConfigError(
          `MarketSnapshot.candleTimeframe must be one of: ${CANDLE_INTERVALS.join(', ')} — got ${JSON.stringify(tf)}`,
          { field: 'candleTimeframe', value: tf },
        );
      }
      candleTimeframe = tf;
    }
  }

  const instrument =
    input.instrument === undefined || input.instrument === null ? null : normalizeInstrumentInfo(input.instrument);

  return Object.freeze({
    symbol,
    timestamp: typeof input.timestamp === 'string' ? input.timestamp : new Date().toISOString(),
    lastPrice,
    markPrice,
    bid,
    ask,
    spread,
    volume,
    candleTimeframe,
    candles: Object.freeze(candles),
    instrument,
  });
}

/**
 * The price a paper BUY (entry for LONG, exit for SHORT) would pay.
 *
 * @param {Readonly<MarketSnapshot>} snapshot
 * @returns {number | null}
 */
export function askPrice(snapshot) {
  return snapshot.ask;
}

/**
 * The price a paper SELL (exit for LONG, entry for SHORT) would receive.
 *
 * @param {Readonly<MarketSnapshot>} snapshot
 * @returns {number | null}
 */
export function bidPrice(snapshot) {
  return snapshot.bid;
}

/**
 * Trigger reference price: mark price when available, else last price.
 *
 * Used for stop/target checks. Returns null when neither exists, which the
 * executor treats as "cannot evaluate" and refuses to act on.
 *
 * @param {Readonly<MarketSnapshot>} snapshot
 * @returns {number | null}
 */
export function triggerReferencePrice(snapshot) {
  if (Number.isFinite(snapshot.markPrice)) return /** @type {number} */ (snapshot.markPrice);
  if (Number.isFinite(snapshot.lastPrice)) return /** @type {number} */ (snapshot.lastPrice);
  return null;
}