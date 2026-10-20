/**
 * Phase 7 — backtest metrics (§28). Pure arithmetic, including the values that
 * are mathematically undefined and must be `null`, never `NaN`/`Infinity`.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  computeMetrics,
  computeMaxDrawdown,
  computeSharpeRatio,
  summarizeMetrics,
} from '../src/backtest/metrics.mjs';
import { ConfigError } from '../src/config/config-error.mjs';

test('METRICS: maximum drawdown is peak-to-trough', () => {
  const drawdown = computeMaxDrawdown([1000, 1010, 1000, 1030, 990]);
  assert.ok(Math.abs(drawdown.maxDrawdownUsd - 40) < 1e-9);
  assert.ok(Math.abs(drawdown.maxDrawdownPct - (40 / 1030) * 100) < 1e-9);
  assert.throws(() => computeMaxDrawdown([]), ConfigError);
});

test('METRICS: Sharpe-like ratio is undefined without dispersion', () => {
  assert.equal(computeSharpeRatio([0.01], 1), null, 'one observation has no variance');
  assert.equal(computeSharpeRatio([0.01, 0.01, 0.01], 1), null, 'zero variance is undefined');
  assert.ok(Math.abs(computeSharpeRatio([0.01, -0.01, 0.02, -0.02], 1) - 0) < 1e-9);

  const annualized = computeSharpeRatio([0.01, 0.02, 0.0], 252);
  const perPeriod = computeSharpeRatio([0.01, 0.02, 0.0], 1);
  assert.ok(Math.abs(annualized - perPeriod * Math.sqrt(252)) < 1e-9);
  assert.throws(() => computeSharpeRatio([0.01, 0.02], 0), ConfigError);
});

test('METRICS: the full metric set is computed from the curve and trades', () => {
  const metrics = computeMetrics({
    equityCurve: [
      { equityUsd: 1010, openPositions: 1 },
      { equityUsd: 1000, openPositions: 0 },
      { equityUsd: 1030, openPositions: 1 },
      { equityUsd: 990, openPositions: 0 },
    ],
    trades: [{ netPnlUsd: 50 }, { netPnlUsd: -20 }, { netPnlUsd: -30 }],
    initialEquityUsd: 1000,
    feesUsd: 7,
    slippageUsd: 3,
    liquidationEvents: 1,
    periodsPerYear: 1,
  });

  assert.equal(metrics.finalEquityUsd, 990);
  assert.equal(metrics.netPnlUsd, -10);
  assert.ok(Math.abs(metrics.totalReturnPct + 1) < 1e-9);
  assert.equal(metrics.grossProfitUsd, 50);
  assert.equal(metrics.grossLossUsd, 50);
  assert.equal(metrics.numberOfTrades, 3);
  assert.equal(metrics.wins, 1);
  assert.equal(metrics.losses, 2);
  assert.ok(Math.abs(metrics.winRate - 1 / 3) < 1e-9);
  assert.equal(metrics.averageWinUsd, 50);
  assert.equal(metrics.averageLossUsd, 25);
  assert.equal(metrics.profitFactor, 1);
  assert.equal(metrics.averageTradeUsd, 0);
  assert.ok(Math.abs(metrics.maxDrawdownUsd - 40) < 1e-9);
  assert.ok(Math.abs(metrics.exposurePct - 50) < 1e-9);
  assert.equal(metrics.feesUsd, 7);
  assert.equal(metrics.slippageUsd, 3);
  assert.equal(metrics.liquidationEvents, 1);
});

test('METRICS: undefined ratios are null, not NaN', () => {
  const metrics = computeMetrics({ equityCurve: [1000], initialEquityUsd: 1000 });
  assert.equal(metrics.numberOfTrades, 0);
  assert.equal(metrics.winRate, null);
  assert.equal(metrics.averageWinUsd, null);
  assert.equal(metrics.averageLossUsd, null);
  assert.equal(metrics.profitFactor, null, 'no losses means the factor is undefined, not infinite');
  assert.equal(metrics.averageTradeUsd, null);
  assert.equal(metrics.sharpeRatio, null);
  assert.deepEqual(summarizeMetrics(metrics).length > 0, true);
});

test('METRICS: malformed input is refused', () => {
  assert.throws(() => computeMetrics({ equityCurve: [], initialEquityUsd: 1000 }), ConfigError);
  assert.throws(() => computeMetrics({ equityCurve: [1000], initialEquityUsd: 0 }), ConfigError);
  assert.throws(
    () => computeMetrics({ equityCurve: [1000], initialEquityUsd: 1000, trades: [{ netPnlUsd: 'x' }] }),
    ConfigError,
  );
});
