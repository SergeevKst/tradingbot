/**
 * Shared fixtures for the Phase 7 backtest tests.
 *
 * Fixed instrument metadata, fixed start times and an injected clock-free
 * engine call make every assertion reproducible. None of these numbers is a
 * claim about a real venue.
 */
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';

export const INSTRUMENT = Object.freeze({
  symbol: 'BTCUSDT',
  status: 'Trading',
  baseCoin: 'BTC',
  quoteCoin: 'USDT',
  settleCoin: 'USDT',
  tickSize: 0.1,
  qtyStep: 0.001,
  minOrderQty: 0.001,
  maxOrderQty: 1500,
  maxLeverage: 150,
  minNotionalUsd: 5,
  receivedAt: '2024-01-01T00:00:00.000Z',
});

export const STEP_MS = 15 * 60 * 1000;
export const START_TIME = Date.UTC(2024, 0, 1);

/** A risk profile that will not throttle a short test run. */
export const BACKTEST_RISK = Object.freeze({
  ...DEFAULT_RISK_LIMITS,
  maxTradesPerDay: 100,
  maxOpenPositions: 1,
});

/**
 * @param {{ startTime: number, open: number, high: number, low: number, close: number, volume?: number }} input
 */
export function bar(input) {
  return {
    startTime: input.startTime,
    open: input.open,
    high: input.high,
    low: input.low,
    close: input.close,
    volume: input.volume ?? 100,
  };
}

/**
 * Build a valid series from closes, deriving high/low from the body.
 *
 * @param {number[]} closes
 * @param {{ startTime?: number, stepMs?: number, wick?: number }} [options]
 */
export function seriesFromCloses(closes, options = {}) {
  const startTime = options.startTime ?? START_TIME;
  const stepMs = options.stepMs ?? STEP_MS;
  const wick = options.wick ?? 0.001;
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1];
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    return bar({
      startTime: startTime + index * stepMs,
      open: round1(open),
      high: round1(bodyHigh * (1 + wick)),
      low: round1(bodyLow * (1 - wick)),
      close: round1(close),
    });
  });
}

/** @param {number} value */
export function round1(value) {
  return Math.round(value * 10) / 10;
}
