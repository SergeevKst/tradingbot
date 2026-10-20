/**
 * OrderBookSnapshot — a validated level-2 book view (MASTER_SPEC §7).
 *
 * Levels are `[price, size]` pairs. The book must be internally consistent:
 * bids descending, asks ascending, every level positive, and no crossed book.
 * A malformed book is refused because pricing a fill from corrupt depth is
 * exactly how a simulation silently becomes fiction.
 *
 * @module domain/orderbook-snapshot
 */
import {
  assertClosedFields,
  assertEpochMillis,
  assertPlainObject,
  assertRequiredNumber,
  assertSymbol,
} from '../types/primitives.mjs';
import { ValidationError } from '../errors/taxonomy.mjs';

export const ORDER_BOOK_FIELDS = Object.freeze(['symbol', 'bids', 'asks', 'timestamp']);

/**
 * @typedef {readonly [number, number]} OrderBookLevel [price, size]
 */

/**
 * @typedef {object} OrderBookSnapshot
 * @property {string} symbol
 * @property {readonly OrderBookLevel[]} bids descending by price
 * @property {readonly OrderBookLevel[]} asks ascending by price
 * @property {number} timestamp epoch milliseconds
 */

/**
 * @param {unknown} levels
 * @param {string} field
 * @param {'asc' | 'desc'} order
 * @returns {readonly OrderBookLevel[]}
 * @throws {ValidationError}
 */
function parseLevels(levels, field, order) {
  if (!Array.isArray(levels)) {
    throw new ValidationError(`"${field}" must be an array of [price, size] levels`, { details: { field } });
  }
  /** @type {OrderBookLevel[]} */
  const parsed = [];
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    if (!Array.isArray(level) || level.length !== 2) {
      throw new ValidationError(`"${field}[${index}]" must be a [price, size] pair`, { details: { field, index } });
    }
    const price = assertRequiredNumber(level[0], `${field}[${index}].price`, { exclusiveMin: 0 });
    const size = assertRequiredNumber(level[1], `${field}[${index}].size`, { exclusiveMin: 0 });
    const previous = parsed[parsed.length - 1];
    if (previous !== undefined) {
      if (order === 'desc' && price > previous[0]) {
        throw new ValidationError(`"${field}" must be sorted descending by price`, { details: { field, index } });
      }
      if (order === 'asc' && price < previous[0]) {
        throw new ValidationError(`"${field}" must be sorted ascending by price`, { details: { field, index } });
      }
    }
    parsed.push(Object.freeze(/** @type {OrderBookLevel} */ ([price, size])));
  }
  return Object.freeze(parsed);
}

/**
 * Validate and freeze an OrderBookSnapshot.
 *
 * @param {unknown} raw
 * @returns {Readonly<OrderBookSnapshot>}
 * @throws {ValidationError}
 */
export function createOrderBookSnapshot(raw) {
  const input = assertPlainObject(raw, 'OrderBookSnapshot');
  assertClosedFields(input, ORDER_BOOK_FIELDS, 'OrderBookSnapshot');

  const bids = parseLevels(input.bids, 'OrderBookSnapshot.bids', 'desc');
  const asks = parseLevels(input.asks, 'OrderBookSnapshot.asks', 'asc');

  const bestBid = bids.length > 0 ? bids[0][0] : null;
  const bestAsk = asks.length > 0 ? asks[0][0] : null;
  if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) {
    throw new ValidationError(`OrderBookSnapshot is crossed: best bid ${bestBid} >= best ask ${bestAsk}`, {
      details: { field: 'orderbook' },
    });
  }

  return Object.freeze({
    symbol: assertSymbol(input.symbol, 'OrderBookSnapshot.symbol'),
    bids,
    asks,
    timestamp: assertEpochMillis(input.timestamp, 'OrderBookSnapshot.timestamp'),
  });
}
