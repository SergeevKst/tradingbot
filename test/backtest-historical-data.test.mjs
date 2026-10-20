/**
 * Phase 7 — historical data loading and data-quality gates (§30).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  normalizeHistoricalCandles,
  detectCandleGaps,
  parseHistoricalText,
  loadHistoricalData,
} from '../src/backtest/historical-data.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { bar, seriesFromCloses, START_TIME, STEP_MS } from './backtest-fixtures.mjs';

test('HISTORICAL: a valid series is normalized, frozen and ordered', () => {
  const candles = normalizeHistoricalCandles(seriesFromCloses([100, 101, 102]));
  assert.equal(candles.length, 3);
  assert.ok(Object.isFrozen(candles));
  assert.ok(Object.isFrozen(candles[0]));
  assert.equal(candles[1].startTime, START_TIME + STEP_MS);
});

test('HISTORICAL: empty and non-array inputs are refused', () => {
  assert.throws(() => normalizeHistoricalCandles([]), ConfigError);
  assert.throws(() => normalizeHistoricalCandles(null), ConfigError);
  assert.throws(() => normalizeHistoricalCandles({ candles: [] }), ConfigError);
});

test('HISTORICAL: duplicate timestamps are refused', () => {
  const series = seriesFromCloses([100, 101, 102]);
  series[2] = { ...series[2], startTime: series[1].startTime };
  assert.throws(() => normalizeHistoricalCandles(series), /duplicate/);
});

test('HISTORICAL: an out-of-order series is refused', () => {
  const series = seriesFromCloses([100, 101, 102]);
  series[2] = { ...series[2], startTime: series[0].startTime - STEP_MS };
  assert.throws(() => normalizeHistoricalCandles(series), /not ordered/);
});

test('HISTORICAL: impossible prices are refused, never silently dropped', () => {
  const zero = [bar({ startTime: START_TIME, open: 0, high: 1, low: 0, close: 0 })];
  assert.throws(() => normalizeHistoricalCandles(zero), /must be > 0/);

  const inverted = [bar({ startTime: START_TIME, open: 100, high: 90, low: 95, close: 100 })];
  assert.throws(() => normalizeHistoricalCandles(inverted), /high/);

  const bodyOutside = [bar({ startTime: START_TIME, open: 100, high: 105, low: 95, close: 110 })];
  assert.throws(() => normalizeHistoricalCandles(bodyOutside), /body/);
});

test('HISTORICAL: gaps are reported explicitly, not hidden', () => {
  const series = seriesFromCloses([100, 101, 102]);
  // Push the third candle one full interval further out.
  series[2] = { ...series[2], startTime: series[1].startTime + 2 * STEP_MS };
  const gaps = detectCandleGaps(series, STEP_MS);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].index, 2);
  assert.equal(gaps[0].missingBars, 1);

  assert.deepEqual(detectCandleGaps(seriesFromCloses([1, 2, 3]), STEP_MS), []);
  assert.throws(() => detectCandleGaps(series, 0), ConfigError);
});

test('HISTORICAL: loadHistoricalData accepts an array and an object dataset', async () => {
  const fromArray = await loadHistoricalData({ source: seriesFromCloses([10, 11, 12]) });
  assert.equal(fromArray.candles.length, 3);
  assert.equal(fromArray.source, 'array');

  const fromObject = await loadHistoricalData({
    source: { symbol: 'BTCUSDT', interval: '15', candles: seriesFromCloses([10, 11, 12]) },
  });
  assert.equal(fromObject.symbol, 'BTCUSDT');
  assert.equal(fromObject.interval, '15');
});

test('HISTORICAL: loadHistoricalData reads a JSON file through the injected fs', async () => {
  const candles = seriesFromCloses([10, 11, 12]);
  const text = JSON.stringify({ symbol: 'BTCUSDT', candles });
  const dataset = await loadHistoricalData({
    source: '/tmp/series.json',
    readFile: async () => text,
  });
  assert.equal(dataset.candles.length, 3);
  assert.equal(dataset.symbol, 'BTCUSDT');
  assert.equal(dataset.source, '/tmp/series.json');
});

test('HISTORICAL: loadHistoricalData reads JSONL by extension', async () => {
  const candles = seriesFromCloses([10, 11, 12]);
  const text = candles.map((candle) => JSON.stringify(candle)).join('\n') + '\n';
  const dataset = await loadHistoricalData({
    source: '/tmp/series.jsonl',
    readFile: async () => text,
  });
  assert.equal(dataset.candles.length, 3);
});

test('HISTORICAL: corrupt files are refused with a location', () => {
  assert.throws(() => parseHistoricalText('{not json', 'json'), /could not be parsed/);
  assert.throws(() => parseHistoricalText('{"nope":1}', 'json'), /must be a candle array/);
  assert.throws(() => parseHistoricalText('{"a":1}\nnot-json', 'jsonl'), /corrupt at line 2/);
});
