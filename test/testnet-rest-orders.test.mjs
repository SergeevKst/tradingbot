/**
 * Phase 8 authenticated testnet REST order tests.
 *
 * Every network call is mocked and every signature is recomputed from the
 * captured request, so place/cancel/query are exercised end-to-end without a
 * credential and without a socket. The tests also pin the fail-closed guards:
 * no mainnet host, no anonymous client, no unlisted path, no retry of writes.
 */
import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { AuthenticationError, ConfigurationError, DataError, NetworkError, OrderError } from '../src/errors/taxonomy.mjs';
import { createOrderRequest } from '../src/domain/order.mjs';
import { createBybitTestnetRestClient } from '../src/testnet/authenticated-rest-client.mjs';

const API_KEY = 'TESTNET-KEY-abc';
const API_SECRET = 'TESTNET-SECRET-xyz';
const TS = 1_700_000_000_123;
const RECV = 5000;
const TESTNET_URL = 'https://api-testnet.bybit.com';

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function recordingFetch(resolver) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return resolver(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function makeClient(overrides = {}) {
  return createBybitTestnetRestClient({
    testnet: true,
    baseUrl: TESTNET_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    now: () => TS,
    recvWindow: RECV,
    ...overrides,
  });
}

function expectedSignature(payload) {
  return createHmac('sha256', API_SECRET).update(`${TS}${API_KEY}${RECV}${payload}`).digest('hex');
}

test('REST-ORDERS: a mainnet host is refused at construction', () => {
  assert.throws(() => makeClient({ baseUrl: 'https://api.bybit.com' }), ConfigurationError);
  assert.throws(() => makeClient({ baseUrl: 'https://evil.example' }), ConfigurationError);
});

test('REST-ORDERS: testnet mode and dedicated credentials are required at construction', () => {
  assert.throws(() => makeClient({ testnet: false }), ConfigurationError);
  assert.throws(() => makeClient({ testnet: undefined }), ConfigurationError);
  assert.throws(() => makeClient({ apiKey: undefined }), ConfigurationError);
  assert.throws(() => makeClient({ apiSecret: undefined }), ConfigurationError);
});

test('REST-ORDERS: a production-only environment cannot build a testnet client', () => {
  // Mirrors the credential isolation: the constructor is handed no testnet pair.
  assert.throws(
    () => createBybitTestnetRestClient({ testnet: true, baseUrl: TESTNET_URL, apiKey: undefined, apiSecret: undefined }),
    ConfigurationError,
  );
});

test('REST-ORDERS: placeOrder POSTs a signed body to the testnet order endpoint', async () => {
  const fetchImpl = recordingFetch(() => response({ retCode: 0, result: { orderId: 'o-1', orderLinkId: 'cid-1' } }));
  const client = makeClient({ fetchImpl });

  const request = createOrderRequest({
    symbol: 'BTCUSDT',
    side: 'LONG',
    type: 'LIMIT',
    quantity: 0.01,
    price: 50000,
    clientOrderId: 'cid-1',
    timestamp: TS,
  });
  const result = await client.placeOrder(request);

  assert.equal(result.orderId, 'o-1');
  const call = fetchImpl.calls[0];
  assert.equal(call.init.method, 'POST');
  assert.equal(call.url, `${TESTNET_URL}/v5/order/create`);
  const body = JSON.parse(call.init.body);
  assert.equal(body.category, 'linear');
  assert.equal(body.symbol, 'BTCUSDT');
  assert.equal(body.side, 'Buy');
  assert.equal(body.orderType, 'Limit');
  assert.equal(body.qty, '0.01');
  assert.equal(body.price, '50000');
  assert.equal(call.init.headers['X-BAPI-SIGN'], expectedSignature(call.init.body), 'the POST signature must cover the body');
  assert.ok(!JSON.stringify(call.init.headers).includes(API_SECRET), 'no secret may be transmitted');
});

test('REST-ORDERS: raw Bybit params pass through placeOrder unchanged', async () => {
  const fetchImpl = recordingFetch(() => response({ retCode: 0, result: { orderId: 'o-2' } }));
  const client = makeClient({ fetchImpl });
  await client.placeOrder({ symbol: 'ETHUSDT', side: 'Sell', orderType: 'Market', qty: '0.5', timeInForce: 'IOC' });
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.side, 'Sell');
  assert.equal(body.orderType, 'Market');
});

