import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  precheckIdea,
  shouldSkipAutoEntry,
  parseGuardResponse,
  buildGuardPrompt,
  RISK_FILTER_PROMPT_VERSION,
  GUARD_SYSTEM_PROMPT,
  PRECHECK_STOP_RANGE_MULT,
  PRECHECK_MIN_REWARD_RISK,
  PRECHECK_CHASE_PCT,
} from '../src/telegram/risk-filter.mjs';
import { contextForIdea as contextForIdeaOrig } from '../src/telegram/bot.mjs';
import { emaLast, computeBtcBlock } from '../src/telegram/market-summary.mjs';
import { formatSentiment } from '../src/telegram/sentiment.mjs';

function makeIdea(overrides = {}) {
  return {
    symbol: 'ETHUSDT',
    side: 'LONG',
    entry: 2000,
    stopLoss: 1900,
    takeProfit: 2200,
    rationale: 'test',
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    symbols: [{
      symbol: 'ETHUSDT',
      lastPrice: 2000,
      high24h: 2100,
      low24h: 1900,
      avgRange14h: 15,
      ...overrides.snap,
    }],
    btc: overrides.btc ?? null,
  };
}

test('precheckIdea: stopDist < 1.5x avgRange14h fails', () => {
  const ctx = makeContext({ snap: { avgRange14h: 100 } });
  const idea = makeIdea({ entry: 2000, stopLoss: 1950 }); // dist 50 < 150
  const res = precheckIdea(idea, ctx);
  assert.equal(res.pass, false);
  assert.ok(res.reasons.some((r) => r.includes('stop distance')));
});

test('precheckIdea: reward/risk 1.2 fails; 1.5 passes', () => {
  const ctx = makeContext();
  const bad = precheckIdea(makeIdea({ entry: 2000, stopLoss: 1900, takeProfit: 2100 }), ctx);
  assert.equal(bad.pass, false);
  assert.ok(bad.reasons.some((r) => r.includes('reward/risk')));
  const good = precheckIdea(makeIdea({ entry: 2000, stopLoss: 1900, takeProfit: 2150 }), ctx);
  assert.equal(good.pass, true);
});

test('precheckIdea: LONG entry +9% above low24h fails; +7% passes', () => {
  const ctx = makeContext({ snap: { low24h: 1800 } });
  const bad = precheckIdea(makeIdea({ entry: 1962 }), ctx); // (1962-1800)/1800 = 9%
  assert.equal(bad.pass, false);
  assert.ok(bad.reasons.some((r) => r.includes('above 24h low')));
  const good = precheckIdea(makeIdea({ entry: 1926 }), ctx); // 7%
  assert.equal(good.pass, true);
});

test('precheckIdea: alt LONG against btc.bias=down fails; flat passes; BTC skips', () => {
  const down = makeContext({ btc: { bias: 'down' } });
  const resDown = precheckIdea(makeIdea({ symbol: 'ETHUSDT' }), down);
  assert.equal(resDown.pass, false);
  assert.ok(resDown.reasons.some((r) => r.includes('BTC bias=down')));

  const flat = makeContext({ btc: { bias: 'flat' } });
  const resFlat = precheckIdea(makeIdea({ symbol: 'ETHUSDT' }), flat);
  assert.equal(resFlat.pass, true);

  const btcDown = {
    symbols: [{ symbol: 'BTCUSDT', lastPrice: 80000, high24h: 81000, low24h: 79000, avgRange14h: 300 }],
    btc: { bias: 'down' },
  };
  const resBtc = precheckIdea(makeIdea({ symbol: 'BTCUSDT', entry: 80000, stopLoss: 79000, takeProfit: 82000 }), btcDown);
  assert.equal(resBtc.pass, true);
});

test('precheckIdea: missing avgRange14h skips stop width check', () => {
  const ctx = makeContext({ snap: { avgRange14h: undefined } });
  const res = precheckIdea(makeIdea({ entry: 2000, stopLoss: 1999 }), ctx);
  assert.equal(res.pass, true);
});

test('precheckIdea: symbol outside context fails', () => {
  const res = precheckIdea(makeIdea({ symbol: 'UNKNOWN' }), makeContext());
  assert.equal(res.pass, false);
  assert.ok(res.reasons.some((r) => r.includes('no market data')));
});

test('computeBtcBlock: 30 growing closes => bias=up; falling => down; saw => flat; <22 => null', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(computeBtcBlock(up.map((c) => ({ c })))?.bias, 'up');

  const down = Array.from({ length: 30 }, (_, i) => 130 - i);
  assert.equal(computeBtcBlock(down.map((c) => ({ c })))?.bias, 'down');

  const flat = Array.from({ length: 30 }, () => 100);
  assert.equal(computeBtcBlock(flat.map((c) => ({ c })))?.bias, 'flat');

  assert.equal(computeBtcBlock(Array.from({ length: 10 }, (_, i) => ({ c: i }))), null);
});

