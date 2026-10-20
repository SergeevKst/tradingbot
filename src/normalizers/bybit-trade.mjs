/**
 * Bybit trade -> a validated, frozen public trade record.
 *
 * Supports the WebSocket `publicTrade.<symbol>` payload (`T`,`s`,`S`,`v`,`p`,`i`)
 * and the REST `recent-trade` row (`time`,`symbol`,`side`,`size`,`price`,
 * `execId`). There is no domain trade type yet, so the normalized shape is
 * defined and validated here; it carries no decision and no account data.
 *
 * @module normalizers/bybit-trade
 */
import { DataError } from '../errors/taxonomy.mjs';
import { requireNumber } from './bybit-values.mjs';

const TRADE_SIDES = Object.freeze(['BUY', 'SELL']);

/**
 * @typedef {object} BybitTrade
 * @property {string} symbol
 * @property {number} price > 0
 * @property {number} size > 0
 * @property {'BUY' | 'SELL'} side taker side
 * @property {number} timestamp epoch milliseconds
 * @property {string | null} tradeId
 */

/**
 * @param {unknown} raw
 * @returns {Readonly<BybitTrade>}
 * @throws {DataError}
 */
export function normalizeBybitTrade(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DataError('Bybit trade payload must be an object', { details: { field: 'trade' } });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  const symbol = input.s ?? input.symbol;
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    throw new DataError('Bybit trade payload is missing a symbol', { details: { field: 'symbol' } });
  }

  const price = requireNumber(input.p ?? input.price, 'trade.price');
  if (price <= 0) {
    throw new DataError(`Bybit trade price must be > 0, got ${price}`, { details: { field: 'price', symbol } });
  }

  const size = requireNumber(input.v ?? input.size, 'trade.size');
  if (size <= 0) {
    throw new DataError(`Bybit trade size must be > 0, got ${size}`, { details: { field: 'size', symbol } });
  }

  const rawSide = input.S ?? input.side;
  const side = typeof rawSide === 'string' ? rawSide.trim().toUpperCase() : '';
  if (!TRADE_SIDES.includes(side)) {
    throw new DataError(`Bybit trade side must be BUY or SELL, got ${JSON.stringify(rawSide)}`, {
      details: { field: 'side', symbol },
    });
  }

  const timestamp = requireNumber(input.T ?? input.time, 'trade.timestamp');
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new DataError(`Bybit trade timestamp must be positive epoch milliseconds, got ${timestamp}`, {
      details: { field: 'timestamp', symbol },
    });
  }

  const rawId = input.i ?? input.execId;
  const tradeId = rawId === undefined || rawId === null || rawId === '' ? null : String(rawId);

  return Object.freeze({ symbol: symbol.trim().toUpperCase(), price, size, side: /** @type {'BUY'|'SELL'} */ (side), timestamp, tradeId });
}
