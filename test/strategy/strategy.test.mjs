/**
 * Strategy layer tests — deterministic, offline. Covers the registry/interface
 * contract, a no-signal market, the MA-crossover happy path through the PAPER
 * pipeline, and a risk-rejected proposal.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createMarketSnapshot } from '../../src/market/market-snapshot.mjs';
import { createDefaultStrategyRegistry, createStrategyRegistry } from '../../src/strategy/registry.mjs';
import { defineStrategy, buildMarketContext } from '../../src/strategy/strategy-interface.mjs';
import { createMaCrossoverStrategy, MA_CROSSOVER_ID } from '../../src/strategy/deterministic-ma-crossover.mjs';
import { riskLimits } from '../fixtures.mjs';
import { BTC_INSTRUMENT, createZeroFeeModel, makeSession } from '../paper-fixtures.mjs';

const FIXED_TIME = '2026-09-30T00:00:00.000Z';
// Fast SMA crosses above slow on the final candle; FLAT never separates them.
const UPTREND = [108, 106, 104, 102, 100, 98, 96, 94, 90, 105, 110];
const FLAT = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100];

function candle(close, index) {
  return {
    startTime: 1_760_000_000_000 + index * 60_000,
    open: close, high: close + 1, low: close - 1, close, volume: 1, turnover: close,
  };
}

function snapshotFrom(closes) {
  const last = closes[closes.length - 1];
  return createMarketSnapshot({
    symbol: 'BTCUSDT', lastPrice: last, markPrice: last, bid: last - 0.1, ask: last + 0.1,
    candleTimeframe: '15', candles: closes.map(candle), instrument: BTC_INSTRUMENT, timestamp: FIXED_TIME,
  });
}

test('strategy: registry rejects duplicates and unknown ids', () => {
  const strategy = createMaCrossoverStrategy();
  const registry = createStrategyRegistry([strategy]);
  assert.deepEqual(registry.list(), [strategy.id]);
  assert.equal(registry.get(strategy.id), strategy);
  assert.equal(registry.tryGet('missing'), null);
  assert.throws(() => registry.get('missing'), /unknown strategy/);
  assert.throws(() => registry.register(createMaCrossoverStrategy()), /already registered/);
  assert.throws(() => defineStrategy({ id: '', evaluate() {} }), /id must be a non-empty string/);
  assert.throws(() => defineStrategy({ id: 'x' }), /evaluate/);
});

test('strategy: a flat market produces no signal', () => {
  const strategy = createMaCrossoverStrategy();
  assert.equal(strategy.evaluate(buildMarketContext(snapshotFrom(FLAT), strategy.indicators)), null);
});

test('strategy: an MA cross emits a deterministic LONG proposal with 2R geometry', () => {
  const strategy = createMaCrossoverStrategy();
  const market = snapshotFrom(UPTREND);
  const first = strategy.evaluate(buildMarketContext(market, strategy.indicators));
  const second = strategy.evaluate(buildMarketContext(market, strategy.indicators));
  assert.deepEqual(first, second, 'the same context must give the same proposal');
  assert.equal(first.side, 'LONG');
  assert.equal(first.strategyId, strategy.id);
  assert.equal(first.symbol, 'BTCUSDT');
  assert.ok(first.stopLossPrice < first.entryPrice, 'LONG stop must sit below entry');
  assert.ok(first.takeProfitPrice > first.entryPrice, 'LONG target must sit above entry');
  assert.equal(first.timestamp, Date.parse(FIXED_TIME));
  const riskReward = (first.takeProfitPrice - first.entryPrice) / (first.entryPrice - first.stopLossPrice);
  assert.ok(riskReward >= 2 - 1e-9, `expected >= 2R, got ${riskReward}`);
});

test('strategy: the session runs a registry strategy end to end', async () => {
  const { session, cleanup } = await makeSession({ fees: createZeroFeeModel() });
  try {
    const outcome = await session.submitFromStrategy({ market: snapshotFrom(UPTREND) });
    assert.equal(outcome.signal, true);
    assert.equal(outcome.approved, true);
    assert.equal(outcome.executed, true);
    assert.equal(outcome.proposal.side, 'LONG');
    assert.equal((await session.getOpenPositions()).length, 1);
  } finally {
    await cleanup();
  }
});

test('strategy: a no-signal market submits nothing', async () => {
  const { session, cleanup } = await makeSession({ fees: createZeroFeeModel() });
  try {
    const outcome = await session.submitFromStrategy({ market: snapshotFrom(FLAT) });
    assert.equal(outcome.signal, false);
    assert.equal(outcome.approved, false);
    assert.equal(outcome.executed, false);
    assert.equal(outcome.reasonCode, 'NO_SIGNAL');
    assert.equal((await session.getOpenPositions()).length, 0);
  } finally {
    await cleanup();
  }
});

test('strategy: a risk-rejected proposal never executes', async () => {
  const { session, cleanup } = await makeSession({ fees: createZeroFeeModel(), riskConfig: riskLimits({ minRiskReward: 3 }) });
  try {
    const outcome = await session.submitFromStrategy({ market: snapshotFrom(UPTREND) });
    assert.equal(outcome.signal, true, 'the strategy did emit a proposal');
    assert.equal(outcome.approved, false);
    assert.equal(outcome.executed, false);
    assert.equal(outcome.reasonCode, 'INVALID_RISK_REWARD');
    assert.equal((await session.getOpenPositions()).length, 0);
  } finally {
    await cleanup();
  }
});

test('strategy: the default registry exposes the built-in MA strategy', () => {
  const registry = createDefaultStrategyRegistry();
  assert.deepEqual(registry.list(), [MA_CROSSOVER_ID]);
  assert.equal(registry.get(MA_CROSSOVER_ID).id, MA_CROSSOVER_ID);
});

test('strategy: an emitted decision is journalled', async () => {
  const { session, cleanup } = await makeSession({ fees: createZeroFeeModel() });
  try {
    await session.submitFromStrategy({ market: snapshotFrom(UPTREND) });
    await session.flushJournal();

    const { events } = await session.journal.read();
    const decision = events.find((event) => event.eventType === 'STRATEGY_DECISION');
    assert.ok(decision, 'an emitted strategy decision must be journalled');
    assert.equal(decision.metadata.action, 'EMIT');
    assert.equal(decision.metadata.strategyId, MA_CROSSOVER_ID);
    assert.equal(decision.side, 'LONG');
    assert.equal(decision.symbol, 'BTCUSDT');
  } finally {
    await cleanup();
  }
});

test('strategy: a no-signal decision is journalled, not silently dropped', async () => {
  const { session, cleanup } = await makeSession({ fees: createZeroFeeModel() });
  try {
    const outcome = await session.submitFromStrategy({ market: snapshotFrom(FLAT) });
    assert.equal(outcome.signal, false);

    const { events } = await session.journal.read();
    const decision = events.find((event) => event.eventType === 'STRATEGY_DECISION');
    assert.ok(decision, 'a deliberate no-signal must be recorded');
    assert.equal(decision.metadata.action, 'NO_SIGNAL');
    assert.equal(decision.reason, 'NO_SIGNAL');
  } finally {
    await cleanup();
  }
});

test('strategy: the runtime kill switch blocks an emitted proposal, then releases', async () => {
  const { session, cleanup } = await makeSession({ fees: createZeroFeeModel() });
  try {
    const engaged = await session.engageKillSwitch('TEST');
    assert.equal(engaged.engaged, true);
    assert.equal(session.killSwitchState().reason, 'TEST');

    const blocked = await session.submitFromStrategy({ market: snapshotFrom(UPTREND) });
    assert.equal(blocked.signal, true, 'the strategy still emitted a proposal');
    assert.equal(blocked.approved, false);
    assert.equal(blocked.executed, false);
    assert.equal(blocked.reasonCode, 'KILL_SWITCH_ENGAGED');
    assert.equal((await session.getOpenPositions()).length, 0);

    const { events } = await session.journal.read();
    const types = events.map((event) => event.eventType);
    assert.ok(types.includes('KILL_SWITCH_ENGAGED'), 'engaging the switch is audited');
    assert.ok(
      events.some((event) => event.eventType === 'RISK_REJECTED' && event.reason === 'KILL_SWITCH_ENGAGED'),
      'the blocked proposal is audited with the kill-switch reason',
    );

    await session.disengageKillSwitch();
    const resumed = await session.submitFromStrategy({ market: snapshotFrom(UPTREND) });
    assert.equal(resumed.executed, true, 'trading resumes once the switch is released');
    assert.equal((await session.getOpenPositions()).length, 1);
  } finally {
    await cleanup();
  }
});

test('strategy: a config-level kill switch blocks even without a runtime engage', async () => {
  const { session, cleanup } = await makeSession({
    fees: createZeroFeeModel(),
    riskConfig: riskLimits({ killSwitchEnabled: true }),
  });
  try {
    const outcome = await session.submitFromStrategy({ market: snapshotFrom(UPTREND) });
    assert.equal(outcome.approved, false);
    assert.equal(outcome.reasonCode, 'KILL_SWITCH_ENGAGED');
    assert.equal((await session.getOpenPositions()).length, 0);
  } finally {
    await cleanup();
  }
});

test('strategy: a throwing strategy fails closed and is audited', async () => {
  const registry = createStrategyRegistry([
    defineStrategy({
      id: 'exploding',
      evaluate() {
        throw new Error('kaboom');
      },
    }),
  ]);
  const { session, cleanup } = await makeSession({ fees: createZeroFeeModel(), strategyRegistry: registry });
  try {
    const outcome = await session.submitFromStrategy({ market: snapshotFrom(UPTREND) });
    assert.equal(outcome.signal, false);
    assert.equal(outcome.reasonCode, 'NO_SIGNAL');
    assert.equal((await session.getOpenPositions()).length, 0);

    const { events } = await session.journal.read();
    const decision = events.find((event) => event.eventType === 'STRATEGY_DECISION');
    assert.ok(decision);
    assert.equal(decision.metadata.action, 'NO_SIGNAL');
    assert.equal(decision.reason, 'STRATEGY_ERROR');
  } finally {
    await cleanup();
  }
});

test('strategy: sizing is owned by the Risk Engine, never the strategy', async () => {
  const strategy = createMaCrossoverStrategy();
  const proposal = strategy.evaluate(buildMarketContext(snapshotFrom(UPTREND), strategy.indicators));
  assert.ok(proposal, 'expected a proposal for the uptrend fixture');
  assert.ok(!('quantity' in proposal), 'a strategy must not size a position');
  assert.ok(!('leverage' in proposal), 'a strategy must not choose leverage');

  const { session, cleanup } = await makeSession({ fees: createZeroFeeModel() });
  try {
    const outcome = await session.submitFromStrategy({ market: snapshotFrom(UPTREND) });
    assert.ok(outcome.riskResult.estimatedQuantity > 0, 'the Risk Engine produced the size');
    assert.ok(outcome.riskResult.positionNotionalUsd > 0);
  } finally {
    await cleanup();
  }
});
