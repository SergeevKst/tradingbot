/**
 * Phase 2 market-data service tests.
 *
 * Exercises the service as an integration seam without any network: a fake
 * adapter for priming/resync, a fake WebSocket factory for lifecycle, and a fake
 * observer for observability. A final test wires the real append-only journal to
 * prove market-data events are recordable.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMarketTick } from '../src/domain/market-tick.mjs';
import { createOrderBookSnapshot } from '../src/domain/orderbook-snapshot.mjs';
import { createMarketStateCache } from '../src/market-data/market-state-cache.mjs';
import { createMarketDataService } from '../src/market-data/market-data-service.mjs';
import { MARKET_DATA_EVENT } from '../src/market-data/events.mjs';
import { createJournal, readJournal } from '../src/state/journal.mjs';

const NOW = 1_700_000_000_000;

const primingTick = createMarketTick({ symbol: 'BTCUSDT', price: 100, bid: 99, ask: 101, volume: 5, timestamp: 1 });
const primingBook = createOrderBookSnapshot({ symbol: 'BTCUSDT', bids: [[99, 1]], asks: [[101, 1]], timestamp: 1 });

function fakeAdapter(overrides = {}) {
  return {
    getTicker: overrides.getTicker ?? (async () => primingTick),
    getOrderbook:
      overrides.getOrderbook ??
      (async () => createOrderBookSnapshot({ symbol: 'BTCUSDT', bids: [[99, 1]], asks: [[101, 1]], timestamp: 1 })),
  };
}

function fakeWs() {
  const calls = { connect: 0, close: 0 };
  let handlers = null;
  return {
    calls,
    factory: (nextHandlers) => {
      handlers = nextHandlers;
      return {
        connect: () => {
          calls.connect += 1;
          handlers.onStatus({ status: 'open' });
        },
        close: () => {
          calls.close += 1;
          handlers.onStatus({ status: 'stopped' });
        },
      };
    },
    handlers: () => handlers,
  };
}

function recordingObserver() {
  const events = [];
  return { events, record: (event) => events.push(event) };
}

test('SERVICE: start primes the cache from REST and connects the feed', async () => {
  const cache = createMarketStateCache({ now: () => NOW });
  const ws = fakeWs();
  const observer = recordingObserver();
  const service = createMarketDataService({
    adapter: fakeAdapter(),
    cache,
    symbols: ['btcusdt'],
    wsFactory: ws.factory,
    observer,
    now: () => NOW,
  });

  const outcome = await service.start();
  assert.deepEqual(outcome, { primed: ['BTCUSDT'], failed: [] });
  assert.equal(cache.get('BTCUSDT').tick.price, 100);
  assert.equal(cache.get('BTCUSDT').orderbook.bids[0][0], 99);
  assert.equal(ws.calls.connect, 1);
  assert.ok(observer.events.some((event) => event.eventType === MARKET_DATA_EVENT.CONNECTED));

  service.stop();
  assert.equal(ws.calls.close, 1);
  assert.ok(observer.events.some((event) => event.eventType === MARKET_DATA_EVENT.DISCONNECTED));
});

test('SERVICE: topics respect the include filters and depth', () => {
  const cache = createMarketStateCache();
  const service = createMarketDataService({
    adapter: fakeAdapter(),
    cache,
    symbols: ['BTCUSDT'],
    orderbookDepth: 50,
    include: { trade: false },
  });

  const topics = service.topics();
  assert.ok(topics.includes('tickers.BTCUSDT'));
  assert.ok(topics.includes('orderbook.50.BTCUSDT'));
  assert.ok(!topics.some((topic) => topic.startsWith('publicTrade')), 'trade must be excluded when disabled');
});

test('SERVICE: a WebSocket ticker message updates state and is observable', () => {
  const cache = createMarketStateCache({ now: () => NOW });
  const observer = recordingObserver();
  const service = createMarketDataService({ adapter: fakeAdapter(), cache, symbols: ['BTCUSDT'], observer, now: () => NOW });

  const result = service.ingestWsMessage({
    topic: 'tickers.BTCUSDT',
    type: 'snapshot',
    data: { s: 'BTCUSDT', lastPrice: '101.5', bid1Price: '101', ask1Price: '102', ts: NOW },
  });

  assert.equal(result.applied, true);
  assert.equal(cache.get('BTCUSDT').tick.price, 101.5);
  assert.equal(service.stats().ticks, 1);
  assert.ok(observer.events.some((event) => event.eventType === MARKET_DATA_EVENT.TICK));
});

test('SERVICE: a malformed message is refused, counted and recorded', () => {
  const cache = createMarketStateCache({ now: () => NOW });
  const observer = recordingObserver();
  const service = createMarketDataService({ adapter: fakeAdapter(), cache, symbols: ['BTCUSDT'], observer, now: () => NOW });

  const result = service.ingestWsMessage({ topic: 'tickers.BTCUSDT', type: 'snapshot', data: {} });
  assert.equal(result.applied, false);
  assert.equal(cache.get('BTCUSDT'), null, 'bad data must never enter the cache');
  assert.equal(service.stats().invalid, 1);
  assert.ok(observer.events.some((event) => event.eventType === MARKET_DATA_EVENT.ERROR));
});

test('SERVICE: an orderbook snapshot then delta updates the stored book', () => {
  const cache = createMarketStateCache({ now: () => NOW });
  const service = createMarketDataService({ adapter: fakeAdapter(), cache, symbols: ['BTCUSDT'], now: () => NOW });

  service.ingestWsMessage({
    topic: 'orderbook.50.BTCUSDT',
    type: 'snapshot',
    data: { s: 'BTCUSDT', b: [['100', '1']], a: [['102', '1']], u: 10, ts: NOW },
  });
  const delta = service.ingestWsMessage({
    topic: 'orderbook.50.BTCUSDT',
    type: 'delta',
    data: { s: 'BTCUSDT', b: [['101', '2']], a: [], u: 11, ts: NOW },
  });

  assert.equal(delta.applied, true);
  const book = cache.get('BTCUSDT').orderbook;
  assert.deepEqual([...book.bids], [[101, 2], [100, 1]]);
});

test('SERVICE: a sequence gap triggers a REST resync', async () => {
  const freshBook = createOrderBookSnapshot({ symbol: 'BTCUSDT', bids: [[98, 9]], asks: [[103, 9]], timestamp: 2 });
  let resyncCalls = 0;
  const adapter = fakeAdapter({
    getOrderbook: async () => {
      resyncCalls += 1;
      return freshBook;
    },
  });
  const cache = createMarketStateCache({ now: () => NOW });
  const service = createMarketDataService({ adapter, cache, symbols: ['BTCUSDT'], now: () => NOW });

  service.ingestWsMessage({
    topic: 'orderbook.50.BTCUSDT',
    type: 'snapshot',
    data: { s: 'BTCUSDT', b: [['100', '1']], a: [['102', '1']], u: 10, ts: NOW },
  });
  const gap = service.ingestWsMessage({
    topic: 'orderbook.50.BTCUSDT',
    type: 'delta',
    data: { s: 'BTCUSDT', b: [['101', '2']], a: [], u: 50, ts: NOW },
  });

  assert.equal(gap.needsResync, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resyncCalls, 1);
  assert.deepEqual([...cache.get('BTCUSDT').orderbook.bids], [[98, 9]]);
});

test('SERVICE: a primitive failure is reported but does not abort start', async () => {
  const cache = createMarketStateCache({ now: () => NOW });
  const observer = recordingObserver();
  const service = createMarketDataService({
    adapter: fakeAdapter({
      getTicker: async () => {
        throw new Error('rest unavailable');
      },
    }),
    cache,
    symbols: ['BTCUSDT'],
    observer,
    now: () => NOW,
  });

  const outcome = await service.start();
  assert.deepEqual(outcome.primed, []);
  assert.deepEqual(outcome.failed, ['BTCUSDT']);
  assert.ok(observer.events.some((event) => event.eventType === MARKET_DATA_EVENT.ERROR));
});

test('SERVICE: market data events can be written to the trading journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'market-journal-'));
  try {
    const journal = createJournal({ filePath: join(directory, 'journal.jsonl') });
    const cache = createMarketStateCache({ now: () => NOW });
    const service = createMarketDataService({
      adapter: fakeAdapter(),
      cache,
      symbols: ['BTCUSDT'],
      observer: journal,
      now: () => NOW,
    });

    service.ingestWsMessage({
      topic: 'tickers.BTCUSDT',
      type: 'snapshot',
      data: { s: 'BTCUSDT', lastPrice: '101', ts: NOW },
    });
    await service.flush();

    const { events } = await readJournal(join(directory, 'journal.jsonl'));
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, MARKET_DATA_EVENT.TICK);
    assert.equal(events[0].symbol, 'BTCUSDT');
    assert.equal(events[0].price, 101);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
