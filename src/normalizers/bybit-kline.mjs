/**
 * Bybit kline rows -> validated candles.
 *
 * Bybit returns klines as positional arrays `[start, open, high, low, close,
 * volume, turnover]`, newest first. This module validates each row through the
 * existing candle normalizer and refuses an unknown interval, so a caller
 * cannot label a series with a timeframe the rest of the system does not know.
 *
 * @module normalizers/bybit-kline
 */
import { CANDLE_INTERVALS, normalizeCandle } from '../market/market-snapshot.mjs';
import { DataError } from '../errors/taxonomy.mjs';
import { toDataError } from './bybit-values.mjs';

/**
 * @param {unknown} row
 * @returns {Readonly<import('../market/market-snapshot.mjs').Candle>}
 * @throws {DataError}
 */
export function normalizeBybitKline(row) {
  if (!Array.isArray(row) || row.length < 6) {
    throw new DataError('Bybit kline row must be an array of at least 6 fields', {
      details: { field: 'kline' },
    });
  }
  try {
    return normalizeCandle({
      startTime: row[0],
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
      turnover: row[6],
    });
  } catch (error) {
    throw toDataError(error, 'Bybit kline row failed validation');
  }
}

/**
 * @param {unknown} rows
 * @param {{ interval?: string }} [options]
 * @returns {readonly Readonly<import('../market/market-snapshot.mjs').Candle>[]}
 * @throws {DataError}
 */
export function normalizeBybitKlines(rows, options = {}) {
  if (!Array.isArray(rows)) {
    throw new DataError('Bybit kline list must be an array', { details: { field: 'kline' } });
  }
  if (options.interval !== undefined && !CANDLE_INTERVALS.includes(String(options.interval))) {
    throw new DataError(
      `Bybit kline interval must be one of: ${CANDLE_INTERVALS.join(', ')} — got ${JSON.stringify(options.interval)}`,
      { details: { field: 'interval' } },
    );
  }
  return Object.freeze(rows.map(normalizeBybitKline));
}
