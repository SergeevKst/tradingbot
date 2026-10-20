#!/usr/bin/env node
/**
 * `backtest` — run the deterministic backtest engine end-to-end.
 *
 * Offline by construction: it loads candles from a local JSON/JSONL file, or
 * generates a deterministic synthetic series when no file is given. It reads no
 * `.env`, holds no credentials and cannot place an order.
 *
 * Usage:
 *   npm run backtest
 *   npm run backtest -- --file data/backtest/BTCUSDT-15m.json
 *   npm run backtest -- --strategy deterministic-ma-crossover --fee 0.001 --slippage 2 --spread 1
 */
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';
import { createRateFeeModel } from '../src/state/fee-model.mjs';
import { createMaCrossoverStrategy } from '../src/strategy/deterministic-ma-crossover.mjs';
import { runBacktest, loadHistoricalData, createStrategySignalSource, createRateSlippageModel, summarizeMetrics } from '../src/backtest/index.mjs';

/** Naive flag parsing: `--name value` and bare `--flag`. */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[token.slice(2)] = true;
    } else {
      args[token.slice(2)] = next;
      index += 1;
    }
  }
  return args;
}

/** Standard instrument stand-in; not a claim about a real venue's parameters. */
const INSTRUMENT = Object.freeze({
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

/**
 * A deterministic synthetic series, so the CLI runs with no data files at all.
 * A slow sine plus a faster harmonic gives the MA-crossover something to cross.
 *
 * @param {{ count?: number, basePrice?: number, stepMs?: number }} [options]
 */
function syntheticCandles(options = {}) {
  const count = options.count ?? 240;
  const basePrice = options.basePrice ?? 86_000;
  const stepMs = options.stepMs ?? 15 * 60 * 1000;
  const start = Date.UTC(2024, 0, 1);
  const round = (value) => Math.round(value * 10) / 10;

  const candles = [];
  let close = basePrice;
  for (let index = 0; index < count; index += 1) {
    const drift = Math.sin(index / 9) * 0.004 + Math.sin(index / 31) * 0.002;
    const open = close;
    close = basePrice * (1 + drift);
    candles.push({
      startTime: start + index * stepMs,
      open: round(open),
      high: round(Math.max(open, close) * 1.0015),
      low: round(Math.min(open, close) * 0.9985),
      close: round(close),
      volume: 100,
    });
  }
  return candles;
}

const args = parseArgs(process.argv.slice(2));

try {
  const symbol = String(args.symbol ?? 'BTCUSDT').toUpperCase();
  const interval = String(args.interval ?? '15');
  const feeRate = Number(args.fee ?? 0.001);
  const slippageBps = Number(args.slippage ?? 1);
  const spreadBps = Number(args.spread ?? 1);
  const initialEquityUsd = Number(args.equity ?? DEFAULT_RISK_LIMITS.initialCapitalUsd);

  let dataset;
  if (typeof args.file === 'string') {
    dataset = await loadHistoricalData({ source: args.file });
  } else {
    dataset = await loadHistoricalData({ source: syntheticCandles() });
  }

  const strategy = createMaCrossoverStrategy();
  const result = await runBacktest({
    candles: dataset.candles,
    symbol,
    instrument: { ...INSTRUMENT, symbol },
    signalSource: createStrategySignalSource(strategy),
    feeModel: createRateFeeModel({ entryRate: feeRate, exitRate: feeRate }),
    slippageModel: createRateSlippageModel({ rate: slippageBps / 10_000 }),
    riskConfig: DEFAULT_RISK_LIMITS,
    initialEquityUsd,
    spreadBps,
    interval,
  });

  console.log(`BACKTEST ${result.symbol} — ${result.bars} bars, ${result.endReason}`);
  console.log(`  strategy       : ${strategy.id}`);
  console.log(`  data source    : ${dataset.source}`);
  console.log('');
  console.log('METRICS');
  for (const line of summarizeMetrics(result.metrics)) console.log(line);
  console.log('');
  console.log('RESULT');
  console.log(`  trades         : ${result.trades.length}`);
  console.log(`  open positions : ${result.openPositions.length}`);
  console.log(`  journal events : ${result.journal.length}`);
  console.log(`  real orders    : 0 (backtest never has an exchange path)`);
} catch (error) {
  console.error('backtest failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
