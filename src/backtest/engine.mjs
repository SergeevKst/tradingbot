/**
 * Backtest engine (MASTER_SPEC §27–29).
 *
 * Pipeline, reusing production logic unchanged wherever practical:
 *
 *   Historical candles
 *         -> Market replay (simulator/market-replay.mjs)
 *         -> Signal source (strategy and/or AI-gated)
 *         -> Risk Engine (evaluateTrade)              <- the same gate as PAPER
 *         -> Paper execution adapter                  <- the same fill/fee models
 *         -> Portfolio (PaperAccountState)
 *         -> Metrics
 *
 * What this module deliberately does NOT do:
 *   - contact an exchange or read credentials;
 *   - size a position (the Risk Engine owns sizing);
 *   - invoke `Date.now()` in its decision path — every timestamp comes from the
 *     bar being replayed, so a run is reproducible bit-for-bit.
 *
 * Determinism and intrabar honesty
 * --------------------------------
 * A bar hides the path between its open, high, low and close. The engine never
 * guesses that path: it tests the adverse extreme first (low before high for a
 * LONG, high before low for a SHORT) and then marks at the close. Entries fill
 * at the close, so a strategy cannot peek at the same bar's extremes.
 *
 * @module backtest/engine
 */
import { ConfigError } from '../config/config-error.mjs';
import { SIDE } from '../domain/side.mjs';
import { evaluateTrade, normalizeRiskLimits } from '../risk/risk-engine.mjs';
import { DEFAULT_RISK_LIMITS } from '../config/risk.mjs';
import { toRiskInstrumentView } from '../market/instrument-info.mjs';
import { assertFeeModel } from '../state/fee-model.mjs';
import { assertFillModel, createFullFillModel } from '../execution/fill-model.mjs';
import { createPaperExecutionAdapter } from '../execution/paper-execution-adapter.mjs';
import {
  createPaperAccountState,
  toRiskAccountView,
} from '../state/paper-account.mjs';
import {
  createDailyState,
  rollDailyStateIfNeeded,
  recordDailyActivity,
} from '../state/daily-state.mjs';
import { createJournal, createJournalEvent, JOURNAL_EVENT } from '../state/journal.mjs';
import { normalizeHistoricalCandles } from './historical-data.mjs';
import { assertSlippageModel, createZeroSlippageModel } from './slippage-model.mjs';
import { assertSignalSource } from './signal-source.mjs';
import { computeMetrics } from './metrics.mjs';
import { createMarketReplay } from '../simulator/market-replay.mjs';

const silentLogger = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

/**
 * @param {Readonly<import('../market/market-snapshot.mjs').MarketSnapshot>} snapshot
 */
function toRiskMarketView(snapshot) {
  return {
    markPrice: snapshot.markPrice,
    bestBid: snapshot.bid,
    bestAsk: snapshot.ask,
    instrument: snapshot.instrument ? toRiskInstrumentView(snapshot.instrument) : undefined,
  };
}

/**
 * @param {readonly { slippageUsd?: number }[]} fills
 */
function totalSlippageUsd(fills) {
  return fills.reduce((sum, fill) => sum + (Number.isFinite(fill?.slippageUsd) ? Number(fill.slippageUsd) : 0), 0);
}

/**
 * Run a deterministic historical backtest.
 *
 * @param {{
 *   candles: unknown[],
 *   symbol: string,
 *   instrument: object,
 *   signalSource: import('./signal-source.mjs').SignalSource,
 *   feeModel: import('../state/fee-model.mjs').FeeModel,
 *   fillModel?: import('../execution/fill-model.mjs').FillModel,
 *   slippageModel?: import('./slippage-model.mjs').SlippageModel,
 *   riskConfig?: import('../config/risk.mjs').RiskLimits,
 *   initialEquityUsd?: number,
 *   spreadBps?: number,
 *   interval?: string,
 *   candleWindow?: number,
 *   periodsPerYear?: number,
 *   closeAtEnd?: boolean,
 *   maxBars?: number,
 *   journalFile?: string,
 *   fs?: object,
 *   logger?: object,
 * }} options
 * @returns {Promise<object>}
 */
