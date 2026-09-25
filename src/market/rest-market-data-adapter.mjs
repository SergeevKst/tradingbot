/**
 * REST market data adapter.
 *
 * Reads PUBLIC Bybit V5 endpoints only. This adapter has no credentials, no
 * signing code and no authenticated request path: market data does not need
 * them, and keeping them out means a bug here cannot expose an API key.
 *
 * It is also strictly read-only by construction — every request is a GET to a
 * `/v5/market/*` or `/v5/asset/*` public endpoint. No order, leverage, margin or
 * account-setting call exists in this file.
 *
 * @module market/rest-market-data-adapter
 */
import { ConfigError } from '../config/config-error.mjs';
import { normalizeInstrumentInfo } from './instrument-info.mjs';
import { createMarketSnapshot, normalizeCandle } from './market-snapshot.mjs';

/** Public endpoints used by this adapter. All GET, all unauthenticated. */
const ENDPOINTS = Object.freeze({
  instruments: '/v5/market/instruments-info',
  tickers: '/v5/market/tickers',
  orderbook: '/v5/market/orderbook',
  kline: '/v5/market/kline',
});

/**
 * Build a REST-backed adapter.
 *
 * @param {{
 *   baseUrl?: string,
 *   category?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 * }} [options]
 * @returns {import('./market-data-adapter.mjs').MarketDataAdapter}
 */
export function createRestMarketDataAdapter(options = {}) {
  const baseUrl = (options.baseUrl ?? 'https://api.bybit.com').replace(/\/+$/, '');
  const category = options.category ?? 'linear';
  const timeoutMs = options.timeoutMs ?? 15000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());

  if (typeof fetchImpl !== 'function') {
    throw new ConfigError('createRestMarketDataAdapter requires a fetch implementation');
  }

  /** Cache of instrument metadata; these change rarely and are rate-limited. */
  const instrumentCache = new Map();

  /**
   * @param {string} path
   * @param {Record<string, string | number>} params
   */
  async function get(path, params) {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    ).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}?${query}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ConfigError(`Market data request failed: HTTP ${response.status} for ${path}`, { field: 'marketData' });
      }
      const payload = await response.json();
      if (payload?.retCode !== 0) {
        throw new ConfigError(
          `Bybit market data error: retCode=${payload?.retCode} retMsg=${payload?.retMsg ?? 'unknown'}`,
          { field: 'marketData' },
        );
      }
      return payload.result ?? {};
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {string} symbol
   * @returns {Promise<import('./instrument-info.mjs').InstrumentInfo>}
   */
  async function getInstrumentInfo(symbol) {
    const key = symbol.trim().toUpperCase();
    const cached = instrumentCache.get(key);
    if (cached) return cached;

    const result = await get(ENDPOINTS.instruments, { category, symbol: key });
    const row = (result.list ?? [])[0];
    if (!row) {
      throw new ConfigError(`Instrument ${key} was not found in category ${category}`, { field: 'symbol', value: key });
    }

    // Values come from the exchange; nothing here is defaulted or invented.
    const instrument = normalizeInstrumentInfo({
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

    instrumentCache.set(key, instrument);
    return instrument;
  }

  return Object.freeze({
    kind: () => 'rest',

    getInstrumentInfo,

    /** Drop cached instrument metadata (e.g. after an exchange update). */
    clearInstrumentCache() {
      instrumentCache.clear();
    },

    async getTicker(symbol) {
      const key = symbol.trim().toUpperCase();
      const result = await get(ENDPOINTS.tickers, { category, symbol: key });
      const row = (result.list ?? [])[0];
      if (!row) {
        throw new ConfigError(`No ticker returned for ${key}`, { field: 'symbol', value: key });
      }
      return {
        lastPrice: toNumberOrNull(row.lastPrice),
        markPrice: toNumberOrNull(row.markPrice),
        bid: toNumberOrNull(row.bid1Price),
        ask: toNumberOrNull(row.ask1Price),
        volume: toNumberOrNull(row.volume24h),
      };
    },

    async getOrderbook(symbol, limit = 1) {
      const key = symbol.trim().toUpperCase();
      const result = await get(ENDPOINTS.orderbook, { category, symbol: key, limit });
      const bids = (result.b ?? []).map((pair) => [Number(pair[0]), Number(pair[1])]);
      const asks = (result.a ?? []).map((pair) => [Number(pair[0]), Number(pair[1])]);
      return {
        bid: bids.length > 0 ? bids[0][0] : null,
        ask: asks.length > 0 ? asks[0][0] : null,
        bids,
        asks,
      };
    },

    async getCandles(symbol, interval = '15', limit = 200) {
      const key = symbol.trim().toUpperCase();
      const result = await get(ENDPOINTS.kline, { category, symbol: key, interval, limit });
      // Bybit returns newest-first; normalize to chronological order.
      return (result.list ?? [])
        .map((row) =>
          normalizeCandle({
            startTime: Number(row[0]),
            open: row[1],
            high: row[2],
            low: row[3],
            close: row[4],
            volume: row[5],
            turnover: row[6],
          }),
        )
        .reverse();
    },

    async getSnapshot(symbol, snapshotOptions = {}) {
      const key = symbol.trim().toUpperCase();
      const interval = snapshotOptions.interval ?? '15';
      const candleLimit = snapshotOptions.candleLimit ?? 200;

      const [instrument, ticker, orderbook] = await Promise.all([
        getInstrumentInfo(key),
        this.getTicker(key),
        this.getOrderbook(key, 1),
      ]);

      const candles =
        snapshotOptions.includeCandles === false ? [] : await this.getCandles(key, interval, candleLimit);

      return createMarketSnapshot({
        symbol: key,
        timestamp: new Date(now()).toISOString(),
        lastPrice: ticker.lastPrice,
        markPrice: ticker.markPrice,
        // Orderbook top-of-book wins over the ticker's b1/a1 when both exist.
        bid: orderbook.bid ?? ticker.bid,
        ask: orderbook.ask ?? ticker.ask,
        volume: ticker.volume,
        candleTimeframe: candles.length > 0 ? interval : null,
        candles,
        instrument,
      });
    },
  });
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function toNumberOrNull(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(String(raw));
  return Number.isFinite(value) ? value : null;
}