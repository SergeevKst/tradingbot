/**
 * Backtest metrics (MASTER_SPEC §28).
 *
 * Pure functions over an equity curve and a list of closed round trips. Every
 * ratio that is mathematically undefined (Sharpe with zero variance, profit
 * factor with no losses) is returned as `null` rather than `Infinity`/`NaN`, so
 * a report can never be corrupted by a division that quietly produced garbage.
 *
 * "Nonetheless, do not optimize solely for total return" (§28): the full set is
 * reported, including drawdown, exposure and cost, so a headline number cannot
 * be read in isolation.
 *
 * @module backtest/metrics
 */
import { ConfigError } from '../config/config-error.mjs';

/**
 * @typedef {object} BacktestMetrics
 * @property {number} initialEquityUsd
 * @property {number} finalEquityUsd
 * @property {number} netPnlUsd
 * @property {number} totalReturnPct
 * @property {number} grossProfitUsd
 * @property {number} grossLossUsd
 * @property {number | null} winRate fraction in [0, 1], null when there were no trades
 * @property {number} wins
 * @property {number} losses
 * @property {number} breakEvenTrades
 * @property {number | null} averageWinUsd
 * @property {number | null} averageLossUsd positive magnitude
 * @property {number | null} profitFactor gross profit / gross loss, null when there were no losses
 * @property {number} maxDrawdownUsd
 * @property {number} maxDrawdownPct
 * @property {number | null} sharpeRatio null when undefined (fewer than two periods or zero variance)
 * @property {number} numberOfTrades
 * @property {number | null} averageTradeUsd net PnL per trade, null when there were no trades
 * @property {number} exposurePct percent of bars holding at least one position
 * @property {number} feesUsd
 * @property {number} slippageUsd
 * @property {number} liquidationEvents
 * @property {number} periodsPerYear annualization factor used for Sharpe
 */

/**
 * Peak-to-trough drawdown of an equity series.
 *
 * @param {readonly number[]} values
 * @returns {{ maxDrawdownUsd: number, maxDrawdownPct: number }}
 */
export function computeMaxDrawdown(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ConfigError('computeMaxDrawdown requires a non-empty array');
  }
  let peak = values[0];
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    const drawdown = peak - value;
    if (drawdown > maxDrawdownUsd) maxDrawdownUsd = drawdown;
    const pct = peak > 0 ? (drawdown / peak) * 100 : 0;
    if (pct > maxDrawdownPct) maxDrawdownPct = pct;
  }
  return { maxDrawdownUsd, maxDrawdownPct };
}

/**
 * Sharpe-like ratio of a per-period return series.
 *
 * Uses the sample standard deviation (n−1). Returns null when there are fewer
 * than two returns or the variance is zero — a ratio with no dispersion is not
 * a number anyone should report.
 *
 * @param {readonly number[]} returns per-period fractional returns
 * @param {number} periodsPerYear annualization factor (e.g. 365 for daily bars)
 * @returns {number | null}
 */
export function computeSharpeRatio(returns, periodsPerYear) {
  if (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0) {
    throw new ConfigError(`computeSharpeRatio requires periodsPerYear > 0, got ${JSON.stringify(periodsPerYear)}`);
  }
  if (!Array.isArray(returns) || returns.length < 2) return null;

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return null;
  const ratio = (mean / stdDev) * Math.sqrt(periodsPerYear);
  return Number.isFinite(ratio) ? ratio : null;
}

/**
 * @param {readonly (number | { equityUsd: number, openPositions?: number })[]} equityCurve
 * @returns {{ values: number[], exposureBars: number }}
 */
function readEquityCurve(equityCurve) {
  if (!Array.isArray(equityCurve) || equityCurve.length === 0) {
    throw new ConfigError('computeMetrics requires a non-empty equityCurve');
  }
  /** @type {number[]} */
  const values = [];
  let exposureBars = 0;
  for (const [index, point] of equityCurve.entries()) {
    const value = typeof point === 'number' ? point : Number(/** @type {any} */ (point)?.equityUsd);
    if (!Number.isFinite(value)) {
      throw new ConfigError(`equityCurve[${index}] must be a finite equity value, got ${JSON.stringify(point)}`);
    }
    values.push(value);
    if (typeof point === 'object' && point !== null && Number(/** @type {any} */ (point).openPositions) > 0) {
      exposureBars += 1;
    }
  }
  return { values, exposureBars };
}

/**
 * Compute the full metrics set.
 *
 * @param {{
 *   equityCurve: readonly (number | { equityUsd: number, openPositions?: number })[],
 *   trades?: readonly { netPnlUsd: number }[],
 *   initialEquityUsd: number,
 *   feesUsd?: number,
 *   slippageUsd?: number,
 *   liquidationEvents?: number,
 *   periodsPerYear?: number,
 * }} input
 * @returns {Readonly<BacktestMetrics>}
 */