export async function runBacktest(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('runBacktest requires options');
  }
  if (typeof options.symbol !== 'string' || options.symbol.trim() === '') {
    throw new ConfigError('runBacktest requires a symbol');
  }
  if (options.instrument === null || typeof options.instrument !== 'object') {
    throw new ConfigError('runBacktest requires instrument metadata');
  }

  const symbol = options.symbol.trim().toUpperCase();
  const candles = normalizeHistoricalCandles(options.candles);
  const signalSource = assertSignalSource(options.signalSource);
  const feeModel = assertFeeModel(options.feeModel);
  const fillModel = assertFillModel(options.fillModel ?? createFullFillModel());
  const slippageModel = assertSlippageModel(options.slippageModel ?? createZeroSlippageModel());
  const riskConfig = normalizeRiskLimits(options.riskConfig ?? DEFAULT_RISK_LIMITS);
  const logger = options.logger ?? silentLogger;
  const interval = options.interval ?? '15';
  const spreadBps = options.spreadBps ?? 1;
  const candleWindow = Number.isInteger(options.candleWindow) && options.candleWindow > 0 ? options.candleWindow : 200;
  const periodsPerYear = options.periodsPerYear ?? 1;
  const closeAtEnd = options.closeAtEnd !== false;
  const initialEquityUsd = Number.isFinite(options.initialEquityUsd)
    ? Number(options.initialEquityUsd)
    : riskConfig.initialCapitalUsd;
  if (!Number.isFinite(initialEquityUsd) || initialEquityUsd <= 0) {
    throw new ConfigError(`runBacktest requires initialEquityUsd > 0, got ${JSON.stringify(options.initialEquityUsd)}`);
  }

  const replay = createMarketReplay({ symbol, instrument: options.instrument, interval, spreadBps, slippageModel });

  /** Every event the run produced, in order. */
  const journal = [];
  /**
   * @param {string} eventType
   * @param {{ symbol?: string | null, side?: string | null, quantity?: number | null, price?: number | null, pnl?: number | null, fee?: number | null, reason?: string | null, metadata?: object }} fields
   */
  function pushEvent(eventType, fields) {
    try {
      journal.push(
        createJournalEvent({
          eventType,
          timestamp: currentIso,
          symbol: fields.symbol ?? null,
          side: fields.side ?? null,
          quantity: fields.quantity ?? null,
          price: fields.price ?? null,
          pnl: fields.pnl ?? null,
          fee: fields.fee ?? null,
          reason: fields.reason ?? null,
          metadata: fields.metadata ?? {},
        }),
      );
    } catch (error) {
      logger.warn('backtest could not record a journal event', {
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let currentIso = new Date(candles[0].startTime).toISOString();
  const now = () => currentIso;

  let account = createPaperAccountState({ equityUsd: initialEquityUsd });
  account = Object.freeze({ ...account, lastUpdatedAt: currentIso });
  let daily = createDailyState({ equityUsd: initialEquityUsd, timestamp: candles[0].startTime });

  const adapter = createPaperExecutionAdapter({
    account,
    feeModel,
    fillModel,
    logger,
    now,
    journal(event) {
      pushEvent(event.eventType, {
        symbol: event.symbol,
        side: event.side,
        quantity: event.quantity,
        price: event.price,
        pnl: event.pnl,
        fee: event.fee,
        reason: event.reason,
        metadata: event.metadata,
      });
    },
  });

  /** Reset daily counters when the replayed day changes. */
  function syncDaily() {
    const snapshot = adapter.snapshot();
    const rolled = rollDailyStateIfNeeded(daily, { timestamp: Date.parse(currentIso), equityUsd: snapshot.equityUsd });
    if (rolled === daily) return;
    daily = rolled;
    adapter.setAccount(
      Object.freeze({
        ...snapshot,
        tradesToday: 0,
        dailyRealizedPnlUsd: 0,
        dayStartEquityUsd: daily.dayStartEquityUsd,
        lastUpdatedAt: currentIso,
      }),
    );
  }

  /** Apply a realized result to the day's counters and the account view. */
  function applyDaily(realizedPnlUsd, countTrade) {
    daily = recordDailyActivity(daily, { realizedPnlUsd, countTrade, timestamp: Date.parse(currentIso) });
    const snapshot = adapter.snapshot();
    adapter.setAccount(
      Object.freeze({
        ...snapshot,
        tradesToday: daily.tradesToday,
        dailyRealizedPnlUsd: daily.dailyRealizedPnlUsd,
        dayStartEquityUsd: daily.dayStartEquityUsd,
        lastUpdatedAt: currentIso,
      }),
    );
  }

  /** Closed round trips (used for win-rate / profit-factor metrics). */
  const trades = [];
  /** Every fill, entry and exit (used for the slippage total). */
  const fills = [];
  const equityCurve = [];
  let liquidationEvents = 0;
  let endReason = 'COMPLETED';

  pushEvent(JOURNAL_EVENT.BACKTEST_STARTED, {
    symbol,
    metadata: {
      bars: candles.length,
      initialEquityUsd,
      spreadBps,
      interval,
      feeModel: feeModel.kind(),
      fillModel: fillModel.kind(),
      slippageModel: slippageModel.kind(),
    },
  });

  const barCount = Number.isInteger(options.maxBars) && options.maxBars > 0 ? Math.min(options.maxBars, candles.length) : candles.length;

  for (let index = 0; index < barCount; index += 1) {
    const candle = candles[index];
    currentIso = new Date(candle.startTime).toISOString();
    syncDaily();

    const window = candles.slice(Math.max(0, index - candleWindow + 1), index + 1);

    // --- 1. protective exits on this bar's extremes, adverse side first ----
    const openBefore = adapter.snapshot().positions.some((position) => position.symbol === symbol);
    if (openBefore) {
      const position = adapter.snapshot().positions.find((candidate) => candidate.symbol === symbol);
      const order = position.side === SIDE.LONG ? ['low', 'high'] : ['high', 'low'];
      for (const which of order) {
        if (!adapter.snapshot().positions.some((candidate) => candidate.symbol === symbol)) break;
        const outcome = await adapter.onMarketUpdate(replay.extreme(candle, which, window));
        for (const closed of outcome.closed) {
          applyDaily(closed.netPnlUsd, false);
          trades.push(closed.fill);
          fills.push(closed.fill);
        }
        if (outcome.errors.length > 0) {
          pushEvent(JOURNAL_EVENT.BACKTEST_BAR, {
            symbol,
            reason: 'TRIGGER_ERROR',
            metadata: { index, errors: outcome.errors },
          });
        }
      }
    }

    // --- 2. mark any remaining position to the close -----------------------
    const closeSnapshot = replay.close(candle, window);
    const markOutcome = await adapter.onMarketUpdate(closeSnapshot);
    for (const closed of markOutcome.closed) {
      applyDaily(closed.netPnlUsd, false);
      trades.push(closed.fill);
      fills.push(closed.fill);
    }

    // --- 3. strategy (and optional AI gate) at the close -------------------
    let proposal = null;
    try {
      proposal = await signalSource({
        market: closeSnapshot,
        candles: window,
        index,
        account: adapter.snapshot(),
        dailyState: daily,
        riskConfig,
      });
    } catch (error) {
      // A crashing signal source fails closed: no signal, never a trade.
      pushEvent(JOURNAL_EVENT.BACKTEST_BAR, {
        symbol,
        reason: 'SIGNAL_ERROR',
        metadata: { index, error: error instanceof Error ? error.message : String(error) },
      });
      logger.warn('backtest signal source threw — treating as no signal', {
        index,
        error: error instanceof Error ? error.message : String(error),
      });
      proposal = null;
    }

    if (proposal !== null && proposal !== undefined) {
      pushEvent(JOURNAL_EVENT.SIGNAL_RECEIVED, {
        symbol: proposal.symbol ?? symbol,
        side: proposal.side ?? null,
        metadata: {
          entryPrice: proposal.entryPrice ?? null,
          stopLossPrice: proposal.stopLossPrice ?? null,
          takeProfitPrice: proposal.takeProfitPrice ?? null,
          strategyId: proposal.strategyId ?? null,
          confidence: proposal.confidence ?? null,
          mode: 'BACKTEST',
        },
      });

      const riskResult = evaluateTrade({
        proposal,
        account: toRiskAccountView(adapter.snapshot()),
        market: toRiskMarketView(closeSnapshot),
        riskConfig,
        killSwitchEngaged: false,
      });

      if (!riskResult.approved) {
        pushEvent(JOURNAL_EVENT.RISK_REJECTED, {
          symbol: riskResult.symbol ?? proposal.symbol ?? null,
          side: riskResult.side ?? proposal.side ?? null,
          reason: riskResult.reasonCode,
          metadata: { message: riskResult.message },
        });
      } else {
        pushEvent(JOURNAL_EVENT.RISK_ACCEPTED, {
          symbol: riskResult.symbol,
          side: riskResult.side,
          quantity: riskResult.estimatedQuantity,
          reason: riskResult.reasonCode,
          metadata: {
            riskAmountUsd: riskResult.riskAmountUsd,
            positionNotionalUsd: riskResult.positionNotionalUsd,
            riskReward: riskResult.riskReward,
          },
        });

        const execution = await adapter.openPosition({ proposal, riskResult, market: closeSnapshot });
        if (!execution.ok) {
          pushEvent(JOURNAL_EVENT.RISK_REJECTED, {
            symbol: proposal.symbol,
            side: proposal.side,
            reason: execution.reasonCode,
            metadata: { message: execution.message, stage: 'backtest-executor' },
          });
        } else {
          // A completed entry consumes one daily trade slot, exactly as in PAPER.
          applyDaily(0, true);
          fills.push(execution.fill);
        }
      }
    }

    // --- 4. equity point ----------------------------------------------------
    const snapshot = adapter.snapshot();
    equityCurve.push({ timestamp: candle.startTime, equityUsd: snapshot.equityUsd, openPositions: snapshot.positions.length });

    if (snapshot.equityUsd <= 0) {
      liquidationEvents += 1;
      endReason = 'LIQUIDATED';
      pushEvent(JOURNAL_EVENT.BACKTEST_BAR, {
        symbol,
        reason: 'LIQUIDATION',
        metadata: { index, equityUsd: snapshot.equityUsd },
      });
      break;
    }
  }

  // --- 5. settle anything still open at the final close --------------------
  if (closeAtEnd && endReason === 'COMPLETED' && adapter.snapshot().positions.length > 0) {
    const lastIndex = (equityCurve.length > 0 ? equityCurve.length : barCount) - 1;
    const candle = candles[Math.max(0, Math.min(lastIndex, candles.length - 1))];
    currentIso = new Date(candle.startTime).toISOString();
    const window = candles.slice(Math.max(0, lastIndex - candleWindow + 1), lastIndex + 1);
    const closeSnapshot = replay.close(candle, window);
    for (const position of [...adapter.snapshot().positions]) {
      const result = await adapter.closePosition({ symbol: position.symbol, market: closeSnapshot, reason: 'BACKTEST_END' });
      if (result.ok) {
        applyDaily(result.fill.netPnlUsd, false);
        trades.push(result.fill);
        fills.push(result.fill);
      } else {
        pushEvent(JOURNAL_EVENT.BACKTEST_BAR, {
          symbol: position.symbol,
          reason: 'END_CLOSE_FAILED',
          metadata: { reasonCode: result.reasonCode, message: result.message },
        });
      }
    }
    const snapshot = adapter.snapshot();
    if (equityCurve.length > 0) {
      equityCurve[equityCurve.length - 1] = {
        ...equityCurve[equityCurve.length - 1],
        equityUsd: snapshot.equityUsd,
        openPositions: snapshot.positions.length,
      };
    }
  }

  const finalAccount = adapter.snapshot();
  const metrics = computeMetrics({
    equityCurve,
    trades,
    initialEquityUsd,
    feesUsd: finalAccount.feesUsd,
    slippageUsd: totalSlippageUsd(fills),
    liquidationEvents,
    periodsPerYear,
  });

  pushEvent(JOURNAL_EVENT.BACKTEST_COMPLETED, {
    symbol,
    metadata: {
      bars: equityCurve.length,
      endReason,
      finalEquityUsd: finalAccount.equityUsd,
      netPnlUsd: metrics.netPnlUsd,
      numberOfTrades: metrics.numberOfTrades,
    },
  });

  if (typeof options.journalFile === 'string' && options.journalFile.trim() !== '') {
    const journalWriter = createJournal({ filePath: options.journalFile, fs: options.fs });
    await journalWriter.recordMany(journal);
  }

  return Object.freeze({
    ok: true,
    symbol,
    bars: equityCurve.length,
    startTime: candles[0].startTime,
    endTime: equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].timestamp : candles[0].startTime,
    endReason,
    initialEquityUsd,
    finalEquityUsd: finalAccount.equityUsd,
    metrics,
    trades: Object.freeze([...trades]),
    equityCurve: Object.freeze([...equityCurve]),
    journal: Object.freeze([...journal]),
    account: finalAccount,
    openPositions: finalAccount.positions,
  });
}
