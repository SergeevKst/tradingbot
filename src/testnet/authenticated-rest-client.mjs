/**
 * Bybit V5 AUTHENTICATED REST client — TESTNET ONLY (MASTER_SPEC Phase 8).
 *
 * Every request is signed and every host is the testnet host. The client cannot
 * be pointed at mainnet: `assertTestnetRestBaseUrl` and `assertTestnetMode` run
 * at construction, and the path allowlist refuses anything that is not a known
 * authenticated testnet endpoint.
 *
 * Non-idempotent writes (create/cancel) are never automatically retried — a
 * replayed create-order is a second order, not a retry (MASTER_SPEC §22). Only
 * reads use the bounded retry policy.
 *
 * @module testnet/authenticated-rest-client
 */
import { AuthenticationError, ConfigurationError, DataError, NetworkError, OrderError, RateLimitError } from '../errors/taxonomy.mjs';
import { retry } from '../market-data/retry.mjs';
import { buildAuthHeaders } from './auth.mjs';
import {
  assertTestnetRestBaseUrl,
  isAllowedTestnetPath,
  isTestnetWritePath,
  TESTNET_PATHS,
} from './endpoints.mjs';
import { assertTestnetMode } from './mode-guard.mjs';
import { mapBybitOrder, toBybitOrderParams } from './order-mapper.mjs';

/** Bybit retCodes that mean "slow down"; safe to retry. */
const RATE_LIMIT_RET_CODES = Object.freeze([10006, 10018]);
/** Bybit retCodes that mean the credential is bad or lacks permission. */
const AUTH_RET_CODES = Object.freeze([10003, 10004, 10005, 33004]);

/**
 * @param {{
 *   testnet?: boolean,
 *   baseUrl?: string,
 *   apiKey?: string,
 *   apiSecret?: string,
 *   category?: string,
 *   recvWindow?: number,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   retry?: object,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   onRetry?: (info: object) => void,
 * }} [options]
 * @returns {object}
 * @throws {ConfigurationError}
 */
