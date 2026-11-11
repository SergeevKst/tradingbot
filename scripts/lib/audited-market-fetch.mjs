/**
 * Audited fetch for the PAPER smoke harness.
 *
 * The smoke run claims "zero exchange orders issued". A claim like that is worth
 * exactly as much as the mechanism that would make a violation fail, so the
 * market-data adapter is wired to this wrapper instead of the global `fetch`:
 *
 *   - every request is recorded (method, path, query) for the run summary;
 *   - a non-GET method aborts the run;
 *   - any path outside `/v5/market/` aborts the run;
 *   - the private families (`/v5/order`, `/v5/position`, `/v5/account`,
 *     `/v5/asset`) abort the run even if they appear under a market prefix;
 *   - any auth-looking request header aborts the run.
 *
 * The public market path `/v5/market/orderbook` is legitimate; `/v5/order/create`
 * is not. The distinction is by path prefix, not by substring.
 *
 * @module scripts/lib/audited-market-fetch
 */

/** Private Bybit endpoint families that a PAPER run must never touch. */
export const FORBIDDEN_PATH_PREFIXES = Object.freeze([
  '/v5/order',
  '/v5/position',
  '/v5/account',
  '/v5/asset',
]);

/** Header names that would carry (or point at) a credential. */
const FORBIDDEN_HEADER_PATTERN = /bapi|api-key|authorization|sign/i;

/**
 * @param {{ requests: Array<{ method: string, path: string, query: string, at: string }> }} record
 * @param {typeof fetch} [realFetch] transport to delegate to; defaults to the global
 * @param {() => string} [now] clock, injectable for tests
 * @returns {typeof fetch}
 */
export function createAuditedFetch(record, realFetch = globalThis.fetch.bind(globalThis), now = () => new Date().toISOString()) {
  if (record === null || typeof record !== 'object' || !Array.isArray(record.requests)) {
    throw new Error('createAuditedFetch requires a record object with a requests array');
  }

  return async function auditedFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : String(input.url ?? input));
    const method = String(init.method ?? 'GET').toUpperCase();

    record.requests.push({ method, path: url.pathname, query: url.searchParams.toString(), at: now() });

    if (method !== 'GET') {
      throw new Error(`SMOKE ABORT: refusing ${method} ${url.pathname} — PAPER must not write to the exchange`);
    }
    if (!url.pathname.startsWith('/v5/market/')) {
      throw new Error(`SMOKE ABORT: refusing ${url.pathname} — PAPER may only read public market data`);
    }
    for (const prefix of FORBIDDEN_PATH_PREFIXES) {
      if (url.pathname.startsWith(prefix)) {
        throw new Error(`SMOKE ABORT: refusing the private endpoint ${url.pathname}`);
      }
    }

    const headers = init.headers ?? {};
    const headerNames =
      typeof headers.forEach === 'function' && !Array.isArray(headers)
        ? [...(/** @type {Map<string, string>} */ (headers).keys())]
        : Object.keys(headers);
    for (const name of headerNames) {
      if (FORBIDDEN_HEADER_PATTERN.test(String(name))) {
        throw new Error(`SMOKE ABORT: refusing to send the auth header ${name}`);
      }
    }

    return realFetch(input, init);
  };
}
