/**
 * Bybit TESTNET-only endpoint definitions (MASTER_SPEC Phase 8).
 *
 * Every path and host in this module is authenticated and testnet-only. The
 * mainnet hosts are named solely so the guards in this layer can recognise and
 * refuse them; nothing here ever builds a mainnet URL.
 *
 * Keeping the authenticated paths out of `adapters/bybit/endpoints.mjs` means
 * the public market-data module stays credential-free and cannot reach an order
 * endpoint, and the testnet boundary is one directory.
 *
 * @module testnet/endpoints
 */
import { ConfigurationError } from '../errors/taxonomy.mjs';

/** The only REST host the authenticated testnet layer may talk to. */
export const TESTNET_REST_BASE_URL = 'https://api-testnet.bybit.com';

/** Recognised only so it can be refused. Never returned by a resolver. */
export const MAINNET_REST_BASE_URL = 'https://api.bybit.com';

/** The only private WebSocket host the testnet layer may talk to. */
export const TESTNET_PRIVATE_WS_URL = 'wss://stream-testnet.bybit.com/v5/private';

/** Recognised only so it can be refused. Never returned by a resolver. */
export const MAINNET_PRIVATE_WS_URL = 'wss://stream.bybit.com/v5/private';

/**
 * Authenticated testnet REST paths. This is an allowlist: an unlisted path is
 * refused before any signature is built.
 */
export const TESTNET_PATHS = Object.freeze({
  orderCreate: '/v5/order/create',
  orderCancel: '/v5/order/cancel',
  orderCancelAll: '/v5/order/cancel-all',
  orderRealtime: '/v5/order/realtime',
  orderHistory: '/v5/order/history',
  executionList: '/v5/execution/list',
  positionList: '/v5/position/list',
  walletBalance: '/v5/account/wallet-balance',
});

/** Paths that change exchange state and must never be blindly retried. */
export const TESTNET_WRITE_PATHS = Object.freeze([TESTNET_PATHS.orderCreate, TESTNET_PATHS.orderCancel, TESTNET_PATHS.orderCancelAll]);

const ALLOWED_PATHS = new Set(Object.values(TESTNET_PATHS));
const WRITE_PATHS = new Set(TESTNET_WRITE_PATHS);

/** @param {unknown} path */
export function isAllowedTestnetPath(path) {
  return typeof path === 'string' && ALLOWED_PATHS.has(path);
}

/** @param {unknown} path */
export function isTestnetWritePath(path) {
  return typeof path === 'string' && WRITE_PATHS.has(path);
}

/**
 * Normalize and validate a REST base URL, refusing anything that is not the
 * single known testnet host. Mainnet and arbitrary hosts fail closed.
 *
 * @param {unknown} baseUrl
 * @returns {string} the URL without a trailing slash
 * @throws {ConfigurationError}
 */
export function assertTestnetRestBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new ConfigurationError('Testnet baseUrl must be a non-empty string', {
      details: { field: 'baseUrl', value: baseUrl },
    });
  }
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (normalized !== TESTNET_REST_BASE_URL) {
    throw new ConfigurationError(
      `The authenticated layer is TESTNET ONLY; baseUrl must be ${TESTNET_REST_BASE_URL} — got ${JSON.stringify(baseUrl)}`,
      { details: { field: 'baseUrl', value: baseUrl } },
    );
  }
  return normalized;
}

/**
 * Resolve the private WebSocket URL, testnet only.
 *
 * @param {{ testnet?: boolean }} [options]
 * @returns {string}
 * @throws {ConfigurationError} when testnet mode is not explicitly true
 */
export function resolveTestnetPrivateWsUrl(options = {}) {
  if (options.testnet !== true) {
    throw new ConfigurationError('The private WebSocket is TESTNET ONLY and requires testnet=true', {
      details: { field: 'testnet', value: options.testnet },
    });
  }
  return TESTNET_PRIVATE_WS_URL;
}