export function createBybitTestnetRestClient(options = {}) {
  const baseUrl = assertTestnetRestBaseUrl(options.baseUrl ?? 'https://api-testnet.bybit.com');
  const category = options.category ?? 'linear';
  const recvWindow = options.recvWindow ?? 5000;
  const timeoutMs = options.timeoutMs ?? 15000;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;

  if (typeof fetchImpl !== 'function') {
    throw new ConfigurationError('Testnet REST client requires a fetch implementation', { details: { field: 'fetchImpl' } });
  }

  // Fail closed before any signing can happen: explicit testnet, testnet host,
  // dedicated testnet credentials.
  assertTestnetMode({
    testnet: options.testnet,
    restBaseUrl: baseUrl,
    apiKey: options.apiKey,
    apiSecret: options.apiSecret,
  });

  /**
   * One signed attempt at a path.
   *
   * @param {string} path
   * @param {string} queryString
   * @param {string} body
   * @param {boolean} isWrite
   * @returns {Promise<object>}
   */
  async function attempt(path, queryString, body, isWrite) {
    const isGet = body === '';
    const method = isGet ? 'GET' : 'POST';
    const headers = buildAuthHeaders({
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      method,
      queryString,
      body,
      timestamp: now(),
      recvWindow,
    });
    const url = `${baseUrl}${path}${queryString === '' ? '' : `?${queryString}`}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: isGet ? undefined : body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new NetworkError(`Bybit testnet request failed on ${path}: ${describeTransport(error)}`, {
        details: { path },
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new RateLimitError(`Bybit testnet rate limit reached on ${path}`, { details: { path, status: 429 } });
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError(`Bybit testnet rejected the credential on ${path} (HTTP ${response.status})`, {
        details: { path, status: response.status },
      });
    }
    if (!response.ok) {
      if (response.status >= 500) {
        throw new NetworkError(`Bybit testnet HTTP ${response.status} on ${path}`, { details: { path, status: response.status } });
      }
      throw new DataError(`Bybit testnet request rejected with HTTP ${response.status} on ${path}`, {
        details: { path, status: response.status },
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new DataError(`Bybit testnet returned malformed JSON on ${path}`, { details: { path }, cause: error });
    }
    if (payload === null || typeof payload !== 'object') {
      throw new DataError(`Bybit testnet returned a non-object payload on ${path}`, { details: { path } });
    }
    if (payload.retCode !== 0) {
      const retCode = payload.retCode;
      if (RATE_LIMIT_RET_CODES.includes(retCode)) {
        throw new RateLimitError(`Bybit testnet rate limit reached on ${path}`, { details: { path, retCode } });
      }
      if (AUTH_RET_CODES.includes(retCode)) {
        throw new AuthenticationError(`Bybit testnet credential rejected on ${path} (retCode=${retCode})`, {
          details: { path, retCode },
        });
      }
      // Include retMsg when present — it often contains the actual reason (e.g. missing settleCoin)
      const retMsg = payload.retMsg || '';
      const message = retMsg
        ? `Bybit testnet error retCode=${retCode} on ${path}: ${retMsg}`
        : `Bybit testnet error retCode=${retCode} on ${path}`;

      if (isWrite) {
        throw new OrderError(message, { details: { path, retCode, retMsg } });
      }
      throw new DataError(message, { details: { path, retCode, retMsg } });
    }
    return payload.result ?? {};
  }

  /**
   * @param {string} path
   * @param {{ method?: 'GET' | 'POST', params?: Record<string, unknown>, body?: Record<string, unknown> }} [request]
   * @returns {Promise<object>}
   */
  async function request(path, request = {}) {
    if (!isAllowedTestnetPath(path)) {
      throw new ConfigurationError(`Testnet client refuses path ${JSON.stringify(path)} — not an allowlisted testnet endpoint`, {
        details: { field: 'path', value: path },
      });
    }
    const method = (request.method ?? (request.body === undefined ? 'GET' : 'POST')).toUpperCase();
    const isWrite = isTestnetWritePath(path) || method === 'POST';

    let queryString = '';
    let body = '';
    if (method === 'GET') {
      const params = request.params ?? {};
      queryString = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
    } else {
      body = JSON.stringify(request.body ?? {});
    }

    const run = () => attempt(path, queryString, body, isWrite);
    // Writes are not retried: create/cancel are non-idempotent.
    if (isWrite) return run();

    return retry(run, {
      policy: options.retry,
      sleep: options.sleep,
      random: options.random,
      onRetry: options.onRetry,
      operationName: `${method} ${path}`,
    });
  }

  return Object.freeze({
    baseUrl,
    testnet: /** @type {true} */ (true),
    request,

    /**
     * Place an order. Accepts a domain OrderRequest or raw Bybit params.
     * @param {object} orderRequestOrParams
     */
    async placeOrder(orderRequestOrParams) {
      const looksLikeDomain = orderRequestOrParams !== null && typeof orderRequestOrParams === 'object' && 'type' in orderRequestOrParams && 'side' in orderRequestOrParams;
      const body = looksLikeDomain ? toBybitOrderParams(orderRequestOrParams) : orderRequestOrParams;
      return request(TESTNET_PATHS.orderCreate, { method: 'POST', body: { category, ...body } });
    },

    /** @param {{ symbol: string, orderId?: string, clientOrderId?: string }} params */
    async cancelOrder(params) {
      if (params === null || typeof params !== 'object' || params.symbol === undefined) {
        throw new ConfigurationError('cancelOrder requires a symbol', { details: { field: 'symbol' } });
      }
      if (params.orderId === undefined && params.clientOrderId === undefined) {
        throw new ConfigurationError('cancelOrder requires orderId or clientOrderId', { details: { field: 'orderId' } });
      }
      const body = { category, symbol: params.symbol };
      if (params.orderId !== undefined) body.orderId = params.orderId;
      if (params.clientOrderId !== undefined) body.orderLinkId = params.clientOrderId;
      return request(TESTNET_PATHS.orderCancel, { method: 'POST', body });
    },

    /** @param {{ symbol: string }} params */
    async cancelAllOrders(params) {
      if (params === null || typeof params !== 'object' || params.symbol === undefined) {
        throw new ConfigurationError('cancelAllOrders requires a symbol', { details: { field: 'symbol' } });
      }
      return request(TESTNET_PATHS.orderCancelAll, { method: 'POST', body: { category, symbol: params.symbol } });
    },

    /**
     * Query one order and return it as a validated domain Order.
     * @param {{ symbol: string, orderId?: string, clientOrderId?: string }} params
     */
    async getOrder(params) {
      if (params === null || typeof params !== 'object' || params.symbol === undefined) {
        throw new ConfigurationError('getOrder requires a symbol', { details: { field: 'symbol' } });
      }
      const query = { category, symbol: params.symbol };
      if (params.orderId !== undefined) query.orderId = params.orderId;
      if (params.clientOrderId !== undefined) query.orderLinkId = params.clientOrderId;
      const result = await request(TESTNET_PATHS.orderRealtime, { method: 'GET', params: query });
      const first = Array.isArray(result.list) ? result.list[0] : undefined;
      if (first === undefined) {
        throw new DataError('Bybit testnet returned no order for getOrder', { details: { symbol: params.symbol } });
      }
      return mapBybitOrder(first);
    },

    /** @param {{ symbol?: string }} [params] */
    async getOpenOrders(params = {}) {
      const query = { category };
      if (params.symbol !== undefined) query.symbol = params.symbol;
      return request(TESTNET_PATHS.orderRealtime, { method: 'GET', params: query });
    },

    /** @param {{ symbol?: string }} [params] */
    async getPositions(params = {}) {
      const query = { category };
      if (params.symbol !== undefined) {
        query.symbol = params.symbol;
      } else if (category === 'linear') {
        // Classic accounts (unified: 0) require settleCoin when listing all positions
        query.settleCoin = 'USDT';
      }
      return request(TESTNET_PATHS.positionList, { method: 'GET', params: query });
    },

    /** @param {{ accountType?: string }} [params] */
    async getWalletBalance(params = {}) {
      return request(TESTNET_PATHS.walletBalance, {
        method: 'GET',
        params: { accountType: params.accountType ?? 'UNIFIED' },
      });
    },
  });
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeTransport(error) {
  if (error && typeof error === 'object' && /** @type {any} */ (error).name === 'AbortError') return 'timeout';
  if (error instanceof Error && error.message !== '') return error.message;
  return 'network failure';
}
