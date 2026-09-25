/**
 * Shared fixtures for the Stage 2 tests.
 *
 * Everything here is offline and deterministic: fixed instrument metadata, a
 * fixed book, fixed timestamps. No test in this stage touches the network, and
 * none of these numbers is a claim about real Bybit parameters — they are
 * plausible stand-ins whose only job is to make the arithmetic checkable.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaperSession } from '../src/session/paper-session.mjs';
import { createStaticMarketDataAdapter } from '../src/market/static-market-data-adapter.mjs';
import { createRateFeeModel, createZeroFeeModel } from '../src/state/fee-model.mjs';
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';

/** Instrument metadata used across the Stage 2 tests. */
export const BTC_INSTRUMENT = Object.freeze({
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
});

/** A silent logger, so tests do not spray output. */
export const quietLogger = Object.freeze({
  info() {},
  warn() {},
  error() {},
  debug() {},
});

/** Fee model used unless a test needs exact, fee-free arithmetic. */
export function feeModel(entryRate = 0.001, exitRate = 0.001) {
  return createRateFeeModel({ entryRate, exitRate });
}

export { createZeroFeeModel };

/**
 * Build a static market adapter with a book around a mid price.
 *
 * @param {number} mid
 * @param {{ spread?: number, instrument?: object, bid?: number | null, ask?: number | null }} [options]
 */
export function marketAt(mid, options = {}) {
  const spread = options.spread ?? 0.2;
  const half = spread / 2;
  return createStaticMarketDataAdapter({
    instrument: options.instrument ?? BTC_INSTRUMENT,
    ticker: {
      lastPrice: mid,
      markPrice: mid,
      bid: options.bid === undefined ? Number((mid - half).toFixed(1)) : options.bid,
      ask: options.ask === undefined ? Number((mid + half).toFixed(1)) : options.ask,
      volume: 1000,
    },
  });
}

/**
 * A proposal whose geometry clears the configured minimum RR.
 *
 * @param {Partial<{ symbol: string, side: 'LONG' | 'SHORT', entryPrice: number, stopLossPrice: number, takeProfitPrice: number, confidence: number, strategyId: string }>} [overrides]
 */
export function proposal(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 86000,
    // 720 risk against 1620 reward = 2.25R, comfortably above the 1.5 minimum.
    stopLossPrice: 85280,
    takeProfitPrice: 87620,
    confidence: 0.5,
    strategyId: 'test-fixture',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * A SHORT proposal with the same 2.25R geometry.
 *
 * @param {object} [overrides]
 */
export function shortProposal(overrides = {}) {
  return proposal({
    side: 'SHORT',
    stopLossPrice: 86720,
    takeProfitPrice: 84380,
    ...overrides,
  });
}

/**
 * Create a paper session backed by a throwaway temp directory.
 *
 * @param {{
 *   riskConfig?: object,
 *   fees?: import('../src/state/fee-model.mjs').FeeModel,
 *   initialEquityUsd?: number,
 *   now?: () => string,
 * }} [options]
 */
export async function makeSession(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'paper-test-'));
  const paths = {
    stateFile: join(directory, 'state.json'),
    journalFile: join(directory, 'journal.jsonl'),
    initialEquityUsd: options.initialEquityUsd ?? 340,
  };

  const build = (/** @type {object} */ overrides = {}) =>
    createPaperSession({
      riskConfig: options.riskConfig ?? DEFAULT_RISK_LIMITS,
      feeModel: options.fees ?? feeModel(),
      paths: { ...paths, ...overrides },
      logger: quietLogger,
      ...(options.now ? { now: options.now } : {}),
    });

  const session = await build();

  return {
    session,
    directory,
    paths,
    /** Restart the process' view of the same state files. */
    async restart(overrides = {}) {
      return build(overrides);
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}