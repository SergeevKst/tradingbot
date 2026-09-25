#!/usr/bin/env node
/**
 * PAPER bootstrap — wires config -> market data -> session -> risk -> paper
 * execution and nothing else.
 *
 * Deliberately NOT present in this process:
 *   - no exchange order/account write call of any kind;
 *   - no DeepSeek / LLM call;
 *   - no trading strategy (the proposal below is a fixed plumbing fixture).
 *
 * In PAPER mode no API key is required: market data is public and the account is
 * local. Run: node --env-file=.env src/index.mjs
 */
import { describeConfig, loadConfig } from './config/env.mjs';
import { TRADING_MODE } from './config/trading-mode.mjs';
import { createRateFeeModel } from './state/fee-model.mjs';
import { createPaperSession } from './session/paper-session.mjs';
import { createRestMarketDataAdapter } from './market/rest-market-data-adapter.mjs';
import { createLogger } from './util/logger.mjs';

const logger = createLogger('MAIN');

async function main() {
  // Configuration is validated at startup; an invalid TRADING_MODE or risk
  // limit throws here, before anything else can run.
  const config = loadConfig();

  logger.info('configuration loaded', {
    mode: config.tradingMode,
    testnet: config.testnet,
    logLevel: config.logLevel,
    // This build of the core never reads credentials, so there is nothing to
    // report about them — PAPER runs entirely on public market data.
    credentialsRequired: false,
  });
  logger.info('risk limits', { ...config.risk });

  if (config.tradingMode === TRADING_MODE.BACKTEST) {
    // BACKTEST has no data feed or simulation engine until a later stage, so it
    // deliberately stops here rather than rehearsing the PAPER pipeline.
    logger.warn('BACKTEST mode selected — no backtest engine exists yet; nothing to run');
    logger.info('core ready', { mode: config.tradingMode, simulatedFills: 0, realOrdersPlaced: 0 });
    return;
  }

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

  const account = await session.getAccountState();
  logger.info(session.restored ? 'paper state restored from disk' : 'new paper account created', {
    equityUsd: account.equityUsd,
    initialEquityUsd: account.initialEquityUsd,
    openPositions: account.positions.length,
    tradesToday: account.tradesToday,
  });

  // Public market data only; no credentials involved.
  const marketData = createRestMarketDataAdapter({
    baseUrl: config.bybitBaseUrl,
    category: config.paper.market.category,
    timeoutMs: config.paper.market.requestTimeoutMs,
  });

  const symbol = config.paper.defaultSymbol;
  const snapshot = await marketData.getSnapshot(symbol, {
    interval: config.paper.market.defaultInterval,
    candleLimit: 5,
    includeCandles: true,
  });

  logger.info('market snapshot', {
    symbol: snapshot.symbol,
    last: snapshot.lastPrice,
    mark: snapshot.markPrice,
    bid: snapshot.bid,
    ask: snapshot.ask,
    spread: snapshot.spread,
    candles: snapshot.candles.length,
    tickSize: snapshot.instrument?.tickSize,
    qtyStep: snapshot.instrument?.qtyStep,
  });

  // Re-price any restored positions against the current market before doing
  // anything else, so stops and targets are evaluated on live data.
  const marketUpdate = await session.onMarketUpdate(snapshot);
  if (marketUpdate.closed.length > 0) {
    for (const closed of marketUpdate.closed) {
      logger.info('position closed by market update', {
        symbol: closed.symbol,
        exitReason: closed.exitReason,
        netPnlUsd: closed.netPnlUsd,
      });
    }
  }

  logger.info('paper engine ready', {
    mode: config.tradingMode,
    restorable: true,
    stateFile: config.paper.stateFile,
    journalFile: config.paper.journalFile,
    realOrdersPlaced: 0,
    note: 'submit proposals via npm run paper:simulate',
  });
}

try {
  await main();
} catch (error) {
  // Configuration, state-recovery and startup failures are loud and explicit —
  // never swallowed, and never resolved by inventing a fresh account.
  createLogger('MAIN').error('startup failed', {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    field: /** @type {any} */ (error)?.field,
  });
  process.exitCode = 1;
}

export { describeConfig };