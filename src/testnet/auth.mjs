/**
 * Bybit V5 request signing for the TESTNET layer (MASTER_SPEC Phase 8).
 *
 * Pure, dependency-light HMAC-SHA256 signing. It is deliberately separate from
 * any transport: the module never performs I/O and never returns secret
 * material, so a caller cannot log a signature builder's inputs by accident.
 *
 * The V5 scheme signs `timestamp + apiKey + recvWindow + payload`, where the
 * payload is the query string for GET and the raw JSON body for POST. Private
 * WebSocket auth signs `GET/realtime${expires}`.
 *
 * @module testnet/auth
 */
import { createHmac } from 'node:crypto';

import { ConfigurationError } from '../errors/taxonomy.mjs';

/** Default receive window; Bybit rejects a signature outside it. */
export const DEFAULT_RECV_WINDOW_MS = 5000;

/** How long a private WebSocket auth signature stays valid. */
export const WS_AUTH_WINDOW_MS = 10000;

/**
 * @param {unknown} apiKey
 * @param {unknown} apiSecret
 * @returns {{ apiKey: string, apiSecret: string }}
 * @throws {ConfigurationError}
 */
function requireCredentials(apiKey, apiSecret) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new ConfigurationError('Testnet apiKey must be a non-empty string', { details: { field: 'apiKey' } });
  }
  if (typeof apiSecret !== 'string' || apiSecret.trim() === '') {
    // Never echo the secret — not even an empty-string representation of it.
    throw new ConfigurationError('Testnet apiSecret must be a non-empty string', { details: { field: 'apiSecret' } });
  }
  return { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() };
}

/**
 * @param {{
 *   apiSecret: string,
 *   timestamp: number | string,
 *   apiKey: string,
 *   recvWindow?: number | string,
 *   payload?: string,
 * }} params
 * @returns {string} lowercase hex HMAC-SHA256 signature
 * @throws {ConfigurationError}
 */
export function signRequest(params) {
  const { apiSecret } = requireCredentials(params.apiKey, params.apiSecret);
  const timestamp = params.timestamp;
  const recvWindow = params.recvWindow ?? DEFAULT_RECV_WINDOW_MS;
  const payload = params.payload ?? '';

  if ((typeof timestamp !== 'number' && typeof timestamp !== 'string') || String(timestamp).trim() === '') {
    throw new ConfigurationError('signRequest requires a timestamp', { details: { field: 'timestamp' } });
  }
  if (typeof payload !== 'string') {
    throw new ConfigurationError('signRequest payload must be a string', { details: { field: 'payload' } });
  }

  const message = `${timestamp}${params.apiKey}${recvWindow}${payload}`;
  return createHmac('sha256', apiSecret).update(message).digest('hex');
}

/**
 * Build the authenticated headers for a REST request. The secret never appears
 * in the returned object.
 *
 * @param {{
 *   apiKey: string,
 *   apiSecret: string,
 *   method?: 'GET' | 'POST',
 *   queryString?: string,
 *   body?: string,
 *   timestamp: number,
 *   recvWindow?: number,
 * }} params
 * @returns {Readonly<Record<string, string>>}
 * @throws {ConfigurationError}
 */
export function buildAuthHeaders(params) {
  const { apiKey } = requireCredentials(params.apiKey, params.apiSecret);
  const method = (params.method ?? 'GET').toUpperCase();
  const queryString = params.queryString ?? '';
  const body = params.body ?? '';
  const recvWindow = params.recvWindow ?? DEFAULT_RECV_WINDOW_MS;

  // GET signs the query string; POST signs the body. Signing the wrong field is
  // a silent auth failure at the exchange, so pick explicitly.
  const payload = method === 'GET' ? queryString : body;
  const signature = signRequest({
    apiSecret: params.apiSecret,
    timestamp: params.timestamp,
    apiKey,
    recvWindow,
    payload,
  });

  /** @type {Record<string, string>} */
  const headers = {
    'X-BAPI-API-KEY': apiKey,
    'X-BAPI-TIMESTAMP': String(params.timestamp),
    'X-BAPI-RECV-WINDOW': String(recvWindow),
    'X-BAPI-SIGN': signature,
    accept: 'application/json',
  };
  if (method === 'POST') headers['content-type'] = 'application/json';
  return Object.freeze(headers);
}

/**
 * Compute the private WebSocket auth signature.
 *
 * @param {{ apiSecret: string, apiKey: string, expires: number }} params
 * @returns {string} lowercase hex signature over `GET/realtime${expires}`
 * @throws {ConfigurationError}
 */
export function signWebSocketAuth(params) {
  const { apiSecret } = requireCredentials(params.apiKey, params.apiSecret);
  if (!Number.isInteger(params.expires) || params.expires <= 0) {
    throw new ConfigurationError('WebSocket auth requires positive integer expires (epoch ms)', {
      details: { field: 'expires', value: params.expires },
    });
  }
  return createHmac('sha256', apiSecret).update(`GET/realtime${params.expires}`).digest('hex');
}

/**
 * Build the `{ op: 'auth', args: [...] }` payload the private stream expects.
 *
 * @param {{ apiKey: string, apiSecret: string, now: number, windowMs?: number }} params
 * @returns {{ op: 'auth', args: readonly [string, number, string] }}
 * @throws {ConfigurationError}
 */
export function buildWebSocketAuthMessage(params) {
  const { apiKey } = requireCredentials(params.apiKey, params.apiSecret);
  if (!Number.isInteger(params.now) || params.now <= 0) {
    throw new ConfigurationError('WebSocket auth requires positive integer now (epoch ms)', {
      details: { field: 'now', value: params.now },
    });
  }
  const windowMs = params.windowMs ?? WS_AUTH_WINDOW_MS;
  const expires = params.now + windowMs;
  const signature = signWebSocketAuth({ apiKey, apiSecret: params.apiSecret, expires });
  return Object.freeze({ op: 'auth', args: Object.freeze([apiKey, expires, signature]) });
}