test('emaLast: length < period => null; constant row == constant', () => {
  assert.equal(emaLast([1, 2], 5), null);
  assert.equal(emaLast([5, 5, 5, 5, 5], 5), 5);
});

test('G-4: formatSentiment includes fearGreed when provided', () => {
  const text = formatSentiment({ fearGreed: 75, fearGreedClass: 'Greed', fundingRate: 0.0001, turnover24h: 1e6, openInterestValue: 1e6 });
  assert.ok(text.includes('Fear&Greed: 75'));
});

test('G-5: buildGuardPrompt version is risk-guard-v2 with expected payload keys', () => {
  const prompt = buildGuardPrompt({ idea: makeIdea(), market: { symbol: {} }, sentiment: '', news: '' });
  assert.equal(prompt.version, 'risk-guard-v2');
  assert.equal(prompt.version, RISK_FILTER_PROMPT_VERSION);
  const parsed = JSON.parse(prompt.user);
  assert.ok('idea' in parsed);
  assert.ok('market' in parsed);
  assert.ok('sentiment' in parsed);
  assert.ok('news' in parsed);
});

test('G-5: guard prompt does not contain "widen the stop"', () => {
  assert.ok(!GUARD_SYSTEM_PROMPT.includes('widen the stop'));
});

test('G-6: parseGuardResponse enforces 1..5 reasons and length <= 800', () => {
  const ok = parseGuardResponse(JSON.stringify({ verdict: 'APPROVED', confidence: 0.7, reasons: ['ok'] }));
  assert.equal(ok.ok, true);

  const empty = parseGuardResponse(JSON.stringify({ verdict: 'APPROVED', confidence: 0.7, reasons: [] }));
  assert.equal(empty.ok, false);

  const tooMany = parseGuardResponse(JSON.stringify({ verdict: 'APPROVED', confidence: 0.7, reasons: ['1', '2', '3', '4', '5', '6'] }));
  assert.equal(tooMany.ok, false);

  const tooLong = parseGuardResponse(JSON.stringify({ verdict: 'APPROVED', confidence: 0.7, reasons: ['x'.repeat(801)] }));
  assert.equal(tooLong.ok, false);
});

test('G-6: contextForIdea returns only target symbol snapshot + btc', () => {
  const ctx = {
    symbols: [
      { symbol: 'ETHUSDT', lastPrice: 2000 },
      { symbol: 'BTCUSDT', lastPrice: 80000 },
    ],
    btc: { bias: 'up' },
  };
  const slim = contextForIdeaOrig(ctx, 'ETHUSDT');
  assert.equal(slim.symbol.symbol, 'ETHUSDT');
  assert.equal(slim.btc.bias, 'up');
});

test('shouldSkipAutoEntry: drift > refreshPct skips', () => {
  const res = shouldSkipAutoEntry({ idea: makeIdea({ entry: 100, stopLoss: 90, takeProfit: 110 }), live: 110, slippagePct: 0.15, refreshPct: 1.0 });
  assert.equal(res.skip, true);
  assert.ok(res.reason.includes('drifted'));
});

test('shouldSkipAutoEntry: live beyond SL/TP skips', () => {
  const longSl = shouldSkipAutoEntry({ idea: makeIdea({ entry: 100, stopLoss: 90, takeProfit: 110 }), live: 85, slippagePct: 0.15, refreshPct: 1.0 });
  assert.equal(longSl.skip, true);
  const longTp = shouldSkipAutoEntry({ idea: makeIdea({ entry: 100, stopLoss: 90, takeProfit: 110 }), live: 115, slippagePct: 0.15, refreshPct: 1.0 });
  assert.equal(longTp.skip, true);
});

test('shouldSkipAutoEntry: drift within tolerance and SL < live < TP passes', () => {
  const res = shouldSkipAutoEntry({ idea: makeIdea({ entry: 100, stopLoss: 90, takeProfit: 110 }), live: 100.5, slippagePct: 0.15, refreshPct: 1.0 });
  assert.equal(res.skip, false);
});

test('G-8: validateIdeasWithMarket rejects symbol in openPositions', async () => {
  const { validateIdeasWithMarket } = await import('../src/telegram/ideas.mjs');
  const ctx = { symbols: [{ symbol: 'ETHUSDT', lastPrice: 2000, avgRange14h: 100 }], openPositions: [{ symbol: 'ETHUSDT', side: 'LONG' }] };
  const res = validateIdeasWithMarket([makeIdea()], ctx);
  assert.equal(res.ideas.length, 0);
  assert.ok(res.issues.some((i) => i.includes('already has an open position')));
});
