/**
 * Bybit public REST client.
 *
 * Read-only by construction: every request is a `GET` to a `/v5/market/*`
 * public endpoint, there is no signing code and no credential is ever read.
 *
 * Failures are classified with the §22 taxonomy instead of a single config
 * error:
 *   - transport failure / timeout / HTTP 5xx  -> NetworkError   (retryable)
 *   - HTTP 429 / Bybit rate-limit retCode     -> RateLimitError (retryable)
 *   - HTTP 4xx / malformed JSON / retCode != 0 -> DataError      (not retryable)
 *
 * Retry uses the explicit `retry()` policy, so only the retryable classes are
 * replayed, with bounded attempts and backoff (§23–24).
 *
 * @module adapters/bybit/rest-client
 */
import { ConfigurationError, DataError, NetworkError, RateLimitError } from '../../errors/taxonomy.mjs';
import { retry } from '../../market-data/retry.mjs';
import { assertBybitRestBaseUrl } from './endpoints.mjs';

/** Bybit retCodes that mean "slow down"; retrying after a backoff is safe. */
const RATE_LIMIT_RET_CODES = Object.freeze([10006, 10018]);

/**
 * @param {{
 *   baseUrl?: string,
 *   category?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   retry?: object,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   onRetry?: (info: object) => void,
 * }} [options]
 * @returns {{ baseUrl: string, category: string, request: (path: string, params?: Record<string, string | number>) => Promise<object> }}
 */
export function createBybitRestClient(options = {}) {
  const baseUrl = assertBybitRestBaseUrl(options.baseUrl ?? 'https://api.bybit.com');
  const category = options.category ?? 'linear';
  const timeoutMs = options.timeoutMs ?? 15000;
  // Only an omitted value falls back to the global. An explicit null must fail
  // closed rather than silently using whatever the runtime happens to provide.
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;

  if (typeof fetchImpl !== 'function') {
    throw new ConfigurationError('Bybit REST client requires a fetch implementation', {
      details: { field: 'fetchImpl' },
    });
  }

  /**
   * One attempt: GET, classify, parse.
   *
   * @param {string} path
   * @param {string} url
   * @returns {Promise<object>}
   */
  async function attempt(path, url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      throw new NetworkError(`Bybit market data request failed on ${path}: ${describeTransport(error)}`, {
        details: { path },
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new RateLimitError(`Bybit rate limit reached on ${path}`, { details: { path, status: 429 } });
    }
    if (!response.ok) {
      if (response.status >= 500) {
        throw new NetworkError(`Bybit market data HTTP ${response.status} on ${path}`, {
          details: { path, status: response.status },
        });
      }
      throw new DataError(`Bybit market data request rejected with HTTP ${response.status} on ${path}`, {
        details: { path, status: response.status },
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new DataError(`Bybit market data returned malformed JSON on ${path}`, { details: { path }, cause: error });
    }

    if (payload === null || typeof payload !== 'object') {
      throw new DataError(`Bybit market data returned a non-object payload on ${path}`, { details: { path } });
    }
    if (payload.retCode !== 0) {
      const retCode = payload.retCode;
      if (RATE_LIMIT_RET_CODES.includes(retCode)) {
        throw new RateLimitError(`Bybit rate limit reached on ${path}`, { details: { path, retCode } });
      }
      // retMsg is intentionally not echoed: exchange prose can contain arbitrary
      // text, and the stable retCode is what callers branch on.
      throw new DataError(`Bybit market data error retCode=${retCode} on ${path}`, { details: { path, retCode } });
    }

    return payload.result ?? {};
  }

  /**
   * @param {string} path
   * @param {Record<string, string | number>} [params]
   * @returns {Promise<object>}
   */
  async function request(path, params = {}) {
    if (typeof path !== 'string' || !path.startsWith('/v5/market/')) {
      throw new ConfigurationError(`Bybit REST client refuses non-market path ${JSON.stringify(path)}`, {
        details: { field: 'path', value: path },
      });
    }
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
    const url = `${baseUrl}${path}${query === '' ? '' : `?${query}`}`;

    return retry(() => attempt(path, url), {
      policy: options.retry,
      sleep: options.sleep,
      random: options.random,
      onRetry: options.onRetry,
      operationName: `GET ${path}`,
    });
  }

  return Object.freeze({ baseUrl, category, request });
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