test('REST-ORDERS: cancelOrder POSTs a signed body and validates its arguments', async () => {
  const fetchImpl = recordingFetch(() => response({ retCode: 0, result: { orderId: 'o-1' } }));
  const client = makeClient({ fetchImpl });

  await client.cancelOrder({ symbol: 'BTCUSDT', orderId: 'o-1' });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${TESTNET_URL}/v5/order/cancel`);
  assert.equal(JSON.parse(call.init.body).orderId, 'o-1');
  assert.equal(call.init.headers['X-BAPI-SIGN'], expectedSignature(call.init.body));

  await assert.rejects(() => client.cancelOrder({ orderId: 'o-1' }), ConfigurationError);
  await assert.rejects(() => client.cancelOrder({ symbol: 'BTCUSDT' }), ConfigurationError);
});

test('REST-ORDERS: getOrder GETs a signed query and returns a domain Order', async () => {
  const fetchImpl = recordingFetch(() =>
    response({
      retCode: 0,
      result: {
        list: [
          {
            orderId: 'o-1',
            orderLinkId: '',
            symbol: 'BTCUSDT',
            side: 'Buy',
            orderType: 'Limit',
            orderStatus: 'New',
            qty: '0.01',
            cumExecQty: '0',
            price: '50000',
            avgPrice: '',
            timeInForce: 'GTC',
            createdTime: TS,
            updatedTime: TS,
          },
        ],
      },
    }),
  );
  const client = makeClient({ fetchImpl });
  const order = await client.getOrder({ symbol: 'BTCUSDT', orderId: 'o-1' });

  assert.equal(order.orderId, 'o-1');
  assert.equal(order.status, 'NEW');
  const call = fetchImpl.calls[0];
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.body, undefined);
  const query = new URL(call.url).searchParams.toString();
  assert.equal(call.init.headers['X-BAPI-SIGN'], expectedSignature(query), 'the GET signature must cover the query string');
  assert.ok(!JSON.stringify(call.init.headers).includes(API_SECRET));
});

test('REST-ORDERS: an unlisted path is refused before any request', async () => {
  const fetchImpl = recordingFetch(() => response({ retCode: 0, result: {} }));
  const client = makeClient({ fetchImpl });
  await assert.rejects(() => client.request('/v5/asset/transfer'), ConfigurationError);
  await assert.rejects(() => client.request('/v5/order/create-extra'), ConfigurationError);
  assert.equal(fetchImpl.calls.length, 0, 'a refused path must not reach the network');
});

test('REST-ORDERS: a write failure is a non-retryable OrderError; a read failure is a DataError', async () => {
  const badWrite = recordingFetch(() => response({ retCode: 110007, retMsg: 'insufficient balance' }));
  await assert.rejects(() => makeClient({ fetchImpl: badWrite, retry: { attempts: 3 } }).placeOrder({ symbol: 'BTCUSDT' }), OrderError);
  assert.equal(badWrite.calls.length, 1, 'writes must never be retried');

  const badRead = recordingFetch(() => response({ retCode: 10001, retMsg: 'params error' }));
  await assert.rejects(() => makeClient({ fetchImpl: badRead, retry: { attempts: 3 } }).getOpenOrders({ symbol: 'BTCUSDT' }), DataError);
  assert.equal(badRead.calls.length, 1, 'a data error is not retryable');
});

test('REST-ORDERS: auth retCodes and HTTP 401 become AuthenticationError', async () => {
  const retCodeClient = makeClient({ fetchImpl: recordingFetch(() => response({ retCode: 10003, retMsg: 'invalid api key' })) });
  await assert.rejects(() => retCodeClient.getOpenOrders(), AuthenticationError);

  const httpClient = makeClient({ fetchImpl: recordingFetch(() => response({ retCode: 0 }, 401)) });
  await assert.rejects(() => httpClient.getOpenOrders(), AuthenticationError);
});

test('REST-ORDERS: a transport failure and HTTP 5xx are retryable NetworkErrors for reads', async () => {
  const failing = recordingFetch(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(() => makeClient({ fetchImpl: failing, retry: { attempts: 2 } }).getOpenOrders(), NetworkError);
  assert.equal(failing.calls.length, 2, 'a retryable read must be retried');

  const calls = [];
  const flaky = async (url) => {
    calls.push(url);
    return calls.length === 1 ? response({ retCode: 0 }, 503) : response({ retCode: 0, result: {} });
  };
  await makeClient({ fetchImpl: flaky, retry: { attempts: 2 }, sleep: async () => {}, random: () => 0.5 }).getOpenOrders();
  assert.equal(calls.length, 2);
});

test('REST-ORDERS: rate-limit retCodes are retried for reads', async () => {
  const calls = [];
  const fetchImpl = async () => {
    calls.push(1);
    return calls.length === 1 ? response({ retCode: 10006, retMsg: 'too many visits' }) : response({ retCode: 0, result: { list: [] } });
  };
  const result = await makeClient({ fetchImpl, retry: { attempts: 3 }, sleep: async () => {}, random: () => 0.5 }).getOpenOrders();
  assert.deepEqual(result, { list: [] });
  assert.equal(calls.length, 2);
});

test('REST-ORDERS: getOrder with no matching order is a DataError', async () => {
  const client = makeClient({ fetchImpl: recordingFetch(() => response({ retCode: 0, result: { list: [] } })) });
  await assert.rejects(() => client.getOrder({ symbol: 'BTCUSDT', orderId: 'missing' }), DataError);
});
