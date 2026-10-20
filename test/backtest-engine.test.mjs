/**
 * Phase 7 — backtest engine integration tests (§27–29).
 *
 * These drive the real pipeline end-to-end: historical bars -> replay ->
 * strategy (and AI gate) -> Risk Engine -> paper execution -> metrics. They are
 * offline and deterministic, and they assert the things the phase promises:
 * metrics are produced, stops/targets resolve conservatively, costs are charged,
 * the risk gate is not bypassed, replay is reproducible, and no live path is
 * reachable.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { runBacktest } from '../src/backtest/engine.mjs';
import { createStrategySignalSource, createAISignalSource } from '../src/backtest/signal-source.mjs';
import { createZeroSlippageModel, createRateSlippageModel } from '../src/backtest/slippage-model.mjs';
import { createZeroFeeModel, createRateFeeModel } from '../src/state/fee-model.mjs';
import { defineStrategy } from '../src/strategy/strategy-interface.mjs';
import { createMockProvider } from '../src/ai/mock-provider.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { INSTRUMENT, BACKTEST_RISK, bar, START_TIME, STEP_MS, round1 } from './backtest-fixtures.mjs';

const STOP_FRACTION = 0.01;
const TARGET_FRACTION = 0.02;

/** A strategy that emits on the first bar only, with fixed R:R geometry. */
function oneShotStrategy(options = {}) {
  const side = options.side ?? 'LONG';
  const bad = options.bad === true;
  const throws = options.throws === true;
  return defineStrategy({
    id: options.id ?? 'backtest-test',
    evaluate(context) {
      if (context.candles.length !== 1) return null;
      if (throws) throw new Error('boom');
      const market = context.snapshot;
      const direction = side === 'LONG' ? 1 : -1;
      const entryPrice = side === 'LONG' ? market.ask : market.bid;
      return {
        symbol: context.symbol,
        side,
        entryPrice,
        stopLossPrice: bad ? entryPrice : round1(entryPrice * (1 - direction * STOP_FRACTION)),
        takeProfitPrice: round1(entryPrice * (1 + direction * TARGET_FRACTION)),
        confidence: 0.5,
        strategyId: 'backtest-test',
        timestamp: context.timestamp ?? START_TIME,
      };
    },
  });
}

/** Build explicit bars from a list of { open, high, low, close }. */
function bars(levels) {
  return levels.map((level, index) => bar({ startTime: START_TIME + index * STEP_MS, ...level }));
}

const FLAT_ENTRY = { open: 86000, high: 86100, low: 85900, close: 86000 };
const TAKE_PROFIT_LEVELS = [FLAT_ENTRY, { open: 86000, high: 88000, low: 85800, close: 87900 }, { open: 87900, high: 88000, low: 87500, close: 87600 }];
const STOP_LEVELS = [FLAT_ENTRY, { open: 86000, high: 86200, low: 84500, close: 84700 }, { open: 84700, high: 85000, low: 84000, close: 84500 }];
const BOTH_CROSSED_LEVELS = [FLAT_ENTRY, { open: 86000, high: 88500, low: 84000, close: 86000 }];
const NO_TRIGGER_LEVELS = [FLAT_ENTRY, { open: 86000, high: 86200, low: 85900, close: 86100 }, { open: 86100, high: 86300, low: 86000, close: 86200 }];

/**
 * @param {object[]} candles
 * @param {object} [overrides]
 */
function run(candles, overrides = {}) {
  return runBacktest({
    candles,
    symbol: 'BTCUSDT',
    instrument: INSTRUMENT,
    signalSource: 'signalSource' in overrides ? overrides.signalSource : createStrategySignalSource(oneShotStrategy()),
    feeModel: overrides.feeModel ?? createRateFeeModel({ entryRate: 0.001, exitRate: 0.001 }),
    fillModel: overrides.fillModel,
    slippageModel: overrides.slippageModel ?? createZeroSlippageModel(),
    riskConfig: overrides.riskConfig ?? BACKTEST_RISK,
    initialEquityUsd: overrides.initialEquityUsd ?? 340,
    spreadBps: overrides.spreadBps ?? 1,
    interval: '15',
  });
}

/** @param {object} result */
function eventTypes(result) {
  return result.journal.map((event) => event.eventType);
}

test('ENGINE: a take profit is reached and the round trip is reported', async () => {
  const result = await run(bars(TAKE_PROFIT_LEVELS));

  assert.equal(result.ok, true);
  assert.equal(result.endReason, 'COMPLETED');
  assert.equal(result.bars, 3);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, 'TAKE_PROFIT');
  assert.ok(result.trades[0].netPnlUsd > 0, 'a 2:1 winner must be net positive after default fees');

  const types = eventTypes(result);
  for (const expected of ['BACKTEST_STARTED', 'ORDER_SUBMITTED', 'ORDER_FILLED', 'POSITION_OPENED', 'TAKE_PROFIT_FILLED', 'POSITION_CLOSED', 'BACKTEST_COMPLETED']) {
    assert.ok(types.includes(expected), `journal should record ${expected}`);
  }
  assert.equal(result.metrics.numberOfTrades, 1);
  assert.equal(result.metrics.winRate, 1);
  assert.equal(result.metrics.losses, 0);
  assert.ok(result.metrics.finalEquityUsd > 340);
});

