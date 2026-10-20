/**
 * Phase 2 REST adapter tests.
 *
 * All network I/O is mocked: `fetchImpl` is a router over canned Bybit payloads.
 * The tests pin the taxonomy mapping (429/5xx -> retryable, retCode -> data
 * error), the no-credentials GET-only contract, and normalization into domain
 * types. No credentials and no live endpoint are involved.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ConfigurationError, DataError, NetworkError, RateLimitError } from '../src/errors/taxonomy.mjs';
import { createBybitRestMarketDataAdapter } from '../src/adapters/bybit/rest-market-data-adapter.mjs';
import { createBybitRestClient } from '../src/adapters/bybit/rest-client.mjs';

const FIXED_NOW = 1_700_000_000_000;

const SUCCESS = Object.freeze({
  instruments: {
    retCode: 0,
    result: {
      list: [
        {
          symbol: 'BTCUSDT',
          status: 'Trading',
          baseCoin: 'BTC',
          quoteCoin: 'USDT',
          settleCoin: 'USDT',
          priceFilter: { tickSize: '0.1' },
          lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '1500', minNotionalValue: '5' },
          leverageFilter: { maxLeverage: '150' },
        },
      ],
    },
  },
  tickers: {
    retCode: 0,
    result: {
      list: [{ symbol: 'BTCUSDT', lastPrice: '86000.1', markPrice: '86000', bid1Price: '85999.9', ask1Price: '86000.2', volume24h: '123' }],
    },
  },
  orderbook: { retCode: 0, result: { s: 'BTCUSDT', b: [['85999.9', '1']], a: [['86000.2', '1']], ts: FIXED_NOW, u: 7 } },
  kline: { retCode: 0, result: { list: [['1699999999000', '10', '12', '9', '11', '5', '55']] } },
});

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function route(url) {
  if (url.includes('/instruments-info')) return SUCCESS.instruments;
  if (url.includes('/tickers')) return SUCCESS.tickers;
  if (url.includes('/orderbook')) return SUCCESS.orderbook;
  if (url.includes('/kline')) return SUCCESS.kline;
  throw new Error(`unexpected URL ${url}`);
}

function recordingFetch(resolver) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return resolver(url, calls.length);
  };
  impl.calls = calls;
  return impl;
}

test('REST: an unknown base URL is refused at construction', () => {
  assert.throws(
    () => createBybitRestMarketDataAdapter({ baseUrl: 'https://evil.example', fetchImpl: async () => response({}) }),
    ConfigurationError,
  );
  assert.throws(() => createBybitRestClient({ baseUrl: 'http://localhost:1', fetchImpl: async () => response({}) }), ConfigurationError);
});

test('REST: the client only calls public /v5/market paths over GET', async () => {
  const fetchImpl = recordingFetch(() => response({ retCode: 0, result: {} }));
  const client = createBybitRestClient({ fetchImpl, baseUrl: 'https://api.bybit.com' });

  await client.request('/v5/market/tickers', { category: 'linear', symbol: 'BTCUSDT' });
  assert.equal(fetchImpl.calls[0].init.method, 'GET');

  const headers = JSON.stringify(fetchImpl.calls[0].init.headers ?? {});
  assert.ok(!/authorization|signature|x-bapi/i.test(headers), 'public market data must send no auth header');

  await assert.rejects(() => client.request('/v5/asset/coins'), ConfigurationError);
});

test('REST: a ticker, orderbook and candles normalize into domain types', async () => {
  const fetchImpl = recordingFetch((url) => response(route(url)));
  const adapter = createBybitRestMarketDataAdapter({ fetchImpl, now: () => FIXED_NOW });

  const tick = await adapter.getTicker('btcusdt');
  assert.equal(tick.symbol, 'BTCUSDT');
  assert.equal(tick.price, 86000.1);
  assert.equal(tick.bid, 85999.9);
  assert.equal(tick.timestamp, FIXED_NOW);

  const orderbook = await adapter.getOrderbook('BTCUSDT', 1);
  assert.deepEqual([...orderbook.bids], [[85999.9, 1]]);
  assert.deepEqual([...orderbook.asks], [[86000.2, 1]]);

  const candles = await adapter.getCandles('BTCUSDT', '15', 1);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].close, 11);
});

test('REST: a full snapshot assembles instrument, top of book and candles', async () => {
  const fetchImpl = recordingFetch((url) => response(route(url)));
  const adapter = createBybitRestMarketDataAdapter({ fetchImpl, now: () => FIXED_NOW });

  const snapshot = await adapter.getSnapshot('BTCUSDT', { interval: '15', candleLimit: 1 });
  assert.equal(snapshot.lastPrice, 86000.1);
  assert.equal(snapshot.markPrice, 86000);
  assert.equal(snapshot.bid, 85999.9);
  assert.equal(snapshot.ask, 86000.2);
  assert.ok(Math.abs(snapshot.spread - 0.3) < 1e-9, `spread was ${snapshot.spread}`);
  assert.equal(snapshot.instrument.tickSize, 0.1);
  assert.equal(snapshot.candleTimeframe, '15');
  assert.equal(snapshot.candles.length, 1);
});

test('REST: instrument metadata is cached across calls', async () => {
  const fetchImpl = recordingFetch((url) => response(route(url)));
  const adapter = createBybitRestMarketDataAdapter({ fetchImpl, now: () => FIXED_NOW });

  await adapter.getInstrumentInfo('BTCUSDT');
  await adapter.getInstrumentInfo('BTCUSDT');
  const instrumentCalls = fetchImpl.calls.filter((call) => call.url.includes('/instruments-info'));
  assert.equal(instrumentCalls.length, 1);

  adapter.clearInstrumentCache();
  await adapter.getInstrumentInfo('BTCUSDT');
  assert.equal(fetchImpl.calls.filter((call) => call.url.includes('/instruments-info')).length, 2);
});

test('REST: HTTP 429 is a retryable RateLimitError and the retry succeeds', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return calls.length === 1 ? response({ retCode: 0 }, 429) : response(SUCCESS.tickers);
  };
  const adapter = createBybitRestMarketDataAdapter({ fetchImpl, retry: { attempts: 3 }, sleep: async () => {}, random: () => 0.5 });

  const tick = await adapter.getTicker('BTCUSDT');
  assert.equal(tick.price, 86000.1);
  assert.equal(calls.length, 2, 'the 429 must have been retried once');
});

test('REST: HTTP 5xx is a retryable NetworkError', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return calls.length === 1 ? response({ retCode: 0 }, 500) : response(SUCCESS.tickers);
  };
  const adapter = createBybitRestMarketDataAdapter({ fetchImpl, retry: { attempts: 2 }, sleep: async () => {}, random: () => 0.5 });
  assert.equal((await adapter.getTicker('BTCUSDT')).symbol, 'BTCUSDT');
  assert.equal(calls.length, 2);
});

test('REST: a transport rejection is a NetworkError', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const client = createBybitRestClient({ fetchImpl, retry: { attempts: 1 } });
  await assert.rejects(() => client.request('/v5/market/tickers'), NetworkError);
});

test('REST: a rate-limit retCode is retried, a data retCode is not', async () => {
  const limited = recordingFetch(() => response({ retCode: 10006, retMsg: 'too many visits' }));
  const limitedClient = createBybitRestClient({ fetchImpl: limited, retry: { attempts: 3 }, sleep: async () => {}, random: () => 0.5 });
  await assert.rejects(() => limitedClient.request('/v5/market/tickers'), RateLimitError);
  assert.equal(limited.calls.length, 3);

  const bad = recordingFetch(() => response({ retCode: 10001, retMsg: 'params error' }));
  const badClient = createBybitRestClient({ fetchImpl: bad, retry: { attempts: 3 }, sleep: async () => {}, random: () => 0.5 });
  await assert.rejects(() => badClient.request('/v5/market/tickers'), DataError);
  assert.equal(bad.calls.length, 1, 'a data error must not be retried');
});

test('REST: malformed JSON is a DataError', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });
  const client = createBybitRestClient({ fetchImpl, retry: { attempts: 2 } });
  await assert.rejects(() => client.request('/v5/market/tickers'), DataError);
});

test('REST: a missing implementation is a configuration error', () => {
  assert.throws(() => createBybitRestClient({ fetchImpl: null }), ConfigurationError);
});
