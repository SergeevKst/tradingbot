/**
 * Bybit public endpoint definitions and topic helpers.
 *
 * Every REST path here is a public `GET /v5/market/*` endpoint and every
 * WebSocket URL is a public market stream. No authenticated host, path or topic
 * exists in this module: market data needs no credentials.
 *
 * The known-host check lives here so an adapter cannot be pointed at an
 * arbitrary server by an unvalidated `baseUrl`.
 *
 * @module adapters/bybit/endpoints
 */
import { ConfigurationError } from '../../errors/taxonomy.mjs';

/** Known Bybit REST hosts. */
export const BYBIT_REST_BASE_URLS = Object.freeze({
  MAINNET: 'https://api.bybit.com',
  TESTNET: 'https://api-testnet.bybit.com',
});

/** Public WebSocket hosts, per product category. */
export const BYBIT_WS_PUBLIC_BASE_URLS = Object.freeze({
  MAINNET: Object.freeze({
    linear: 'wss://stream.bybit.com/v5/public/linear',
    inverse: 'wss://stream.bybit.com/v5/public/inverse',
    spot: 'wss://stream.bybit.com/v5/public/spot',
    option: 'wss://stream.bybit.com/v5/public/option',
  }),
  TESTNET: Object.freeze({
    linear: 'wss://stream-testnet.bybit.com/v5/public/linear',
    inverse: 'wss://stream-testnet.bybit.com/v5/public/inverse',
    spot: 'wss://stream-testnet.bybit.com/v5/public/spot',
    option: 'wss://stream-testnet.bybit.com/v5/public/option',
  }),
});

/** The public REST paths the market-data adapter is allowed to call. */
export const BYBIT_REST_PATHS = Object.freeze({
  instruments: '/v5/market/instruments-info',
  tickers: '/v5/market/tickers',
  orderbook: '/v5/market/orderbook',
  kline: '/v5/market/kline',
});

/** Product categories that have a public stream. */
export const PUBLIC_CATEGORIES = Object.freeze(Object.keys(BYBIT_WS_PUBLIC_BASE_URLS.MAINNET));

/**
 * Normalize and validate a REST base URL against the known Bybit hosts.
 *
 * @param {unknown} baseUrl
 * @returns {string} the URL without a trailing slash
 * @throws {ConfigurationError}
 */
export function assertBybitRestBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new ConfigurationError('Bybit baseUrl must be a non-empty string', {
      details: { field: 'baseUrl', value: baseUrl },
    });
  }
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!Object.values(BYBIT_REST_BASE_URLS).includes(normalized)) {
    throw new ConfigurationError(
      `Bybit baseUrl must be one of: ${Object.values(BYBIT_REST_BASE_URLS).join(', ')} — got ${JSON.stringify(baseUrl)}`,
      { details: { field: 'baseUrl', value: baseUrl } },
    );
  }
  return normalized;
}

/**
 * Resolve the public WebSocket URL for a category.
 *
 * @param {{ category?: string, testnet?: boolean }} [options]
 * @returns {string}
 * @throws {ConfigurationError}
 */
export function resolvePublicWsUrl(options = {}) {
  const category = options.category ?? 'linear';
  const network = options.testnet === true ? 'TESTNET' : 'MAINNET';
  const url = BYBIT_WS_PUBLIC_BASE_URLS[network][category];
  if (url === undefined) {
    throw new ConfigurationError(
      `Bybit WebSocket category must be one of: ${PUBLIC_CATEGORIES.join(', ')} — got ${JSON.stringify(category)}`,
      { details: { field: 'category', value: category } },
    );
  }
  return url;
}

/**
 * @param {unknown} symbol
 * @returns {string}
 * @throws {ConfigurationError}
 */
export function normalizeSymbol(symbol) {
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    throw new ConfigurationError('symbol must be a non-empty string', { details: { field: 'symbol', value: symbol } });
  }
  return symbol.trim().toUpperCase();
}

/** @param {string} symbol */
export function tickerTopic(symbol) {
  return `tickers.${normalizeSymbol(symbol)}`;
}

/** @param {string} symbol @param {number} [depth] */
export function orderbookTopic(symbol, depth = 50) {
  if (!Number.isInteger(depth) || depth <= 0) {
    throw new ConfigurationError('orderbook depth must be a positive integer', {
      details: { field: 'depth', value: depth },
    });
  }
  return `orderbook.${depth}.${normalizeSymbol(symbol)}`;
}

/** @param {string} symbol */
export function tradeTopic(symbol) {
  return `publicTrade.${normalizeSymbol(symbol)}`;
}

/**
 * Parse a public topic into `{ kind, symbol, depth? }`, or null when unknown.
 *
 * @param {unknown} topic
 * @returns {{ kind: 'ticker' | 'orderbook' | 'trade', symbol: string, depth?: number } | null}
 */
export function parsePublicTopic(topic) {
  if (typeof topic !== 'string') return null;
  const parts = topic.split('.');
  if (parts.length === 2 && (parts[0] === 'tickers' || parts[0] === 'publicTrade')) {
    return { kind: parts[0] === 'tickers' ? 'ticker' : 'trade', symbol: parts[1].toUpperCase() };
  }
  if (parts.length === 3 && parts[0] === 'orderbook') {
    const depth = Number(parts[1]);
    if (!Number.isInteger(depth) || depth <= 0) return null;
    return { kind: 'orderbook', symbol: parts[2].toUpperCase(), depth };
  }
  return null;
}
