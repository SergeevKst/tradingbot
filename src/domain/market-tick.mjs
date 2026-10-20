/**
 * MarketTick — a single point-in-time price observation (MASTER_SPEC §7).
 *
 * A tick is the smallest market primitive: it knows nothing about candles,
 * indicators or instruments. A crossed bid/ask is corrupt data and is refused
 * rather than averaged away.
 *
 * @module domain/market-tick
 */
import {
  assertClosedFields,
  assertEpochMillis,
  assertOptionalNumber,
  assertPlainObject,
  assertRequiredNumber,
  assertSymbol,
} from '../types/primitives.mjs';
import { ValidationError } from '../errors/taxonomy.mjs';

export const MARKET_TICK_FIELDS = Object.freeze(['symbol', 'price', 'bid', 'ask', 'volume', 'timestamp']);

/**
 * @typedef {object} MarketTick
 * @property {string} symbol
 * @property {number} price last/mark price, > 0
 * @property {number} [bid] > 0
 * @property {number} [ask] > 0, must be >= bid when both present
 * @property {number} [volume] >= 0
 * @property {number} timestamp epoch milliseconds
 */

/**
 * Validate and freeze a MarketTick.
 *
 * @param {unknown} raw
 * @returns {Readonly<MarketTick>}
 * @throws {ValidationError}
 */
export function createMarketTick(raw) {
  const input = assertPlainObject(raw, 'MarketTick');
  assertClosedFields(input, MARKET_TICK_FIELDS, 'MarketTick');

  const bid = assertOptionalNumber(input.bid, 'MarketTick.bid', { exclusiveMin: 0 });
  const ask = assertOptionalNumber(input.ask, 'MarketTick.ask', { exclusiveMin: 0 });
  if (bid !== undefined && ask !== undefined && ask < bid) {
    throw new ValidationError(`MarketTick has a crossed book: bid ${bid} > ask ${ask}`, {
      details: { field: 'ask', value: ask },
    });
  }

  return Object.freeze({
    symbol: assertSymbol(input.symbol, 'MarketTick.symbol'),
    price: assertRequiredNumber(input.price, 'MarketTick.price', { exclusiveMin: 0 }),
    bid,
    ask,
    volume: assertOptionalNumber(input.volume, 'MarketTick.volume', { min: 0 }),
    timestamp: assertEpochMillis(input.timestamp, 'MarketTick.timestamp'),
  });
}