export function computeMetrics(input) {
  if (input === null || typeof input !== 'object') {
    throw new ConfigError('computeMetrics requires an input object');
  }
  const initialEquityUsd = Number(input.initialEquityUsd);
  if (!Number.isFinite(initialEquityUsd) || initialEquityUsd <= 0) {
    throw new ConfigError(`computeMetrics requires initialEquityUsd > 0, got ${JSON.stringify(input.initialEquityUsd)}`);
  }
  const periodsPerYear = input.periodsPerYear ?? 1;
  const { values, exposureBars } = readEquityCurve(input.equityCurve);

  const trades = Array.isArray(input.trades) ? input.trades : [];
  /** @type {number[]} */
  const tradePnls = [];
  for (const [index, trade] of trades.entries()) {
    const pnl = Number(/** @type {any} */ (trade)?.netPnlUsd);
    if (!Number.isFinite(pnl)) {
      throw new ConfigError(`trades[${index}].netPnlUsd must be a finite number, got ${JSON.stringify(trade)}`);
    }
    tradePnls.push(pnl);
  }

  const wins = tradePnls.filter((pnl) => pnl > 0);
  const losses = tradePnls.filter((pnl) => pnl < 0);
  const breakEvenTrades = tradePnls.length - wins.length - losses.length;
  const grossProfitUsd = wins.reduce((sum, pnl) => sum + pnl, 0);
  const grossLossUsd = -losses.reduce((sum, pnl) => sum + pnl, 0);
  const numberOfTrades = tradePnls.length;
  const netTradePnlUsd = grossProfitUsd - grossLossUsd;

  const finalEquityUsd = values[values.length - 1];
  const netPnlUsd = finalEquityUsd - initialEquityUsd;
  const totalReturnPct = (netPnlUsd / initialEquityUsd) * 100;
  const { maxDrawdownUsd, maxDrawdownPct } = computeMaxDrawdown([initialEquityUsd, ...values]);

  // Per-period returns use the initial capital as the first base, so the first
  // bar's move is included rather than silently dropped.
  const series = [initialEquityUsd, ...values];
  /** @type {number[]} */
  const returns = [];
  for (let index = 1; index < series.length; index += 1) {
    const base = series[index - 1];
    if (base > 0) returns.push((series[index] - base) / base);
  }

  return Object.freeze({
    initialEquityUsd,
    finalEquityUsd,
    netPnlUsd,
    totalReturnPct,
    grossProfitUsd,
    grossLossUsd,
    winRate: numberOfTrades > 0 ? wins.length / numberOfTrades : null,
    wins: wins.length,
    losses: losses.length,
    breakEvenTrades,
    averageWinUsd: wins.length > 0 ? grossProfitUsd / wins.length : null,
    averageLossUsd: losses.length > 0 ? grossLossUsd / losses.length : null,
    profitFactor: grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : null,
    maxDrawdownUsd,
    maxDrawdownPct,
    sharpeRatio: computeSharpeRatio(returns, periodsPerYear),
    numberOfTrades,
    averageTradeUsd: numberOfTrades > 0 ? netTradePnlUsd / numberOfTrades : null,
    exposurePct: (exposureBars / values.length) * 100,
    feesUsd: Number.isFinite(input.feesUsd) ? Number(input.feesUsd) : 0,
    slippageUsd: Number.isFinite(input.slippageUsd) ? Number(input.slippageUsd) : 0,
    liquidationEvents: Number.isFinite(input.liquidationEvents) ? Number(input.liquidationEvents) : 0,
    periodsPerYear,
  });
}

/**
 * Render metrics as human-readable lines for a CLI report.
 *
 * @param {Readonly<BacktestMetrics>} metrics
 * @returns {string[]}
 */
export function summarizeMetrics(metrics) {
  const pct = (value) => (value === null ? 'n/a' : `${value.toFixed(2)}%`);
  const num = (value, decimals = 2) => (value === null ? 'n/a' : value.toFixed(decimals));
  return [
    `  initial equity : ${metrics.initialEquityUsd.toFixed(2)} USD`,
    `  final equity   : ${metrics.finalEquityUsd.toFixed(2)} USD`,
    `  net PnL        : ${metrics.netPnlUsd.toFixed(2)} USD (${pct(metrics.totalReturnPct)})`,
    `  gross profit   : ${metrics.grossProfitUsd.toFixed(2)} USD`,
    `  gross loss     : ${metrics.grossLossUsd.toFixed(2)} USD`,
    `  profit factor  : ${num(metrics.profitFactor)}`,
    `  trades         : ${metrics.numberOfTrades} (win rate ${metrics.winRate === null ? 'n/a' : `${(metrics.winRate * 100).toFixed(1)}%`})`,
    `  avg win/loss   : ${num(metrics.averageWinUsd)} / ${num(metrics.averageLossUsd)} USD`,
    `  avg trade      : ${num(metrics.averageTradeUsd)} USD`,
    `  max drawdown   : ${metrics.maxDrawdownUsd.toFixed(2)} USD (${pct(metrics.maxDrawdownPct)})`,
    `  Sharpe-like    : ${num(metrics.sharpeRatio)} (x sqrt(${metrics.periodsPerYear}))`,
    `  exposure       : ${pct(metrics.exposurePct)}`,
    `  fees           : ${metrics.feesUsd.toFixed(2)} USD`,
    `  slippage       : ${metrics.slippageUsd.toFixed(2)} USD`,
    `  liquidations   : ${metrics.liquidationEvents}`,
  ];
}
