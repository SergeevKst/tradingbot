#!/usr/bin/env node
/**
 * Stage 1 bootstrap — a deterministic, offline demonstration of the trading
 * core. It wires config -> risk -> paper execution and nothing else.
 *
 * Deliberately NOT present in this process:
 *   - no exchange client, no MCP client, no HTTP;
 *   - no DeepSeek / AI call;
 *   - no order, leverage or account-setting call of any kind.
 *
 * Run: node --env-file=.env src/index.mjs
 */
import { describeConfig, loadConfig } from './config/env.mjs';
import { TRADING_MODE } from './config/trading-mode.mjs';
import { createOfflineAccountState } from './domain/account-state.mjs';
import { createRiskEngine } from './risk/risk-engine.mjs';
import { createPaperExecutor } from './execution/paper-executor.mjs';
import { createLogger } from './util/logger.mjs';

const logger = createLogger('MAIN');

function main() {
  // Configuration is validated at startup; an invalid TRADING_MODE or risk
  // limit throws here, before anything else can run.
  const config = loadConfig();

  logger.info('configuration loaded', {
    mode: config.tradingMode,
    testnet: config.testnet,
    logLevel: config.logLevel,
    // Named so the redactor does not hide it: this is a presence flag, not a secret.
    keyPresent: config.credentials.hasApiKey,
  });
  logger.info('risk limits', { ...config.risk });

  const riskEngine = createRiskEngine({ riskConfig: config.risk, logger: createLogger('RISK') });
  const executor = createPaperExecutor({ logger: createLogger('PAPER') });

  if (config.tradingMode === TRADING_MODE.BACKTEST) {
    // BACKTEST has no data feed or simulation engine until a later stage, so it
    // deliberately stops here rather than rehearsing the PAPER pipeline.
    logger.warn('BACKTEST mode selected — no backtest engine exists yet in Stage 1; nothing to run');
    logger.info('stage 1 core ready', { mode: config.tradingMode, simulatedFills: 0, realOrdersPlaced: 0 });
    return;
  }

  // Offline account snapshot. In PAPER mode this stands in for a future live
  // snapshot; the Risk Engine always sizes from whatever equity it is given.
  const account = createOfflineAccountState({ equityUsd: config.risk.initialCapitalUsd });

  // A single hand-made proposal, used only to prove the pipeline is wired.
  // This is NOT a strategy and implies nothing about profitability.
  const proposal = {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 86000,
    stopLossPrice: 85280,
    takeProfitPrice: 87600,
    confidence: 0.5,
    strategyId: 'bootstrap-demo',
    timestamp: Date.now(),
  };

  logger.info('evaluating demonstration proposal', { note: 'deterministic core check, not a trade recommendation' });
  const result = riskEngine.evaluate({ proposal, account });

  if (result.approved) {
    const fill = executor.execute(proposal, result);
    logger.info('paper fill (simulated)', {
      symbol: fill.symbol,
      side: fill.side,
      qty: fill.estimatedQuantity ?? fill.quantity,
      notionalUsd: fill.notionalUsd,
      simulated: true,
    });
  } else {
    logger.info('proposal rejected', { reason: result.reasonCode, message: result.message });
  }

  logger.info('stage 1 core ready', {
    mode: config.tradingMode,
    simulatedFills: executor.count(),
    realOrdersPlaced: 0,
  });
}

try {
  main();
} catch (error) {
  // Configuration and startup failures are loud and explicit — never swallowed.
  createLogger('MAIN').error('startup failed', {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    field: /** @type {any} */ (error)?.field,
  });
  process.exitCode = 1;
}

export { describeConfig };