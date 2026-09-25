/**
 * Stage 2 tests — market data normalization and price/quantity step handling.
 *
 * Covers the required market-data cases: valid ticker, missing bid, missing ask,
 * invalid price, tickSize violation, qtyStep violation.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  createMarketSnapshot,
  normalizeCandle,
  triggerReferencePrice,
} from '../src/market/market-snapshot.mjs';
import { normalizeInstrumentInfo, decimalsForStep } from '../src/market/instrument-info.mjs';
import {
  normalizePrice,
  normalizeQuantity,
  validatePriceStep,
  validateQuantityStep,
  validateOrderQuantity,
  validateNotional,
  normalizeAndValidateQuantity,
} from '../src/market/normalize.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { assertMarketDataAdapter } from '../src/market/market-data-adapter.mjs';
import { BTC_INSTRUMENT, marketAt } from './paper-fixtures.mjs';

// ---------------------------------------------------------------------------
// Instrument metadata
// ---------------------------------------------------------------------------
test('MARKET: instrument metadata is taken from the source, never invented', () => {
  const instrument = normalizeInstrumentInfo(BTC_INSTRUMENT);
  assert.equal(instrument.tickSize, 0.1);
  assert.equal(instrument.qtyStep, 0.001);
  assert.equal(instrument.minOrderQty, 0.001);
  assert.equal(instrument.maxOrderQty, 1500);
  assert.equal(instrument.maxLeverage, 150);
});

test('MARKET: a missing tickSize or qtyStep is an error, not a default', () => {
  const { tickSize, ...withoutTick } = BTC_INSTRUMENT;
  assert.throws(() => normalizeInstrumentInfo(withoutTick), ConfigError);

  const { qtyStep, ...withoutStep } = BTC_INSTRUMENT;
  assert.throws(() => normalizeInstrumentInfo(withoutStep), ConfigError);
});

test('MARKET: a non-positive or malformed step is rejected', () => {
  assert.throws(() => normalizeInstrumentInfo({ ...BTC_INSTRUMENT, tickSize: 0 }), ConfigError);
  assert.throws(() => normalizeInstrumentInfo({ ...BTC_INSTRUMENT, qtyStep: -1 }), ConfigError);
  assert.throws(() => normalizeInstrumentInfo({ ...BTC_INSTRUMENT, tickSize: 'abc' }), ConfigError);
});

test('MARKET: maxOrderQty below minOrderQty is rejected as inconsistent', () => {
  assert.throws(() => normalizeInstrumentInfo({ ...BTC_INSTRUMENT, minOrderQty: 10, maxOrderQty: 1 }), ConfigError);
});

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------
test('MARKET: a valid ticker produces a complete snapshot', async () => {
  const adapter = marketAt(86000);
  const snapshot = await adapter.getSnapshot('BTCUSDT');

  assert.equal(snapshot.symbol, 'BTCUSDT');
  assert.equal(snapshot.lastPrice, 86000);
  assert.equal(snapshot.markPrice, 86000);
  assert.equal(snapshot.bid, 85999.9);
  assert.equal(snapshot.ask, 86000.1);
  assert.ok(Math.abs(snapshot.spread - 0.2) < 1e-9, `spread was ${snapshot.spread}`);
  assert.equal(snapshot.volume, 1000);
  assert.equal(snapshot.instrument.tickSize, 0.1);
});

test('MARKET: a missing bid stays null rather than being filled from last price', async () => {
  const adapter = marketAt(86000, { bid: null });
  const snapshot = await adapter.getSnapshot('BTCUSDT');

  assert.equal(snapshot.bid, null, 'a missing bid must remain absent, not be guessed');
  assert.equal(snapshot.spread, null, 'spread is unknown without both sides');
  assert.equal(snapshot.ask, 86000.1);
});

test('MARKET: a missing ask stays null', async () => {
  const adapter = marketAt(86000, { ask: null });
  const snapshot = await adapter.getSnapshot('BTCUSDT');

  assert.equal(snapshot.ask, null);
  assert.equal(snapshot.bid, 85999.9);
  assert.equal(snapshot.spread, null);
});

test('MARKET: an invalid price is rejected at snapshot creation', () => {
  assert.throws(() => createMarketSnapshot({ symbol: 'BTCUSDT', lastPrice: 'not-a-number' }), ConfigError);
  assert.throws(() => createMarketSnapshot({ symbol: 'BTCUSDT', bid: -5 }), ConfigError);
  assert.throws(() => createMarketSnapshot({ symbol: 'BTCUSDT', lastPrice: Infinity }), ConfigError);
});

test('MARKET: a crossed book is rejected as corrupt data', () => {
  // bid above ask cannot happen on a real venue: it means the data is broken.
  assert.throws(() => createMarketSnapshot({ symbol: 'BTCUSDT', bid: 100, ask: 90 }), ConfigError);
});

test('MARKET: a snapshot without a symbol is rejected', () => {
  assert.throws(() => createMarketSnapshot({ lastPrice: 1 }), ConfigError);
});

test('MARKET: the trigger reference prefers mark price, then last price', () => {
  const withMark = createMarketSnapshot({ symbol: 'BTCUSDT', markPrice: 100, lastPrice: 200 });
  assert.equal(triggerReferencePrice(withMark), 100);

  const withoutMark = createMarketSnapshot({ symbol: 'BTCUSDT', lastPrice: 200 });
  assert.equal(triggerReferencePrice(withoutMark), 200);

  const neither = createMarketSnapshot({ symbol: 'BTCUSDT' });
  assert.equal(triggerReferencePrice(neither), null, 'no reference price must be visible as null');
});

test('MARKET: candles are normalized and validated', () => {
  const candle = normalizeCandle({ startTime: 1, open: 10, high: 12, low: 9, close: 11, volume: 5, turnover: 55 });
  assert.equal(candle.high, 12);
  assert.equal(candle.low, 9);

  // high < low is impossible and must not be silently accepted.
  assert.throws(() => normalizeCandle({ startTime: 1, open: 10, high: 8, low: 9, close: 9 }), ConfigError);
  assert.throws(() => normalizeCandle({ startTime: 1, open: 10, high: 12 }), ConfigError);
});

test('MARKET: an unknown candle timeframe is rejected', () => {
  assert.throws(
    () => createMarketSnapshot({ symbol: 'BTCUSDT', candles: [], candleTimeframe: '7' }),
    ConfigError,
  );
});

test('MARKET: the adapter contract is enforced at construction', () => {
  assert.throws(() => assertMarketDataAdapter({}), Error);
  assert.throws(() => assertMarketDataAdapter(null), Error);

  // A complete adapter passes.
  const adapter = marketAt(86000);
  assert.doesNotThrow(() => assertMarketDataAdapter(adapter));
  assert.equal(adapter.kind(), 'static');
});

// ---------------------------------------------------------------------------
// Price / quantity step compliance
// ---------------------------------------------------------------------------
test('PRICE: normalization snaps down to the tick grid', () => {
  assert.equal(normalizePrice(86000.15, 0.1).value, 86000.1);
  assert.equal(normalizePrice(86000.19, 0.1).value, 86000.1);
  assert.equal(normalizePrice(86000.1, 0.1).value, 86000.1);
  assert.equal(normalizePrice(86123.456, 0.01).value, 86123.45);
  assert.equal(normalizePrice(100, 1).value, 100);
});

test('PRICE: a tickSize violation is detected', () => {
  assert.equal(validatePriceStep(86000.1, 0.1).valid, true);
  assert.equal(validatePriceStep(86000.15, 0.1).valid, false);
  assert.equal(validatePriceStep(86123.45, 0.01).valid, true);
  assert.equal(validatePriceStep(86123.455, 0.01).valid, false);
});

test('PRICE: floating-point prices on the grid are not false negatives', () => {
  // 86000.1 is stored as 86000.09999999999: a naive modulo check would wrongly
  // reject it, which would refuse perfectly valid orders.
  assert.equal(validatePriceStep(86000.1, 0.1).valid, true);
  assert.equal(validatePriceStep(0.3, 0.1).valid, true);
  assert.equal(validatePriceStep(1.1, 0.1).valid, true);
});

test('PRICE: non-positive and non-finite prices are refused', () => {
  assert.equal(normalizePrice(0, 0.1).ok, false);
  assert.equal(normalizePrice(-1, 0.1).ok, false);
  assert.equal(normalizePrice(Number.NaN, 0.1).ok, false);
  assert.equal(normalizePrice(100, 0).ok, false);
});

test('QTY: normalization snaps down to the quantity step', () => {
  assert.equal(normalizeQuantity(0.0023611, 0.001).value, 0.002);
  assert.equal(normalizeQuantity(0.019, 0.01).value, 0.01);
  assert.equal(normalizeQuantity(5.7, 1).value, 5);
  assert.equal(normalizeQuantity(0.3, 0.1).value, 0.3);
});

test('QTY: a qtyStep violation is detected', () => {
  assert.equal(validateQuantityStep(0.002, 0.001).valid, true);
  assert.equal(validateQuantityStep(0.0025, 0.001).valid, false);
  assert.equal(validateQuantityStep(0.25, 0.1).valid, false);
  assert.equal(validateQuantityStep(0.3, 0.1).valid, true);
});

test('QTY: rounding is DOWN, so a size never exceeds what risk approved', () => {
  // Rounding up would risk more than the engine authorised, which would break
  // the guarantee that a stop-out costs at most the per-trade risk budget.
  const normalized = normalizeQuantity(0.002999, 0.001);
  assert.equal(normalized.value, 0.002);
  assert.ok(normalized.value <= 0.002999);
});

test('QTY: a quantity below one step cannot be made representable', () => {
  const result = normalizeQuantity(0.0005, 0.001);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /smaller than one step/);
});

test('QTY: order limits are checked against min and max', () => {
  const instrument = { qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 10 };

  assert.equal(validateOrderQuantity(0.001, instrument).valid, true);
  assert.equal(validateOrderQuantity(10, instrument).valid, true);
  assert.equal(validateOrderQuantity(0.0009, instrument).valid, false);
  assert.equal(validateOrderQuantity(11, instrument).valid, false);
  assert.equal(validateOrderQuantity(0.0025, instrument).valid, false);
});

test('QTY: the combined normalize-and-validate helper reports the reason', () => {
  const instrument = { qtyStep: 0.001, minOrderQty: 0.01, maxOrderQty: 10 };

  const tooSmall = normalizeAndValidateQuantity(0.005, instrument);
  assert.equal(tooSmall.ok, false);
  assert.match(tooSmall.reason ?? '', /minOrderQty/);

  const ok = normalizeAndValidateQuantity(0.01234, instrument);
  assert.equal(ok.ok, true);
  assert.equal(ok.quantity, 0.012);
});

test('NOTIONAL: the instrument minimum is enforced', () => {
  assert.equal(validateNotional(5, { minNotionalUsd: 5 }).valid, true);
  assert.equal(validateNotional(4.99, { minNotionalUsd: 5 }).valid, false);
  assert.equal(validateNotional(100, {}).valid, true, 'no stated minimum means no constraint');
  assert.equal(validateNotional(0, { minNotionalUsd: 5 }).valid, false);
});

test('STEP: the decimal-places helper handles real exchange steps', () => {
  assert.equal(decimalsForStep(1), 0);
  assert.equal(decimalsForStep(0.1), 1);
  assert.equal(decimalsForStep(0.01), 2);
  assert.equal(decimalsForStep(0.001), 3);
  assert.equal(decimalsForStep(0.000001), 6);

  // A step that is not a decimal grid cannot be represented exactly.
  assert.throws(() => decimalsForStep(0.0000000000000001), ConfigError);
});