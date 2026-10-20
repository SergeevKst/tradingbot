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
import { createStrategyDecision } from '../domain/strategy-decision.mjs';
import { createTradingSignal } from '../domain/signal.mjs';
import { SIGNAL_ACTION } from '../types/enums.mjs';
import { evaluateTrade } from '../risk/risk-engine.mjs';
import { assertKillSwitch, createKillSwitch } from '../risk/kill-switch.mjs';
import { toRiskInstrumentView } from '../market/instrument-info.mjs';
import {
  toRiskAccountView,
  toPortfolioSnapshot,
  toPnLSnapshot,
  validatePaperAccountState,
  createPaperAccountState,
} from '../state/paper-account.mjs';
import { createDailyState, rollDailyStateIfNeeded, recordDailyActivity, validateDailyState } from '../state/daily-state.mjs';
import { createJournal, createJournalEvent, JOURNAL_EVENT } from '../state/journal.mjs';
import { savePaperState, loadPaperState, resetPaperState } from '../state/state-store.mjs';
import { createPaperExecutionAdapter } from '../execution/paper-execution-adapter.mjs';
import { createDefaultStrategyRegistry, buildMarketContext } from '../strategy/index.mjs';

/**
 * @typedef {object} PaperSessionOptions
 * @property {import('../config/risk.mjs').RiskLimits} riskConfig
 * @property {import('../state/fee-model.mjs').FeeModel} feeModel
 * @property {import('../execution/fill-model.mjs').FillModel} [fillModel] how much of an order fills; defaults to a full fill
 * @property {{ stateFile: string, journalFile: string, initialEquityUsd: number, persist?: boolean }} paths
 * @property {{ get: Function, list: Function }} [strategyRegistry] strategies to run; defaults to the built-in registry
 * @property {ReturnType<import('../risk/kill-switch.mjs').createKillSwitch>} [killSwitch] runtime emergency stop; defaults to a disengaged one
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
  const strategyRegistry = options.strategyRegistry ?? createDefaultStrategyRegistry();
  // The operational emergency stop always exists; by default it is released.
  // An injected control is validated before the session can accept a trade.
  const killSwitch = assertKillSwitch(options.killSwitch ?? createKillSwitch({ now }));

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

  /**
   * Record an engage/release of the runtime emergency stop (§44).
   *
   * @param {string} eventType one of JOURNAL_EVENT.KILL_SWITCH_*
   * @param {{ engaged: boolean, reason: string | null, engagedAt: string | null }} state
   */
  function recordKillSwitch(eventType, state) {
    appendToJournal(
      createJournalEvent({
        eventType,
        timestamp: now(),
        reason: state.reason,
        metadata: { engaged: state.engaged, engagedAt: state.engagedAt },
      }),
    );
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
    fillModel: options.fillModel,
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

  const api = {
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
     * The validated portfolio domain view of the paper ledger (MASTER_SPEC §7).
     * Frozen, read-only, and never mutates the account.
     */
    async getPortfolioSnapshot() {
      return toPortfolioSnapshot(adapter.snapshot(), { timestamp: Date.parse(now()), source: 'paper' });
    },

    /**
     * The validated PnL domain view of the paper ledger (MASTER_SPEC §7).
     *
     * @param {{ symbol?: string }} [input]
     */
    async getPnLSnapshot(input = {}) {
      return toPnLSnapshot(adapter.snapshot(), { timestamp: Date.parse(now()), symbol: input.symbol });
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
      // The runtime kill switch is passed to the Risk Engine as an explicit
      // input, which OR-s it with the static config flag (§44). Either layer can
      // stop a trade; neither can widen a limit, and the engine owns the gate.
      const riskResult = evaluateTrade({
        proposal,
        account: toRiskAccountView(accountSnapshot),
        market: toRiskMarketView(market),
        riskConfig: options.riskConfig,
        killSwitchEngaged: killSwitch.isEngaged(),
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
     * Engage the runtime emergency stop. New entries are refused from the next
     * submission until it is explicitly released. Always succeeds — a missing
     * reason is recorded as UNSPECIFIED rather than blocking the stop.
     *
     * @param {string} [reason]
     */
    async engageKillSwitch(reason) {
      const state = killSwitch.engage(reason);
      recordKillSwitch(JOURNAL_EVENT.KILL_SWITCH_ENGAGED, state);
      logger.warn('kill switch engaged', { reason: state.reason });
      await flushJournal();
      return state;
    },

    /** Release the runtime emergency stop and resume accepting entries. */
    async disengageKillSwitch() {
      const state = killSwitch.disengage();
      recordKillSwitch(JOURNAL_EVENT.KILL_SWITCH_DISENGAGED, state);
      logger.info('kill switch disengaged', {});
      await flushJournal();
      return state;
    },

    /** The current runtime kill-switch state, without changing it. */
    killSwitchState: () => killSwitch.snapshot(),

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
  };

  /**
   * Run a registered strategy and submit whatever proposal it emits.
   *
   * A strategy returning `null` is a deliberate "no signal" and nothing is
   * risked. An emitted proposal travels through the unchanged risk -> execution
   * path, so a strategy can never bypass the deterministic gate.
   *
   * @param {{ market: import('../market/market-snapshot.mjs').MarketSnapshot, strategyId?: string }} input
   */
  api.submitFromStrategy = async function submitFromStrategy(input) {
    if (input === null || typeof input !== 'object' || !input.market) {
      throw new ConfigError('submitFromStrategy requires { market }');
    }
    const strategy = strategyRegistry.get(input.strategyId ?? strategyRegistry.list()[0]);
    const context = buildMarketContext(input.market, strategy.indicators);

    let proposal;
    try {
      proposal = strategy.evaluate(context);
    } catch (error) {
      // A crashing strategy must fail closed: no signal, never a trade.
      logger.warn('strategy threw — treating as no signal', {
        strategyId: strategy.id,
        error: error instanceof Error ? error.message : String(error),
      });
      recordStrategyDecision({ strategy, context, action: SIGNAL_ACTION.NO_SIGNAL, reason: 'STRATEGY_ERROR' });
      await flushJournal();
      return noSignal();
    }

    if (proposal === null || proposal === undefined) {
      // "No signal" is a decision worth recording (§21), not an absence.
      recordStrategyDecision({ strategy, context, action: SIGNAL_ACTION.NO_SIGNAL, reason: 'NO_SIGNAL' });
      await flushJournal();
      return noSignal();
    }

    recordStrategyDecision({ strategy, context, action: SIGNAL_ACTION.EMIT, proposal });
    const outcome = await api.submit({ proposal, market: input.market });
    return { ...outcome, signal: true, proposal };
  };

  /**
   * Record a StrategyDecision (§7) in the journal. Best-effort: a strategy that
   * returns a malformed proposal must not be able to crash the audit path — the
   * Risk Engine still rejects it through the unchanged `submit` route.
   *
   * @param {{ strategy: { id: string }, context: object, action: string, proposal?: object | null, reason?: string }} input
   */
  function recordStrategyDecision({ strategy, context, action, proposal = null, reason }) {
    const symbol = proposal?.symbol ?? context.symbol;
    const timestamp = Number.isFinite(proposal?.timestamp)
      ? proposal.timestamp
      : Number.isFinite(context.timestamp)
        ? /** @type {number} */ (context.timestamp)
        : Date.parse(now());

    let decision;
    try {
      decision = createStrategyDecision({
        strategyId: strategy.id,
        symbol,
        action,
        signal:
          action === SIGNAL_ACTION.EMIT
            ? createTradingSignal({
                strategyId: strategy.id,
                symbol,
                side: proposal.side,
                confidence: proposal.confidence,
                entryPrice: proposal.entryPrice,
                stopLossPrice: proposal.stopLossPrice,
                takeProfitPrice: proposal.takeProfitPrice,
                timestamp: proposal.timestamp,
              })
            : undefined,
        reason: reason ?? undefined,
        timestamp,
      });
    } catch (error) {
      logger.warn('strategy decision could not be recorded', {
        strategyId: strategy.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    appendToJournal(
      createJournalEvent({
        eventType: JOURNAL_EVENT.STRATEGY_DECISION,
        timestamp: now(),
        symbol: decision.symbol,
        side: decision.signal?.side ?? null,
        reason: decision.reason ?? decision.action,
        metadata: {
          strategyId: decision.strategyId,
          action: decision.action,
          smaFast: context.indicators?.smaFast ?? null,
          smaSlow: context.indicators?.smaSlow ?? null,
          atr: context.indicators?.atr ?? null,
          lastClose: context.indicators?.lastClose ?? null,
        },
      }),
    );
  }

  return Object.freeze(api);
}

/** The uniform "strategy emitted no proposal" result. */
function noSignal() {
  return { signal: false, approved: false, executed: false, reasonCode: REASON_CODE.NO_SIGNAL, proposal: null };
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