/**
 * Bybit orderbook -> domain `OrderBookSnapshot` (and WS delta support).
 *
 * REST returns a full sorted book (`b`/`a`); the WebSocket stream sends one
 * `snapshot` and then `delta` frames in which a size of `"0"` means "delete
 * this level". Deltas are NOT sorted and NOT a complete book, so they are parsed
 * level-by-level here and merged into a real snapshot by the market state cache,
 * where the domain constructor can still reject a crossed or malformed result.
 *
 * @module normalizers/bybit-orderbook
 */
import { createOrderBookSnapshot } from '../domain/orderbook-snapshot.mjs';
import { DataError } from '../errors/taxonomy.mjs';
import { requireNumber, toDataError } from './bybit-values.mjs';

/**
 * Parse Bybit `[price, size]` string pairs into frozen numeric levels.
 *
 * @param {unknown} rawLevels
 * @param {string} field
 * @param {{ allowZeroSize?: boolean }} [options] deltas allow size `0` (delete).
 * @returns {readonly (readonly [number, number])[]}
 * @throws {DataError}
 */
export function parseBybitLevels(rawLevels, field, options = {}) {
  if (!Array.isArray(rawLevels)) {
    throw new DataError(`Bybit orderbook ${field} must be an array`, { details: { field } });
  }
  const allowZeroSize = options.allowZeroSize === true;

  return Object.freeze(
    rawLevels.map((level, index) => {
      if (!Array.isArray(level) || level.length < 2) {
        throw new DataError(`Bybit orderbook ${field}[${index}] must be a [price, size] pair`, {
          details: { field, index },
        });
      }
      const price = requireNumber(level[0], `${field}[${index}].price`);
      const size = requireNumber(level[1], `${field}[${index}].size`);
      if (price <= 0) {
        throw new DataError(`Bybit orderbook ${field}[${index}].price must be > 0, got ${price}`, {
          details: { field, index },
        });
      }
      if (size < 0 || (!allowZeroSize && size === 0)) {
        throw new DataError(`Bybit orderbook ${field}[${index}].size must be > 0, got ${size}`, {
          details: { field, index },
        });
      }
      return Object.freeze(/** @type {[number, number]} */ ([price, size]));
    }),
  );
}

/**
 * Normalize a full Bybit book into a validated, frozen snapshot.
 *
 * @param {unknown} raw
 * @param {{ timestamp?: number }} [options]
 * @returns {Readonly<import('../domain/orderbook-snapshot.mjs').OrderBookSnapshot>}
 * @throws {DataError}
 */
export function normalizeBybitOrderbookSnapshot(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DataError('Bybit orderbook payload must be an object', { details: { field: 'orderbook' } });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);
  const symbol = input.s ?? input.symbol;
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    throw new DataError('Bybit orderbook payload is missing a symbol', { details: { field: 'symbol' } });
  }

  const bids = parseBybitLevels(input.bids ?? input.b, 'bids');
  const asks = parseBybitLevels(input.asks ?? input.a, 'asks');
  const timestamp = options.timestamp ?? Number(input.ts ?? input.timestamp);
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new DataError(`Bybit orderbook for ${symbol} has no usable timestamp`, {
      details: { field: 'timestamp', symbol },
    });
  }

  try {
    return createOrderBookSnapshot({ symbol, bids, asks, timestamp });
  } catch (error) {
    throw toDataError(error, `Bybit orderbook for ${symbol} failed validation`, { symbol });
  }
}

/**
 * Normalize a WebSocket orderbook delta (not a complete book).
 *
 * @param {unknown} raw
 * @param {{ timestamp?: number }} [options]
 * @returns {Readonly<{ symbol: string, bids: readonly (readonly [number, number])[], asks: readonly (readonly [number, number])[], timestamp: number, updateId: number | null }>}
 * @throws {DataError}
 */
export function normalizeBybitOrderbookDelta(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DataError('Bybit orderbook delta must be an object', { details: { field: 'orderbook' } });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);
  const symbol = input.s ?? input.symbol;
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    throw new DataError('Bybit orderbook delta is missing a symbol', { details: { field: 'symbol' } });
  }

  const timestamp = options.timestamp ?? Number(input.ts ?? input.timestamp);
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new DataError(`Bybit orderbook delta for ${symbol} has no usable timestamp`, {
      details: { field: 'timestamp', symbol },
    });
  }

  return Object.freeze({
    symbol: symbol.trim().toUpperCase(),
    bids: parseBybitLevels(input.bids ?? input.b, 'bids', { allowZeroSize: true }),
    asks: parseBybitLevels(input.asks ?? input.a, 'asks', { allowZeroSize: true }),
    timestamp,
    updateId: toUpdateId(input.u ?? input.seq),
  });
}

/**
 * Merge delta changes into an existing side of the book.
 *
 * @param {readonly (readonly [number, number])[]} currentLevels
 * @param {readonly (readonly [number, number])[]} changes size 0 deletes a level
 * @param {'asc' | 'desc'} order
 * @param {number} [limit]
 * @returns {readonly (readonly [number, number])[]}
 */
export function mergeOrderbookLevels(currentLevels, changes, order, limit) {
  /** @type {Map<number, number>} */
  const book = new Map();
  for (const [price, size] of currentLevels) book.set(price, size);
  for (const [price, size] of changes) {
    if (size === 0) book.delete(price);
    else book.set(price, size);
  }

  const levels = [...book.entries()].map(([price, size]) => Object.freeze(/** @type {[number, number]} */ ([price, size])));
  levels.sort((left, right) => (order === 'desc' ? right[0] - left[0] : left[0] - right[0]));
  const capped = Number.isInteger(limit) && limit > 0 ? levels.slice(0, limit) : levels;
  return Object.freeze(capped);
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function toUpdateId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}
