/**
 * Bybit REST market data adapter.
 *
 * Implements the core `MarketDataAdapter` port over the public REST client.
 * Ticker and orderbook responses are normalized into the Phase 1 domain types
 * (`MarketTick`, `OrderBookSnapshot`); klines become validated candles. No
 * credential is read and no request is anything but a public `GET`.
 *
 * @module adapters/bybit/rest-market-data-adapter
 */
import { DataError } from '../../errors/taxonomy.mjs';
import { normalizeInstrumentInfo } from '../../market/instrument-info.mjs';
import { createMarketSnapshot } from '../../market/market-snapshot.mjs';
import { normalizeBybitKline } from '../../normalizers/bybit-kline.mjs';
import { normalizeBybitOrderbookSnapshot } from '../../normalizers/bybit-orderbook.mjs';
import { normalizeBybitTicker } from '../../normalizers/bybit-ticker.mjs';
import { toDataError, toFiniteNumber } from '../../normalizers/bybit-values.mjs';
import { BYBIT_REST_PATHS, normalizeSymbol } from './endpoints.mjs';
import { createBybitRestClient } from './rest-client.mjs';

/**
 * @param {{
 *   baseUrl?: string,
 *   category?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   retry?: object,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   now?: () => number,
 * }} [options]
 * @returns {import('../../market/market-data-adapter.mjs').MarketDataAdapter & { clearInstrumentCache: () => void }}
 */
export function createBybitRestMarketDataAdapter(options = {}) {
  const client = createBybitRestClient(options);
  const category = client.category;
  const now = options.now ?? (() => Date.now());
  /** Instrument metadata changes rarely and is rate-limited; cache it. */
  const instrumentCache = new Map();

  /**
   * @param {string} key
   * @returns {Promise<Record<string, unknown>>}
   */
  async function fetchTickerRow(key) {
    const result = await client.request(BYBIT_REST_PATHS.tickers, { category, symbol: key });
    const row = (Array.isArray(result.list) ? result.list : [])[0];
    if (!row) {
      throw new DataError(`No ticker returned for ${key}`, { details: { field: 'symbol', value: key } });
    }
    return /** @type {Record<string, unknown>} */ (row);
  }

  /**
   * @param {string} symbol
   * @returns {Promise<Readonly<import('../../market/instrument-info.mjs').InstrumentInfo>>}
   */
  async function getInstrumentInfo(symbol) {
    const key = normalizeSymbol(symbol);
    const cached = instrumentCache.get(key);
    if (cached) return cached;

    const result = await client.request(BYBIT_REST_PATHS.instruments, { category, symbol: key });
    const row = /** @type {Record<string, any> | undefined} */ (
      (Array.isArray(result.list) ? result.list : [])[0]
    );
    if (!row) {
      throw new DataError(`Instrument ${key} was not found in category ${category}`, {
        details: { field: 'symbol', value: key },
      });
    }

    let instrument;
    try {
      instrument = normalizeInstrumentInfo({
        symbol: row.symbol,
        status: row.status,
        baseCoin: row.baseCoin,
        quoteCoin: row.quoteCoin,
        settleCoin: row.settleCoin,
        tickSize: row.priceFilter?.tickSize,
        qtyStep: row.lotSizeFilter?.qtyStep,
        minOrderQty: row.lotSizeFilter?.minOrderQty,
        maxOrderQty: row.lotSizeFilter?.maxOrderQty,
        maxLeverage: row.leverageFilter?.maxLeverage,
        minNotionalUsd: row.lotSizeFilter?.minNotionalValue,
        receivedAt: new Date(now()).toISOString(),
      });
    } catch (error) {
      throw toDataError(error, `Instrument ${key} metadata failed validation`, { symbol: key });
    }

    instrumentCache.set(key, instrument);
    return instrument;
  }

  /**
   * @param {string} symbol
   * @returns {Promise<Readonly<import('../../domain/market-tick.mjs').MarketTick>>}
   */
  async function getTicker(symbol) {
    const key = normalizeSymbol(symbol);
    const row = await fetchTickerRow(key);
    const timestamp = toFiniteNumber(row.ts ?? row.time) ?? now();
    return normalizeBybitTicker(row, { timestamp });
  }

  /**
   * @param {string} symbol
   * @param {number} [limit]
   * @returns {Promise<Readonly<import('../../domain/orderbook-snapshot.mjs').OrderBookSnapshot>>}
   */
  async function getOrderbook(symbol, limit = 50) {
    const key = normalizeSymbol(symbol);
    const result = await client.request(BYBIT_REST_PATHS.orderbook, { category, symbol: key, limit });
    return normalizeBybitOrderbookSnapshot(
      { ...result, s: result.s ?? key },
      { timestamp: Number(result.ts) || now() },
    );
  }

  /**
   * @param {string} symbol
   * @param {string} [interval]
   * @param {number} [limit]
   * @returns {Promise<readonly Readonly<import('../../market/market-snapshot.mjs').Candle>[]>}
   */
  async function getCandles(symbol, interval = '15', limit = 200) {
    const key = normalizeSymbol(symbol);
    const result = await client.request(BYBIT_REST_PATHS.kline, { category, symbol: key, interval, limit });
    const rows = Array.isArray(result.list) ? result.list : [];
    // Bybit returns newest-first; normalize to chronological order for indicator use.
    return Object.freeze([...rows].reverse().map(normalizeBybitKline));
  }

  /**
   * @param {string} symbol
   * @param {{ interval?: string, candleLimit?: number, includeCandles?: boolean }} [snapshotOptions]
   * @returns {Promise<Readonly<import('../../market/market-snapshot.mjs').MarketSnapshot>>}
   */
  async function getSnapshot(symbol, snapshotOptions = {}) {
    const key = normalizeSymbol(symbol);
    const interval = snapshotOptions.interval ?? '15';
    const candleLimit = snapshotOptions.candleLimit ?? 200;

    const [row, orderbook, instrument] = await Promise.all([
      fetchTickerRow(key),
      getOrderbook(key, 1),
      getInstrumentInfo(key),
    ]);
    const candles =
      snapshotOptions.includeCandles === false ? [] : await getCandles(key, interval, candleLimit);

    const bestBid = orderbook.bids.length > 0 ? orderbook.bids[0][0] : null;
    const bestAsk = orderbook.asks.length > 0 ? orderbook.asks[0][0] : null;

    return createMarketSnapshot({
      symbol: key,
      timestamp: new Date(now()).toISOString(),
      lastPrice: toFiniteNumber(row.lastPrice),
      markPrice: toFiniteNumber(row.markPrice),
      // Top-of-book wins over the ticker's b1/a1 when both exist.
      bid: bestBid ?? toFiniteNumber(row.bid1Price),
      ask: bestAsk ?? toFiniteNumber(row.ask1Price),
      volume: toFiniteNumber(row.volume24h),
      candleTimeframe: candles.length > 0 ? interval : null,
      candles,
      instrument,
    });
  }

  return Object.freeze({
    kind: () => 'bybit-rest',
    getInstrumentInfo,
    getTicker,
    getOrderbook,
    getCandles,
    getSnapshot,
    clearInstrumentCache() {
      instrumentCache.clear();
    },
  });
}
