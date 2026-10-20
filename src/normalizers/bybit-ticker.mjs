/**
 * Bybit ticker -> domain `MarketTick`.
 *
 * Accepts both the V5 REST ticker row (`lastPrice`, `markPrice`, `bid1Price`,
 * `ask1Price`, `volume24h`) and the WebSocket `tickers.<symbol>` payload (same
 * fields plus `ts`). Nothing is invented: if neither last nor mark price is
 * present the tick is refused, and a crossed bid/ask is a `DataError` rather
 * than something to average away.
 *
 * @module normalizers/bybit-ticker
 */
import { createMarketTick } from '../domain/market-tick.mjs';
import { DataError } from '../errors/taxonomy.mjs';
import { toDataError, toFiniteNumber } from './bybit-values.mjs';

/**
 * @param {unknown} raw Bybit ticker payload (REST row or WS data).
 * @param {{ timestamp?: number }} [options] explicit timestamp when the payload
 *   does not carry one (REST rows generally do not).
 * @returns {Readonly<import('../domain/market-tick.mjs').MarketTick>}
 * @throws {DataError}
 */
export function normalizeBybitTicker(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DataError('Bybit ticker payload must be an object', { details: { field: 'ticker' } });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  const symbol = input.symbol ?? input.s;
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    throw new DataError('Bybit ticker payload is missing a symbol', { details: { field: 'symbol' } });
  }

  const lastPrice = toFiniteNumber(input.lastPrice);
  const markPrice = toFiniteNumber(input.markPrice);
  const price = lastPrice ?? markPrice;
  if (price === null) {
    throw new DataError(`Bybit ticker for ${symbol} has neither lastPrice nor markPrice`, {
      details: { field: 'price', symbol },
    });
  }

  const timestamp = options.timestamp ?? toFiniteNumber(input.ts ?? input.time);
  if (timestamp === null || timestamp === undefined) {
    throw new DataError(`Bybit ticker for ${symbol} has no usable timestamp`, {
      details: { field: 'timestamp', symbol },
    });
  }

  try {
    return createMarketTick({
      symbol,
      price,
      bid: toFiniteNumber(input.bid1Price ?? input.bid),
      ask: toFiniteNumber(input.ask1Price ?? input.ask),
      volume: toFiniteNumber(input.volume24h ?? input.volume),
      timestamp,
    });
  } catch (error) {
    throw toDataError(error, `Bybit ticker for ${symbol} failed validation`, { symbol });
  }
}