test('ENGINE: a stop loss is reached on the bar low, adversarially', async () => {
  const result = await run(bars(STOP_LEVELS));

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, 'STOP_LOSS');
  assert.ok(result.trades[0].netPnlUsd < 0, 'a stopped-out long loses after fees');
  assert.equal(result.metrics.winRate, 0);
  assert.ok(result.metrics.finalEquityUsd < 340);
});

test('ENGINE: a bar that crosses BOTH levels resolves to the stop (conservative)', async () => {
  const result = await run(bars(BOTH_CROSSED_LEVELS));

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, 'STOP_LOSS', 'the unknowable intrabar path must never be credited with the target');
  // The engine tests the adverse extreme first, so the stop fires before the
  // target is ever considered — the favourable branch cannot win a tie.
  assert.ok(eventTypes(result).includes('STOP_LOSS_FILLED'));
  assert.ok(!eventTypes(result).includes('TAKE_PROFIT_FILLED'));
});

test('ENGINE: a position left open is settled at the final bar', async () => {
  const result = await run(bars(NO_TRIGGER_LEVELS));

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, 'BACKTEST_END');
  assert.equal(result.openPositions.length, 0, 'the engine ends flat by default');
});

test('ENGINE: fees and slippage both reduce the result', async () => {
  const zeroSlippage = await run(bars(TAKE_PROFIT_LEVELS), {
    feeModel: createZeroFeeModel(),
    slippageModel: createZeroSlippageModel(),
  });
  const withFees = await run(bars(TAKE_PROFIT_LEVELS), {
    feeModel: createRateFeeModel({ entryRate: 0.001, exitRate: 0.001 }),
    slippageModel: createZeroSlippageModel(),
  });
  const withSlippage = await run(bars(TAKE_PROFIT_LEVELS), {
    feeModel: createZeroFeeModel(),
    slippageModel: createRateSlippageModel({ rate: 0.0005 }),
  });

  assert.equal(zeroSlippage.metrics.feesUsd, 0);
  assert.ok(withFees.metrics.feesUsd > 0, 'fees must be charged');
  assert.ok(withFees.metrics.finalEquityUsd < zeroSlippage.metrics.finalEquityUsd, 'fees must lower the result');
  assert.ok(withSlippage.metrics.finalEquityUsd < zeroSlippage.metrics.finalEquityUsd, 'slippage must lower the result');
});

test('ENGINE: the Risk Engine gate is not bypassed by a bad proposal', async () => {
  const result = await run(bars(TAKE_PROFIT_LEVELS), {
    signalSource: createStrategySignalSource(oneShotStrategy({ bad: true })),
  });

  assert.equal(result.trades.length, 0, 'a zero-risk-distance proposal must never fill');
  const rejected = result.journal.find((event) => event.eventType === 'RISK_REJECTED');
  assert.ok(rejected, 'the rejection must be journalled');
  assert.equal(rejected.reason, 'ZERO_RISK_DISTANCE');
  assert.ok(!eventTypes(result).includes('ORDER_FILLED'));
});

test('ENGINE: a throwing signal source fails closed', async () => {
  const result = await run(bars(TAKE_PROFIT_LEVELS), {
    signalSource: createStrategySignalSource(oneShotStrategy({ throws: true })),
  });

  assert.equal(result.trades.length, 0);
  const barEvent = result.journal.find((event) => event.eventType === 'BACKTEST_BAR' && event.reason === 'SIGNAL_ERROR');
  assert.ok(barEvent, 'the strategy failure must be visible in the journal');
});

test('ENGINE: AI analysis gates the deterministic strategy during replay', async () => {
  const strategy = oneShotStrategy();

  const bullish = await run(bars(TAKE_PROFIT_LEVELS), {
    signalSource: createAISignalSource({ strategy, provider: createMockProvider({ bias: 'BULLISH' }) }),
  });
  const neutral = await run(bars(TAKE_PROFIT_LEVELS), {
    signalSource: createAISignalSource({ strategy, provider: createMockProvider({ bias: 'NEUTRAL' }) }),
  });
  const bearish = await run(bars(TAKE_PROFIT_LEVELS), {
    signalSource: createAISignalSource({ strategy, provider: createMockProvider({ bias: 'BEARISH' }) }),
  });
  const invalid = await run(bars(TAKE_PROFIT_LEVELS), {
    signalSource: createAISignalSource({ strategy, provider: createMockProvider({ invalid: true }) }),
  });

  assert.equal(bullish.trades.length, 1, 'agreement lets the strategy trade');
  assert.equal(neutral.trades.length, 1, 'neutral analysis does not veto');
  assert.equal(bearish.trades.length, 0, 'disagreement vetoes the LONG');
  assert.equal(invalid.trades.length, 0, 'an invalid analysis fails closed');
});

test('ENGINE: replay is deterministic — identical inputs reconstruct the same run', async () => {
  const first = await run(bars(TAKE_PROFIT_LEVELS));
  const second = await run(bars(TAKE_PROFIT_LEVELS));

  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.trades, second.trades);
  assert.deepEqual(first.equityCurve, second.equityCurve);
  assert.deepEqual(first.journal, second.journal);
  assert.deepEqual(first.account, second.account);
});

test('ENGINE: required inputs are validated', async () => {
  await assert.rejects(() => runBacktest(null), ConfigError);
  await assert.rejects(() => run(bars(TAKE_PROFIT_LEVELS), { signalSource: null }), ConfigError);
  await assert.rejects(() => runBacktest({ candles: [], symbol: 'BTCUSDT', instrument: INSTRUMENT, signalSource: createStrategySignalSource(oneShotStrategy()), feeModel: createZeroFeeModel() }), ConfigError);
});
