import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  parseScoutResponse,
  validateIdeasWithMarket,
  buildScoutPrompt,
  IDEAS_PROMPT_VERSION,
} from '../src/telegram/ideas.mjs';
import { summarizeCandles, summarize4h } from '../src/telegram/market-summary.mjs';

function makeIdea(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entry: 82000,
    stopLoss: 80000,
    takeProfit: 85000,
    rationale: 'test',
    ...overrides,
  };
}

function makeContext(extra = {}) {
  return {
    symbols: [{
      symbol: 'BTCUSDT',
      lastPrice: 82000,
      bid: 81990,
      ask: 82010,
      high24h: 83000,
      low24h: 81000,
      avgRange14h: 1000,
      candles: [],
    }],
    ...extra,
  };
}

test('parseScoutResponse: valid idea passes (regression)', () => {
  const res = parseScoutResponse(JSON.stringify({ ideas: [makeIdea()] }));
  assert.equal(res.ok, true);
  assert.equal(res.ideas.length, 1);
  assert.equal(res.issues.length, 0);
});

test('S-3: R/R = 1.49 rejects', () => {
  // entry 100, stop 99 (risk 1), target 101.49 (reward 1.49)
  const idea = makeIdea({ entry: 100, stopLoss: 99, takeProfit: 101.49 });
  const res = parseScoutResponse(JSON.stringify({ ideas: [idea] }));
  assert.equal(res.ok, true);
  assert.equal(res.ideas.length, 0);
  assert.ok(res.issues.some((i) => i.includes('reward/risk')));
});

test('S-3: R/R = 1.50 passes', () => {
  const idea = makeIdea({ entry: 100, stopLoss: 99, takeProfit: 101.5 });
  const res = parseScoutResponse(JSON.stringify({ ideas: [idea] }));
  assert.equal(res.ok, true);
  assert.equal(res.ideas.length, 1);
  assert.ok(!res.issues.some((i) => i.includes('reward/risk')));
});

test('S-1: unknown symbol rejects', () => {
  const ctx = makeContext();
  const ideas = [makeIdea({ symbol: 'PEPEUSDT' })];
  const res = validateIdeasWithMarket(ideas, ctx);
  assert.equal(res.ideas.length, 0);
  assert.ok(res.issues.some((i) => i.includes('not in the market context')));
});

test('S-1: known symbol passes', () => {
  const ctx = makeContext();
  const ideas = [makeIdea()];
  const res = validateIdeasWithMarket(ideas, ctx);
  assert.equal(res.ideas.length, 1);
  assert.equal(res.issues.length, 0);
});

test('S-1: entry +3% rejects; +1% passes', () => {
  const ctx = makeContext({ symbols: [{ symbol: 'BTCUSDT', lastPrice: 82000, avgRange14h: 1000 }] });
  const bad = validateIdeasWithMarket([makeIdea({ entry: 84460 })], ctx);
  assert.equal(bad.ideas.length, 0);
  assert.ok(bad.issues.some((i) => i.includes('entry deviates')));
  const good = validateIdeasWithMarket([makeIdea({ entry: 82820 })], ctx);
  assert.equal(good.ideas.length, 1);
  assert.equal(good.issues.length, 0);
});

test('S-1: stopDist < 1.5x avgRange14h rejects; == passes', () => {
  const ctx = makeContext({ symbols: [{ symbol: 'BTCUSDT', lastPrice: 82000, avgRange14h: 1000 }] });
  const bad = validateIdeasWithMarket([makeIdea({ entry: 82000, stopLoss: 80501 })], ctx);
  assert.equal(bad.ideas.length, 0);
  assert.ok(bad.issues.some((i) => i.includes('stopLoss distance')));
  // distance exactly 1.5x avgRange14h (1500) must pass
  const good = validateIdeasWithMarket([makeIdea({ entry: 82000, stopLoss: 80500 })], ctx);
  assert.equal(good.ideas.length, 1);
  assert.equal(good.issues.length, 0);
});

test('S-1: no avgRange14h skips stop width check', () => {
  const ctx = makeContext({ symbols: [{ symbol: 'BTCUSDT', lastPrice: 82000 }] });
  const res = validateIdeasWithMarket([makeIdea({ entry: 82000, stopLoss: 81999 })], ctx);
  assert.equal(res.ideas.length, 1);
  assert.equal(res.issues.length, 0);
});

test('S-1: validateIdeasWithMarket concatenates issues and runs only when parsed.ok', () => {
  const ctx = makeContext();
  const ideas = [makeIdea({ symbol: 'PEPEUSDT' })];
  const checked = validateIdeasWithMarket(ideas, ctx);
  assert.equal(checked.ideas.length, 0);
  assert.ok(checked.issues.some((i) => i.includes('not in the market context')));
});

test('S-2: summarizeCandles computes true 24h extremes and avgRange14h', () => {
  const candles = [];
  for (let i = 0; i < 30; i++) {
    candles.push({ open: i, high: i + 10, low: i, close: i + 5, volume: 1 });
  }
  const s = summarizeCandles(candles);
  const last24High = Math.max(...candles.slice(-24).map((c) => c.high));
  const last24Low = Math.min(...candles.slice(-24).map((c) => c.low));
  const avg14 = candles.slice(-14).reduce((a, c) => a + (c.high - c.low), 0) / 14;
  assert.equal(s.high24h, last24High);
  assert.equal(s.low24h, last24Low);
  assert.equal(s.avgRange14h, avg14);
});

test('S-4: buildScoutPrompt version is scout-ideas-v4', () => {
  const prompt = buildScoutPrompt({});
  assert.equal(prompt.version, 'scout-ideas-v4');
  assert.equal(prompt.version, IDEAS_PROMPT_VERSION);
});

test('S-1/G-8: openPosition symbol is rejected', () => {
  const ctx = makeContext({ openPositions: [{ symbol: 'BTCUSDT', side: 'LONG' }] });
  const res = validateIdeasWithMarket([makeIdea()], ctx);
  assert.equal(res.ideas.length, 0);
  assert.ok(res.issues.some((i) => i.includes('already has an open position')));
});

test('S-5: buildScoutPrompt strips instrument from symbols in user payload', () => {
  const ctx = makeContext({
    symbols: [{
      symbol: 'BTCUSDT',
      lastPrice: 82000,
      instrument: { tickSize: 0.01, qtyStep: 0.001, minOrderQty: 0.01, maxOrderQty: 100, minNotionalUsd: 10 },
    }],
    btc: { bias: 'up' },
  });
  const prompt = buildScoutPrompt(ctx);
  const parsed = JSON.parse(prompt.user);
  assert.ok(Array.isArray(parsed.symbols));
  assert.equal(parsed.symbols[0].symbol, 'BTCUSDT');
  assert.equal('instrument' in parsed.symbols[0], false);
  assert.ok('instrument' in ctx.symbols[0], 'original context must not be mutated');
});

test('S-6: summarize4h computes bias and swing levels from 4h candles', () => {
  const candles = [];
  for (let i = 0; i < 10; i++) {
    candles.push({ open: i * 10, high: i * 10 + 9, low: i * 10, close: i * 10 + 5 });
  }
  const s = summarize4h(candles);
  assert.ok(['up', 'down', 'flat', null].includes(s.bias4h));
  const last7Highs = candles.slice(-7).map((c) => c.high);
  const last7Lows = candles.slice(-7).map((c) => c.low);
  assert.equal(s.swingHigh4h, Math.max(...last7Highs));
  assert.equal(s.swingLow4h, Math.min(...last7Lows));
});
