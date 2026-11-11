/**
 * The smoke harness's zero-order claim is only as strong as the wrapper that
 * enforces it, so the wrapper is tested directly: a write, a non-market path, a
 * private endpoint or an auth header must abort the run, not pass silently.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createAuditedFetch, FORBIDDEN_PATH_PREFIXES } from '../scripts/lib/audited-market-fetch.mjs';

/** A transport stub that records what actually reached the network. */
function transport() {
  const calls = [];
  const impl = async (input, init) => {
    calls.push({ input, init });
    return { ok: true };
  };
  return { calls, impl };
}

function harness() {
  const record = { requests: [] };
  const net = transport();
  const fetchImpl = createAuditedFetch(record, net.impl, () => '2026-03-15T12:00:00.000Z');
  return { record, net, fetchImpl };
}

test('AUDIT FETCH: a public market GET is recorded and forwarded', async () => {
  const { record, net, fetchImpl } = harness();

  await fetchImpl('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT');

  assert.equal(net.calls.length, 1, 'the request reached the transport');
  assert.deepEqual(record.requests, [
    { method: 'GET', path: '/v5/market/tickers', query: 'category=linear&symbol=BTCUSDT', at: '2026-03-15T12:00:00.000Z' },
  ]);
});

test('AUDIT FETCH: /v5/market/orderbook is a legitimate public read', async () => {
  const { fetchImpl, net } = harness();
  await fetchImpl('https://api.bybit.com/v5/market/orderbook?category=linear&symbol=BTCUSDT');
  assert.equal(net.calls.length, 1);
});

test('AUDIT FETCH: a write method aborts before touching the network', async () => {
  const { fetchImpl, net, record } = harness();

  await assert.rejects(
    () => fetchImpl('https://api.bybit.com/v5/market/tickers', { method: 'POST', body: '{}' }),
    /SMOKE ABORT: refusing POST/,
  );
  assert.equal(net.calls.length, 0, 'nothing reached the transport');
  assert.equal(record.requests.length, 1, 'the attempt is still recorded for the run summary');
});

test('AUDIT FETCH: every private endpoint family is refused', async () => {
  for (const prefix of FORBIDDEN_PATH_PREFIXES) {
    const { fetchImpl, net } = harness();
    await assert.rejects(() => fetchImpl(`https://api.bybit.com${prefix}/create`, { method: 'GET' }), /SMOKE ABORT/);
    assert.equal(net.calls.length, 0, `${prefix} must never reach the network`);
  }
});

test('AUDIT FETCH: a path outside /v5/market/ is refused', async () => {
  const { fetchImpl, net } = harness();
  await assert.rejects(() => fetchImpl('https://api.bybit.com/v5/user/query-api'), /may only read public market data/);
  assert.equal(net.calls.length, 0);
});

test('AUDIT FETCH: auth-looking headers are refused', async () => {
  for (const name of ['X-BAPI-API-KEY', 'Authorization', 'X-BAPI-SIGN', 'api-key']) {
    const { fetchImpl, net } = harness();
    await assert.rejects(
      () => fetchImpl('https://api.bybit.com/v5/market/tickers', { headers: { [name]: 'secret' } }),
      /refusing to send the auth header/,
    );
    assert.equal(net.calls.length, 0);
  }
});

test('AUDIT FETCH: a plain Accept header is allowed', async () => {
  const { fetchImpl, net } = harness();
  await fetchImpl('https://api.bybit.com/v5/market/tickers', { headers: { Accept: 'application/json' } });
  assert.equal(net.calls.length, 1);
});

test('AUDIT FETCH: the record argument is required', () => {
  assert.throws(() => createAuditedFetch(null), /requires a record object/);
  assert.throws(() => createAuditedFetch({}), /requires a record object/);
});
