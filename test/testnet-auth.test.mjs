/**
 * Phase 8 testnet signing tests.
 *
 * Signatures are recomputed with node:crypto against fixed inputs, so the tests
 * pin the exact V5 message layout without any network or real credential. They
 * also assert that no secret ever appears in a header or an error message.
 */
import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { ConfigurationError } from '../src/errors/taxonomy.mjs';
import {
  buildAuthHeaders,
  buildWebSocketAuthMessage,
  signRequest,
  signWebSocketAuth,
} from '../src/testnet/auth.mjs';

const API_KEY = 'TESTNET-KEY-abc';
const API_SECRET = 'TESTNET-SECRET-xyz';
const TS = 1_700_000_000_123;
const RECV = 5000;

function hmac(payload) {
  return createHmac('sha256', API_SECRET).update(payload).digest('hex');
}

test('AUTH: signRequest follows the V5 message layout for GET query strings', () => {
  const query = 'category=linear&symbol=BTCUSDT';
  const signature = signRequest({ apiSecret: API_SECRET, apiKey: API_KEY, timestamp: TS, recvWindow: RECV, payload: query });
  assert.equal(signature, hmac(`${TS}${API_KEY}${RECV}${query}`));
});

test('AUTH: signRequest signs the raw body for POST requests', () => {
  const body = JSON.stringify({ category: 'linear', symbol: 'BTCUSDT' });
  const signature = signRequest({ apiSecret: API_SECRET, apiKey: API_KEY, timestamp: TS, recvWindow: RECV, payload: body });
  assert.equal(signature, hmac(`${TS}${API_KEY}${RECV}${body}`));
});

test('AUTH: buildAuthHeaders selects query (GET) or body (POST) as the signed payload and leaks no secret', () => {
  const query = 'category=linear&symbol=BTCUSDT';
  const getHeaders = buildAuthHeaders({ apiKey: API_KEY, apiSecret: API_SECRET, method: 'GET', queryString: query, timestamp: TS, recvWindow: RECV });
  assert.equal(getHeaders['X-BAPI-API-KEY'], API_KEY);
  assert.equal(getHeaders['X-BAPI-TIMESTAMP'], String(TS));
  assert.equal(getHeaders['X-BAPI-RECV-WINDOW'], String(RECV));
  assert.equal(getHeaders['X-BAPI-SIGN'], hmac(`${TS}${API_KEY}${RECV}${query}`));

  const body = '{"a":1}';
  const postHeaders = buildAuthHeaders({ apiKey: API_KEY, apiSecret: API_SECRET, method: 'POST', body, timestamp: TS, recvWindow: RECV });
  assert.equal(postHeaders['X-BAPI-SIGN'], hmac(`${TS}${API_KEY}${RECV}${body}`));
  assert.equal(postHeaders['content-type'], 'application/json');

  assert.ok(!JSON.stringify(getHeaders).includes(API_SECRET), 'the secret must never appear in headers');
  assert.ok(!JSON.stringify(postHeaders).includes(API_SECRET));
});

test('AUTH: missing credentials fail closed without echoing the secret', () => {
  assert.throws(() => signRequest({ apiSecret: '', apiKey: API_KEY, timestamp: TS, payload: '' }), ConfigurationError);
  assert.throws(() => buildAuthHeaders({ apiKey: '', apiSecret: API_SECRET, timestamp: TS }), ConfigurationError);

  try {
    buildAuthHeaders({ apiKey: API_KEY, apiSecret: '', timestamp: TS });
  } catch (error) {
    assert.ok(!String(error.message).includes(API_SECRET));
    assert.ok(!JSON.stringify(error.details ?? {}).includes(API_SECRET));
  }
});

test('AUTH: WebSocket auth signs GET/realtime<expires>', () => {
  const expires = TS + 10000;
  assert.equal(signWebSocketAuth({ apiKey: API_KEY, apiSecret: API_SECRET, expires }), hmac(`GET/realtime${expires}`));

  const message = buildWebSocketAuthMessage({ apiKey: API_KEY, apiSecret: API_SECRET, now: TS });
  assert.equal(message.op, 'auth');
  assert.equal(message.args[0], API_KEY);
  assert.equal(message.args[1], TS + 10000);
  assert.equal(message.args[2], hmac(`GET/realtime${TS + 10000}`));
  assert.ok(!JSON.stringify(message).includes(API_SECRET), 'the secret must never appear in the auth frame');
});

test('AUTH: a non-integer expiry is a configuration error', () => {
  assert.throws(() => signWebSocketAuth({ apiKey: API_KEY, apiSecret: API_SECRET, expires: 1.5 }), ConfigurationError);
});
