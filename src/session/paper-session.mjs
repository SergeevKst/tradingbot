/**
 * PaperSession — the orchestrator that wires the layers together.
 *
 * This module is the ONLY place where the flow from the spec is expressed:
 *
 *   TradeProposal -> PaperAccountState -> open positions -> daily state
 *                 -> Risk Engine -> RiskDecision -> Paper Executor
 *
 * Two responsibilities are deliberately kept apart:
 *   - the Risk Engine decides WHETHER a trade may open and how big it may be;
 *   - the Paper Executor only fills a decision that was already approved and
 *     does not re-litigate it (its only refusals are execution-level ones,
 *     such as a missing bid/ask).
 *
 * State is persisted after every state-changing operation, so a crash can lose
 * at most the operation in flight — never the account.
 *
 * @module session/paper-session
 */
import { ConfigError } from '../config/config-error.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';
import { normalizeSymbol } from '../domain/proposal.mjs';
import { evaluateTrade } from '../risk/risk-engine.mjs';
import { toRiskInstrumentView } from '../market/instrument-info.mjs';
import { toRiskAccountView, validatePaperAccountState, createPaperAccountState } from '../state/paper-account.mjs';
import { createDailyState, rollDailyStateIfNeeded, recordDailyActivity, validateDailyState } from '../state/daily-state.mjs';
import { createJournal, createJournalEvent, JOURNAL_EVENT } from '../state/journal.mjs';
import { savePaperState, loadPaperState, resetPaperState } from '../state/state-store.mjs';
import { createPaperExecutionAdapter } from '../execution/paper-execution-adapter.mjs';

/**
 * @typedef {object} PaperSessionOptions
 * @property {import('../config/risk.mjs').RiskLimits} riskConfig
 * @property {import('../state/fee-model.mjs').FeeModel} feeModel
 * @property {{ stateFile: string, journalFile: string, initialEquityUsd: number, persist?: boolean }} paths
 * @property {() => string} [now] injected clock returning an ISO timestamp
 * @property {object} [logger]
 * @property {object} [fs] injectable filesystem, for tests
 */

/**
 * Create and restore a paper trading session.
 *
 * Restoration is FAIL CLOSED: corrupt persisted state throws rather than
 * quietly starting a new 340 USD account.
 *
 * @param {PaperSessionOptions} options
 */
