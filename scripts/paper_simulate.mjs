#!/usr/bin/env node
/**
 * `paper:simulate` — drive the FULL paper pipeline against live public market
 * data: proposal -> risk -> paper execution -> persistence -> journal.
 *
 * This is the manual harness for inspecting the paper loop. It places no real
 * orders (it cannot — the executor has no exchange client) and implements no
 * strategy: the proposal below is a fixed fixture derived from the current
 * market, used to exercise the plumbing.
 *
 * Usage:
 *   npm run paper:simulate
 *   npm run paper:simulate -- --symbol ETHUSDT
 *   npm run paper:simulate -- --side SHORT
 *   npm run paper:simulate -- --close
 */
import { loadConfig } from '../src/config/env.mjs';
import { createRateFeeModel } from '../src/state/fee-model.mjs';
import { createPaperSession } from '../src/session/paper-session.mjs';
import { createRestMarketDataAdapter } from '../src/market/rest-market-data-adapter.mjs';
import { normalizePrice } from '../src/market/normalize.mjs';
import { createLogger } from '../src/util/logger.mjs';

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

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const logger = createLogger('SIMULATE');

try {
  const marketData = createRestMarketDataAdapter({
    baseUrl: config.bybitBaseUrl,
    category: config.paper.market.category,
    timeoutMs: config.paper.market.requestTimeoutMs,
  });

  const session = await createPaperSession({
    riskConfig: config.risk,
    feeModel: createRateFeeModel({ entryRate: config.paper.takerFeeRate, exitRate: config.paper.exitFeeRate }),
    paths: {
      stateFile: config.paper.stateFile,
      journalFile: config.paper.journalFile,
      initialEquityUsd: config.risk.initialCapitalUsd,
      persist: config.paper.persist,
    },
    logger: createLogger('PAPER'),
  });

  const symbol = String(args.symbol ?? 'BTCUSDT').toUpperCase();
  const snapshot = await marketData.getSnapshot(symbol, {
    interval: config.paper.market.defaultInterval,
    candleLimit: 5,
    includeCandles: true,
  });

  console.log('MARKET');
  console.log('  symbol      :', snapshot.symbol);
  console.log('  last/mark   :', snapshot.lastPrice, '/', snapshot.markPrice);
  console.log('  bid/ask     :', snapshot.bid, '/', snapshot.ask, 'spread', snapshot.spread);
  console.log('  tick/qtyStep:', snapshot.instrument?.tickSize, '/', snapshot.instrument?.qtyStep);
  console.log('  candles     :', snapshot.candles.length);
  console.log('');

  // Re-price restored positions and process any stop/target first.
  const update = await session.onMarketUpdate(snapshot);
  for (const closed of update.closed) {
    console.log(`CLOSED ${closed.symbol} by ${closed.exitReason}, net PnL ${closed.netPnlUsd.toFixed(4)} USD`);
  }
  if (update.errors.length > 0) {
    for (const error of update.errors) console.log('  warning:', error);
  }

  if (args.close) {
    const positions = await session.getOpenPositions();
    if (positions.length === 0) {
      console.log('Nothing to close.');
    }
    for (const position of positions) {
      const result = await session.closePosition({ symbol: position.symbol, market: snapshot, reason: 'MANUAL' });
      console.log(
        result.ok
          ? `CLOSED ${position.symbol} at ${result.fill.fillPrice}, net ${result.fill.netPnlUsd.toFixed(4)} USD`
          : `close failed: ${result.reasonCode} — ${result.message}`,
      );
    }
  } else if (!args.state) {
    // Build a fixture proposal from live market data. This is NOT a strategy: a
    // 2% stop and a 4% target give a clean 2R, comfortably clear of the 1.5
    // minimum. Exactly-at-the-limit geometry is avoided deliberately, because a
    // value that is mathematically 1.5R can land a hair below it in binary
    // floating point — and the Risk Engine quite rightly refuses that.
    const repair = (value) => {
      const normalized = normalizePrice(value, snapshot.instrument.tickSize);
      return normalized.ok ? normalized.value : value;
    };

    const side = String(args.side ?? 'LONG').toUpperCase();
    const isLong = side === 'LONG';

    const entryPrice = repair(isLong ? snapshot.ask : snapshot.bid);
    const stopLossPrice = repair(priceAtDistance(entryPrice, isLong ? -0.02 : 0.02));
    const takeProfitPrice = repair(priceAtDistance(entryPrice, isLong ? 0.04 : -0.04));

    const proposal = {
      symbol,
      side,
      entryPrice,
      stopLossPrice,
      takeProfitPrice,
      confidence: 0.5,
      strategyId: 'paper-simulate-fixture',
      timestamp: Date.now(),
    };

    console.log('PROPOSAL (fixed plumbing fixture — not a strategy)');
    console.log(' ', JSON.stringify(proposal));
    console.log('');

    const outcome = await session.submit({ proposal, market: snapshot });

    if (outcome.approved && outcome.executed) {
      const fill = outcome.executionResult.fill;
      console.log('EXECUTED (simulated)');
      console.log('  requested :', fill.requestedPrice);
      console.log('  filled    :', fill.fillPrice, `(${fill.side === 'LONG' ? 'ask' : 'bid'} market entry)`);
      console.log('  slippage  :', fill.slippageUsd.toFixed(6), 'USD');
      console.log('  quantity  :', fill.quantity);
      console.log('  notional  :', fill.notionalUsd.toFixed(2), 'USD');
      console.log('  entry fee :', fill.feeUsd.toFixed(6), 'USD');
      console.log('  risk      :', outcome.riskResult.riskAmountUsd.toFixed(4), 'USD');
      console.log('  R:R       :', outcome.riskResult.riskReward.toFixed(4));
    } else {
      console.log('NOT EXECUTED');
      console.log('  approved  :', outcome.approved);
      console.log('  reason    :', outcome.reasonCode);
      console.log('  message   :', outcome.message ?? '(none)');
    }
  }

  const account = await session.getAccountState();
  console.log('');
  console.log('ACCOUNT');
  console.log('  equity    :', account.equityUsd.toFixed(4), 'USD');
  console.log('  available :', account.availableBalanceUsd.toFixed(4), 'USD');
  console.log('  realized  :', account.realizedPnlUsd.toFixed(4), 'USD');
  console.log('  unrealized:', account.unrealizedPnlUsd.toFixed(4), 'USD');
  console.log('  fees      :', account.feesUsd.toFixed(4), 'USD');
  console.log('  positions :', account.positions.length);
  console.log('  trades/day:', account.tradesToday, '/', config.risk.maxTradesPerDay);
  console.log('');
  console.log(`mark price used: ${snapshot.markPrice} | real orders placed: 0`);
} catch (error) {
  console.error('paper:simulate failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

/**
 * @param {number} price
 * @param {number} fraction
 * @returns {number}
 */
function priceAtDistance(price, fraction) {
  return price * (1 + fraction);
}