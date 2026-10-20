/**
 * Phase 2 normalizer tests.
 *
 * A normalizer is the only place a Bybit payload becomes a domain value, so
 * these tests pin both the happy path and the fail-closed cases: a crossed book,
 * a missing price, a malformed level, a bad side and an unknown interval must
 * all be refused with a typed error, never defaulted.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DataError, ValidationError } from '../src/errors/taxonomy.mjs';
import {
  mergeOrderbookLevels,
  normalizeBybitOrderbookDelta,
  normalizeBybitOrderbookSnapshot,
  parseBybitLevels,
} from '../src/normalizers/bybit-orderbook.mjs';
import { normalizeBybitTicker } from '../src/normalizers/bybit-ticker.mjs';
import { normalizeBybitTrade } from '../src/normalizers/bybit-trade.mjs';
import { normalizeBybitKline, normalizeBybitKlines } from '../src/normalizers/bybit-kline.mjs';

// ---------------------------------------------------------------------------
// Ticker -> MarketTick
// ---------------------------------------------------------------------------
test('NORMALIZE: a REST ticker row becomes a MarketTick', () => {
  const tick = normalizeBybitTicker(
    { symbol: 'BTCUSDT', lastPrice: '86000.1', markPrice: '86000', bid1Price: '85999.9', ask1Price: '86000.2', volume24h: '123.4' },
    { timestamp: 1_700_000_000_000 },
  );

  assert.equal(tick.symbol, 'BTCUSDT');
  assert.equal(tick.price, 86000.1);
  assert.equal(tick.bid, 85999.9);
  assert.equal(tick.ask, 86000.2);
  assert.equal(tick.volume, 123.4);
  assert.equal(tick.timestamp, 1_700_000_000_000);
  assert.ok(Object.isFrozen(tick));
});

test('NORMALIZE: a WebSocket ticker uses its own ts and falls back to markPrice', () => {
  const tick = normalizeBybitTicker({ topic: 'tickers.BTCUSDT', s: 'BTCUSDT', markPrice: '100', ts: 1_700_000_000_123 });
  assert.equal(tick.price, 100);
  assert.equal(tick.timestamp, 1_700_000_000_123);
  assert.equal(tick.bid, undefined, 'an absent bid must stay absent, not be invented');
});

test('NORMALIZE: a crossed ticker book is refused as bad data', () => {
  assert.throws(
    () => normalizeBybitTicker({ symbol: 'BTCUSDT', lastPrice: '100', bid1Price: '101', ask1Price: '99', ts: 1 }),
    (error) => {
      assert.ok(error instanceof DataError);
      assert.ok(error.cause instanceof ValidationError, 'the domain validation is preserved as the cause');
      return true;
    },
  );
});

test('NORMALIZE: a ticker without a price or timestamp is refused', () => {
  assert.throws(() => normalizeBybitTicker({ symbol: 'BTCUSDT', bid1Price: '1' }, { timestamp: 1 }), DataError);
  assert.throws(() => normalizeBybitTicker({ symbol: 'BTCUSDT', lastPrice: '1' }), DataError);
  assert.throws(() => normalizeBybitTicker({ lastPrice: '1', ts: 1 }), DataError);
  assert.throws(() => normalizeBybitTicker(null), DataError);
});

// ---------------------------------------------------------------------------
// Orderbook -> OrderBookSnapshot
// ---------------------------------------------------------------------------
test('NORMALIZE: a full Bybit book becomes a validated snapshot', () => {
  const snapshot = normalizeBybitOrderbookSnapshot({
    s: 'BTCUSDT',
    b: [['86000.1', '2'], ['86000.0', '1']],
    a: [['86000.2', '1.5'], ['86000.3', '3']],
    ts: 1_700_000_000_000,
    u: 10,
  });

  assert.equal(snapshot.symbol, 'BTCUSDT');
  assert.deepEqual([...snapshot.bids], [[86000.1, 2], [86000, 1]]);
  assert.deepEqual([...snapshot.asks], [[86000.2, 1.5], [86000.3, 3]]);
  assert.equal(snapshot.timestamp, 1_700_000_000_000);
  assert.ok(Object.isFrozen(snapshot));
});

test('NORMALIZE: an unsorted or crossed book is refused', () => {
  assert.throws(
    () => normalizeBybitOrderbookSnapshot({ s: 'BTCUSDT', b: [['1', '1'], ['2', '1']], a: [['3', '1']], ts: 1 }),
    DataError,
  );
  assert.throws(
    () => normalizeBybitOrderbookSnapshot({ s: 'BTCUSDT', b: [['100', '1']], a: [['99', '1']], ts: 1 }),
    DataError,
  );
});

test('NORMALIZE: a zero size is a delta signal, never a snapshot level', () => {
  assert.throws(
    () => normalizeBybitOrderbookSnapshot({ s: 'BTCUSDT', b: [['1', '0']], a: [['2', '1']], ts: 1 }),
    DataError,
  );
  assert.throws(() => parseBybitLevels([['1', '-1']], 'bids'), DataError);
  assert.throws(() => parseBybitLevels('not-an-array', 'bids'), DataError);
});

test('NORMALIZE: an orderbook delta allows size 0 (a delete) and carries the update id', () => {
  const delta = normalizeBybitOrderbookDelta({ s: 'BTCUSDT', b: [['100', '0'], ['99', '2']], a: [], u: 42, ts: 1_700_000_000_000 });
  assert.deepEqual([...delta.bids], [[100, 0], [99, 2]]);
  assert.equal(delta.updateId, 42);
  assert.equal(delta.symbol, 'BTCUSDT');
});

test('NORMALIZE: merging a delta updates, deletes and re-sorts each side', () => {
  const bids = mergeOrderbookLevels([[100, 1], [99, 2]], [[100, 0], [98, 5]], 'desc', 10);
  assert.deepEqual([...bids], [[99, 2], [98, 5]]);

  const asks = mergeOrderbookLevels([[101, 1]], [[102, 2], [100.5, 3]], 'asc', 10);
  assert.deepEqual([...asks], [[100.5, 3], [101, 1], [102, 2]]);

  const capped = mergeOrderbookLevels([[3, 1], [2, 1], [1, 1]], [], 'desc', 2);
  assert.deepEqual([...capped], [[3, 1], [2, 1]]);
});

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------
test('NORMALIZE: a public trade (WS and REST shapes) is validated', () => {
  const ws = normalizeBybitTrade({ T: 1_700_000_000_000, s: 'BTCUSDT', S: 'Buy', v: '0.5', p: '86000', i: 'abc' });
  assert.equal(ws.side, 'BUY');
  assert.equal(ws.size, 0.5);
  assert.equal(ws.tradeId, 'abc');

  const rest = normalizeBybitTrade({ time: '1700000000000', symbol: 'btcusdt', side: 'Sell', size: '1', price: '100', execId: 'x1' });
  assert.equal(rest.symbol, 'BTCUSDT');
  assert.equal(rest.side, 'SELL');
  assert.equal(rest.timestamp, 1_700_000_000_000);
});

test('NORMALIZE: a trade with a bad side, price or size is refused', () => {
  assert.throws(() => normalizeBybitTrade({ s: 'BTCUSDT', S: 'sideways', v: '1', p: '1', T: 1 }), DataError);
  assert.throws(() => normalizeBybitTrade({ s: 'BTCUSDT', S: 'Buy', v: '0', p: '1', T: 1 }), DataError);
  assert.throws(() => normalizeBybitTrade({ s: 'BTCUSDT', S: 'Buy', v: '1', p: '0', T: 1 }), DataError);
  assert.throws(() => normalizeBybitTrade({ s: 'BTCUSDT', S: 'Buy', v: '1', p: '1', T: 0 }), DataError);
});

// ---------------------------------------------------------------------------
// Klines
// ---------------------------------------------------------------------------
test('NORMALIZE: a Bybit kline row becomes a validated candle', () => {
  const candle = normalizeBybitKline(['1700000000000', '10', '12', '9', '11', '5', '55']);
  assert.equal(candle.open, 10);
  assert.equal(candle.high, 12);
  assert.equal(candle.low, 9);
  assert.equal(candle.close, 11);
  assert.equal(candle.turnover, 55);
});

test('NORMALIZE: a malformed kline row or unknown interval is refused', () => {
  assert.throws(() => normalizeBybitKline(['1700000000000', '10']), DataError);
  assert.throws(() => normalizeBybitKline(['1700000000000', '10', '8', '9', '9', '5']), DataError);
  assert.throws(() => normalizeBybitKlines([], { interval: '7' }), DataError);
  assert.equal(normalizeBybitKlines([], { interval: '15' }).length, 0);
});