export async function createPaperSession(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createPaperSession requires options');
  }
  const now = options.now ?? (() => new Date().toISOString());
  const logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  const persist = options.paths.persist !== false;
  const fs = options.fs;

  const journal = createJournal({ filePath: options.paths.journalFile, fs });

  /**
   * Serialized journal append queue.
   *
   * Appends are chained onto a single promise rather than fired concurrently.
   * Concurrency would let two events land in the file in arbitrary order, which
   * destroys the one property a journal must have: recording what happened in
   * the order it happened. Firing them off in parallel is measurably faster and
   * completely useless for reconstructing a trade.
   *
   * @type {Promise<unknown>}
   */
  let journalQueue = Promise.resolve();

  /**
   * @param {import('../state/journal.mjs').JournalEvent} event
   */
  function appendToJournal(event) {
    journalQueue = journalQueue
      .then(() => journal.record(event))
      .catch((error) => {
        logger.error('journal append failed', {
          error: error instanceof Error ? error.message : String(error),
          eventType: event.eventType,
        });
      });
  }

  /** Wait for every queued journal append to settle, in order. */
  async function flushJournal() {
    await journalQueue;
  }

  let account;
  let daily;
  let restored = false;

  if (persist) {
    const loaded = await loadPaperState({ filePath: options.paths.stateFile, fs, logger });
    if (loaded.kind === 'restored') {
      account = loaded.state.account;
      daily = loaded.state.daily;
      restored = true;
    }
  }

  if (!restored) {
    // A brand-new account is created only when no state exists at all.
    account = createPaperAccountState({ equityUsd: options.paths.initialEquityUsd });
    daily = createDailyState({ equityUsd: account.equityUsd, timestamp: Date.parse(now()), timezone: 'UTC' });
  }

  const adapter = createPaperExecutionAdapter({
    account,
    feeModel: options.feeModel,
    logger,
    now,
    journal(event) {
      const record = createJournalEvent({
        eventType: event.eventType,
        timestamp: event.timestamp,
        symbol: event.symbol ?? null,
        side: event.side ?? null,
        quantity: event.quantity ?? null,
        price: event.price ?? null,
        pnl: event.pnl ?? null,
        fee: event.fee ?? null,
        reason: event.reason ?? null,
        metadata: event.metadata ?? {},
      });
      appendToJournal(record);
    },
  });

  /**
   * Persist the current account + daily state.
   * @param {{ silent?: boolean }} [options]
   */
  async function persistState(persistOptions = {}) {
    if (!persist) return;
    const snapshot = adapter.snapshot();
    await savePaperState(
      { filePath: options.paths.stateFile, fs },
      {
        account: snapshot,
        daily: { ...daily, tradesToday: snapshot.tradesToday, dailyRealizedPnlUsd: snapshot.dailyRealizedPnlUsd },
        savedAt: now(),
      },
    );
    if (!persistOptions.silent) {
      logger.debug('paper state saved', { file: options.paths.stateFile, equityUsd: snapshot.equityUsd });
    }
  }

  /**
   * Roll the UTC day if needed and push the counters into the account.
   * Returns true when a rollover happened.
   */
  function syncDailyState() {
    const timestamp = now();
    const current = adapter.snapshot();
    const rolled = rollDailyStateIfNeeded(daily, { timestamp: Date.parse(timestamp), equityUsd: current.equityUsd });
    const changed = rolled !== daily;
    daily = rolled;

    if (changed) {
      adapter.setAccount(
        Object.freeze({ ...current, tradesToday: 0, dailyRealizedPnlUsd: 0, lastUpdatedAt: timestamp }),
      );
      logger.info('new UTC trading day — daily counters reset', {
        tradingDay: daily.tradingDay,
        dayStartEquityUsd: daily.dayStartEquityUsd,
      });
    }
    return changed;
  }

  /**
   * Apply a realized result to the daily counters.
   *
   * @param {{ realizedPnlUsd: number, countTrade: boolean }} input
   */
  function applyDaily(input) {
    const timestamp = now();
    daily = recordDailyActivity(daily, {
      realizedPnlUsd: input.realizedPnlUsd,
      countTrade: input.countTrade,
      timestamp: Date.parse(timestamp),
    });
    const current = adapter.snapshot();
    adapter.setAccount(
      Object.freeze({
        ...current,
        tradesToday: daily.tradesToday,
        dailyRealizedPnlUsd: daily.dailyRealizedPnlUsd,
        dayStartEquityUsd: daily.dayStartEquityUsd,
        lastUpdatedAt: timestamp,
      }),
    );
  }

  /**
   * @param {import('../market/market-snapshot.mjs').MarketSnapshot} market
   */
  function toRiskMarketView(market) {
    return {
      markPrice: market.markPrice,
      bestBid: market.bid,
      bestAsk: market.ask,
      instrument: market.instrument ? toRiskInstrumentView(market.instrument) : undefined,
    };
  }

  return Object.freeze({
    /** True when state was restored from disk rather than freshly created. */
    restored,
    journal,
    dailyState: () => daily,

    async getAccountState() {
      return adapter.getAccountState();
    },

    async getOpenPositions() {
      return adapter.getOpenPositions();
    },

    async getPosition(symbol) {
      const normalized = normalizeSymbol(symbol);
      if (!normalized.ok) return null;
      return adapter.getPosition(normalized.value);
    },

    /**
     * The full pipeline for one proposal: journal it, ask the Risk Engine,
     * then (and only then) let the executor fill an approval.
     *
     * @param {{ proposal: unknown, market: import('../market/market-snapshot.mjs').MarketSnapshot }} input
     * @returns {Promise<{ approved: boolean, executed: boolean, riskResult: object, executionResult?: object, reasonCode: string, message?: string }>}
     */
    async submit(input) {
      syncDailyState();

      const { proposal, market } = input;

      appendToJournal(
        createJournalEvent({
          eventType: JOURNAL_EVENT.SIGNAL_RECEIVED,
          timestamp: now(),
          symbol: proposal?.symbol ?? null,
          side: proposal?.side ?? null,
          metadata: {
            entryPrice: proposal?.entryPrice ?? null,
            stopLossPrice: proposal?.stopLossPrice ?? null,
            takeProfitPrice: proposal?.takeProfitPrice ?? null,
            strategyId: proposal?.strategyId ?? null,
            confidence: proposal?.confidence ?? null,
            mode: 'PAPER',
          },
        }),
      );

      const accountSnapshot = adapter.snapshot();
      const riskResult = evaluateTrade({
        proposal,
        account: toRiskAccountView(accountSnapshot),
        market: toRiskMarketView(market),
        riskConfig: options.riskConfig,
      });

      if (!riskResult.approved) {
        appendToJournal(
          createJournalEvent({
            eventType: JOURNAL_EVENT.RISK_REJECTED,
            timestamp: now(),
            symbol: riskResult.symbol ?? proposal?.symbol ?? null,
            side: riskResult.side ?? proposal?.side ?? null,
            reason: riskResult.reasonCode,
            metadata: { message: riskResult.message },
          }),
        );

        // Settle the audit trail before returning, so a caller that inspects the
        // journal straight after sees this rejection.
        await flushJournal();

        logger.info('proposal rejected', { reason: riskResult.reasonCode, symbol: proposal?.symbol });
        return { approved: false, executed: false, riskResult, reasonCode: riskResult.reasonCode, message: riskResult.message };
      }

      appendToJournal(
        createJournalEvent({
          eventType: JOURNAL_EVENT.RISK_ACCEPTED,
          timestamp: now(),
          symbol: riskResult.symbol,
          side: riskResult.side,
          quantity: riskResult.estimatedQuantity,
          reason: riskResult.reasonCode,
          metadata: {
            riskAmountUsd: riskResult.riskAmountUsd,
            positionNotionalUsd: riskResult.positionNotionalUsd,
            riskReward: riskResult.riskReward,
          },
        }),
      );

      const executionResult = await adapter.openPosition({ proposal, riskResult, market });

      if (!executionResult.ok) {
        await flushJournal();
        return {
          approved: true,
          executed: false,
          riskResult,
          executionResult,
          reasonCode: executionResult.reasonCode ?? REASON_CODE.INTERNAL_ERROR,
          message: executionResult.message,
        };
      }

      // A fill is a completed entry: count it against the daily trade limit.
      applyDaily({ realizedPnlUsd: 0, countTrade: true });
      await persistState();
      await flushJournal();

      return { approved: true, executed: true, riskResult, executionResult, reasonCode: REASON_CODE.APPROVED };
    },

    /**
     * Advance the market: mark positions to market and process SL/TP.
     *
     * @param {import('../market/market-snapshot.mjs').MarketSnapshot} market
     */
    async onMarketUpdate(market) {
      syncDailyState();
      const outcome = await adapter.onMarketUpdate(market);

      for (const closed of outcome.closed) {
        applyDaily({ realizedPnlUsd: closed.netPnlUsd, countTrade: false });
      }

      if (outcome.closed.length > 0 || outcome.updated > 0) {
        await persistState({ silent: true });
      }
      await flushJournal();
      return outcome;
    },

    /**
     * Explicitly close a position.
     *
     * @param {{ symbol: string, price?: number, reason?: string, market?: unknown }} input
     */
    async closePosition(input) {
      syncDailyState();
      const result = await adapter.closePosition(input);
      if (result.ok && result.fill) {
        // A close realizes PnL but does not consume a daily trade slot: the day
        // limit counts entries, so a round trip costs exactly one.
        applyDaily({ realizedPnlUsd: netPnlOf(result.fill), countTrade: false });
        await persistState();
      }
      await flushJournal();
      return result;
    },

    /**
     * Update the protective levels of an open position.
     *
     * Worth noting for the ambiguity rule in the executor: moving both levels so
     * that they sit *behind* the current price makes a later gap capable of
     * spanning both, which the executor resolves conservatively to the stop.
     *
     * @param {{ symbol: string, stopLoss?: number | null, takeProfit?: number | null }} input
     */
    async modifyPositionProtection(input) {
      syncDailyState();
      // `normalizeSymbol` returns a result object, not a string — unwrap it so
      // the symbol reaching the adapter is the canonical form.
      const normalized = normalizeSymbol(input.symbol);
      if (!normalized.ok) {
        return {
          ok: false,
          reasonCode: REASON_CODE.INVALID_SYMBOL,
          message: normalized.message,
        };
      }
      const result = await adapter.modifyPositionProtection({ ...input, symbol: normalized.value });
      if (result.ok) {
        await persistState({ silent: true });
      }
      await flushJournal();
      return result;
    },

    /**
     * Wait for every queued journal append to land on disk.
     *
     * Exposed for callers (and the CLI) that read the journal right after an
     * operation and need the history to be complete.
     */
    flushJournal,

    /** Persist the current state on demand (e.g. at shutdown). */
    persist: persistState,

    /** Delete persisted state. Requires explicit confirmation. */
    async reset(confirmed) {
      return resetPaperState({ filePath: options.paths.stateFile, fs, confirmed });
    },

    /** Validate a restored state document, exposed for the CLI. */
    validateState: validatePaperAccountState,
    validateDaily: validateDailyState,
  });
}

/**
 * Net realized PnL carried on a settled fill, both fees included.
 *
 * @param {unknown} fill
 * @returns {number}
 */
function netPnlOf(fill) {
  const value = Number(/** @type {any} */ (fill)?.netPnlUsd);
  return Number.isFinite(value) ? value : 0;
}

export { createPaperAccountState };