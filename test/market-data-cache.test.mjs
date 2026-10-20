/**
 * Phase 2 market state cache tests.
 *
 * The cache is the core's current market view. These tests pin the fail-closed
 * and idempotency properties: bad data cannot be stored, a duplicate delta is
 * ignored, a sequence gap is reported for resync, and staleness is visible.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ValidationError } from '../src/errors/taxonomy.mjs';
import { createMarketStateCache } from '../src/market-data/market-state-cache.mjs';

function clockAt(start = 1_700_000_000_000) {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

const tick = (overrides = {}) => ({ symbol: 'BTCUSDT', price: 100, bid: 99, ask: 101, volume: 5, timestamp: 1, ...overrides });
const book = (overrides = {}) => ({
  symbol: 'BTCUSDT',
  bids: [[99, 1]],
  asks: [[101, 1]],
  timestamp: 1,
  ...overrides,
});

test('CACHE: a validated tick is stored and unknown symbols read as null', () => {
  const clock = clockAt();
  const cache = createMarketStateCache({ now: clock.now });

  cache.applyTick(tick());
  const entry = cache.get('BTCUSDT');
  assert.equal(entry.tick.price, 100);
  assert.equal(entry.stale, false);
  assert.equal(entry.orderbook, null);
  assert.equal(cache.get('ETHUSDT'), null);
});

test('CACHE: an invalid tick is refused through the domain constructor', () => {
  const cache = createMarketStateCache();
  assert.throws(() => cache.applyTick(tick({ price: -1 })), ValidationError);
  assert.throws(() => cache.applyTick(tick({ bogus: true })), ValidationError);
  assert.equal(cache.size(), 0);
});

test('CACHE: staleness becomes visible after the threshold', () => {
  const clock = clockAt();
  const cache = createMarketStateCache({ now: clock.now, staleAfterMs: 1000 });

  cache.applyTick(tick());
  assert.equal(cache.isStale('BTCUSDT'), false);

  clock.advance(1001);
  assert.equal(cache.isStale('BTCUSDT'), true);
  assert.equal(cache.get('BTCUSDT').stale, true);
  assert.equal(cache.isStale('UNSEEN'), true, 'an unseen symbol is stale by definition');
});

test('CACHE: an orderbook delta merges into the snapshot', () => {
  const cache = createMarketStateCache();
  cache.applyOrderbook(book({ bids: [[99, 1], [98, 2]], asks: [[101, 1]] }), { updateId: 10 });

  const outcome = cache.applyOrderbookDelta({
    symbol: 'BTCUSDT',
    bids: [[100, 3], [99, 0]],
    asks: [[100.5, 1]],
    updateId: 11,
    timestamp: 2,
  });

  assert.equal(outcome.applied, true);
  assert.deepEqual([...cache.get('BTCUSDT').orderbook.bids], [[100, 3], [98, 2]]);
  assert.deepEqual([...cache.get('BTCUSDT').orderbook.asks], [[100.5, 1], [101, 1]]);
});

test('CACHE: a duplicate/stale delta is ignored idempotently', () => {
  const cache = createMarketStateCache();
  cache.applyOrderbook(book(), { updateId: 10 });
  const outcome = cache.applyOrderbookDelta({ symbol: 'BTCUSDT', bids: [[50, 1]], asks: [], updateId: 10, timestamp: 2 });
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, 'stale');
  assert.equal(outcome.needsResync, false);
  assert.deepEqual([...cache.get('BTCUSDT').orderbook.bids], [[99, 1]]);
});

test('CACHE: a sequence gap asks for a resync instead of corrupting the book', () => {
  const cache = createMarketStateCache();
  cache.applyOrderbook(book(), { updateId: 10 });

  const outcome = cache.applyOrderbookDelta({ symbol: 'BTCUSDT', bids: [[50, 1]], asks: [], updateId: 15, timestamp: 2 });
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, 'gap');
  assert.equal(outcome.needsResync, true);
  assert.deepEqual([...cache.get('BTCUSDT').orderbook.bids], [[99, 1]], 'the stored book must be untouched');
});

test('CACHE: a delta without a snapshot cannot be applied', () => {
  const cache = createMarketStateCache();
  const outcome = cache.applyOrderbookDelta({ symbol: 'BTCUSDT', bids: [[50, 1]], asks: [], updateId: 1, timestamp: 2 });
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, 'no-snapshot');
  assert.equal(outcome.needsResync, true);
});

test('CACHE: a delta that would cross the book is refused', () => {
  const cache = createMarketStateCache();
  cache.applyOrderbook(book({ bids: [[99, 1]], asks: [[101, 1]] }), { updateId: 1 });
  const outcome = cache.applyOrderbookDelta({ symbol: 'BTCUSDT', bids: [[102, 1]], asks: [], updateId: 2, timestamp: 2 });
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, 'invalid');
  assert.equal(outcome.needsResync, true);
});

test('CACHE: trades are validated and stored, and a risk view is derived', () => {
  const cache = createMarketStateCache();
  cache.applyTrade({ s: 'BTCUSDT', S: 'Buy', v: '1', p: '100', T: 3 });
  assert.equal(cache.get('BTCUSDT').lastTrade.price, 100);

  cache.applyOrderbook(book({ bids: [[99, 1]], asks: [[101, 1]] }));
  const risk = cache.toRiskMarketState('BTCUSDT');
  assert.equal(risk.bestBid, 99);
  assert.equal(risk.bestAsk, 101);
  assert.equal(risk.markPrice, null, 'no invented mid price');
});

test('CACHE: symbols, size and clear behave', () => {
  const cache = createMarketStateCache();
  cache.applyTick(tick({ symbol: 'BTCUSDT' }));
  cache.applyTick(tick({ symbol: 'ETHUSDT', price: 10 }));
  assert.deepEqual(cache.symbols(), ['BTCUSDT', 'ETHUSDT']);
  assert.equal(cache.size(), 2);
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.get('BTCUSDT'), null);
});
