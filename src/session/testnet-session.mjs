/**
 * TestnetSession — the canonical TESTNET execution session.
 *
 * This is the TESTNET analogue of PaperSession and it is deliberately thin: it
 * owns the SAME flow — TradeProposal -> Risk Engine -> ExecutionAdapter — and
 * reuses the SAME deterministic Risk Engine, runtime kill switch and append-only
 * journal. It introduces no second risk, execution or reconciliation system.
 *
 * The one difference is the adapter. A PAPER session fills locally; a TESTNET
 * session is handed a `TestnetExecutionAdapter` that routes every submission
 * through the shared reconciliation engine and the authenticated testnet client.
 * The session refuses any adapter that does not declare `kind() === 'TESTNET'`,
 * so a PAPER adapter can never be mistaken for an exchange-connected one.
 *
 * @module session/testnet-session
 */
import { ConfigError } from '../config/config-error.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';
import { normalizeSymbol } from '../domain/proposal.mjs';
import { evaluateTrade } from '../risk/risk-engine.mjs';
import { assertKillSwitch, createKillSwitch } from '../risk/kill-switch.mjs';
import { toRiskInstrumentView } from '../market/instrument-info.mjs';
import { toRiskAccountView } from '../state/paper-account.mjs';
import { createJournal, createJournalEvent, JOURNAL_EVENT } from '../state/journal.mjs';
import { assertExecutionAdapter } from '../execution/execution-adapter.mjs';

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

/**
 * @typedef {object} TestnetSessionOptions
 * @property {import('../execution/execution-adapter.mjs').ExecutionAdapter} adapter a TESTNET execution adapter
 * @property {import('../config/risk.mjs').RiskLimits} riskConfig
 * @property {{ journalFile: string }} [paths]
 * @property {{ record: Function }} [journal] an already-open journal, for tests
 * @property {ReturnType<typeof createKillSwitch>} [killSwitch]
 * @property {() => string} [now]
 * @property {object} [logger]
 * @property {object} [fs]
 * @property {boolean} [oneShot] TESTNET_ONCE: allow at most one order, then shut down
 * @property {(info: Readonly<object>) => unknown} [onShutdown] notified once after the one-shot session shuts down
 */

/**
 * Create a TESTNET session around an already-constructed adapter.
 *
 * @param {TestnetSessionOptions} options
 * @returns {Promise<Readonly<object>>}
 */
export async function createTestnetSession(options) {
  if (options === null || typeof options !== 'object' || !options.adapter) {
    throw new ConfigError('createTestnetSession requires a TESTNET ExecutionAdapter');
  }
  const adapter = assertExecutionAdapter(options.adapter);
  // Fail closed on a mode mix-up: only an explicitly TESTNET adapter may trade
  // against the testnet host from this session.
  if (adapter.kind() !== 'TESTNET') {
    throw new ConfigError(`createTestnetSession requires a TESTNET adapter, got ${JSON.stringify(adapter.kind())}`, {
      field: 'adapter',
      value: adapter.kind(),
    });
  }

  const now = options.now ?? (() => new Date().toISOString());
  const logger = options.logger ?? NOOP_LOGGER;
  const killSwitch = assertKillSwitch(options.killSwitch ?? createKillSwitch({ now }));
  const journal = options.journal ?? createJournal({ filePath: options.paths?.journalFile, fs: options.fs });

  let journalQueue = Promise.resolve();
  /** @param {object} event */
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
  async function flushJournal() {
    await journalQueue;
  }

  // --- TESTNET_ONCE ---------------------------------------------------------
  // Off by default, so continuous TESTNET is completely unchanged. When on, the
  // session enforces the one-order invariant at the execution boundary (below
  // its own submit() orchestration) and shuts down after the first terminal
  // outcome.
  const oneShot = options.oneShot === true;
  const sessionMode = oneShot ? 'TESTNET_ONCE' : 'TESTNET';

  /** Order submissions handed to the executor. Never exceeds 1 in one-shot mode. */
  let oneShotAttempts = 0;
  /** Terminal one-shot shutdown record; null until the session shuts down. */
  let shutdown = null;

  /**
   * The execution-boundary guard. It delegates to the SAME adapter, so it is not
   * a parallel execution path; it just refuses the second submission before the
   * adapter can reach the exchange.
   *
   * @param {import('../execution/execution-adapter.mjs').OpenPositionRequest} request
   */
  async function guardedOpenPosition(request) {
    if (oneShotAttempts >= 1) {
      appendToJournal(
        createJournalEvent({
          eventType: JOURNAL_EVENT.TESTNET_ONCE_ORDER_BLOCKED,
          timestamp: now(),
          reason: REASON_CODE.ONE_SHOT_EXHAUSTED,
          metadata: { mode: sessionMode, attempts: oneShotAttempts },
        }),
      );
      await flushJournal();
      logger.warn('one-shot submission refused at the execution boundary', { attempts: oneShotAttempts });
      return {
        ok: false,
        reasonCode: REASON_CODE.ONE_SHOT_EXHAUSTED,
        message: 'TESTNET_ONCE permits exactly one order submission; the single permitted attempt has already been made.',
      };
    }
    oneShotAttempts += 1;
    return adapter.openPosition(request);
  }

  /**
   * Graceful one-shot shutdown: resolve the terminal record, journal it, flush
   * the journal, and notify the optional `onShutdown` hook. Called at most once.
   *
   * @param {string} reason
   * @param {{ reasonCode?: string | null, executed?: boolean, symbol?: string | null, side?: string | null, quantity?: number | null }} [metadata]
   */
  async function shutdownOnce(reason, metadata = {}) {
    if (shutdown !== null) return shutdown;
    shutdown = Object.freeze({
      mode: sessionMode,
      reason,
      reasonCode: metadata.reasonCode ?? null,
      executed: metadata.executed === true,
      ordersAttempted: oneShotAttempts,
      at: now(),
    });
    appendToJournal(
      createJournalEvent({
        eventType: JOURNAL_EVENT.TESTNET_ONCE_SHUTDOWN,
        timestamp: now(),
        symbol: metadata.symbol ?? null,
        side: metadata.side ?? null,
        quantity: metadata.quantity ?? null,
        reason,
        metadata: {
          reasonCode: shutdown.reasonCode,
          executed: shutdown.executed,
          ordersAttempted: shutdown.ordersAttempted,
          mode: sessionMode,
        },
      }),
    );
    await flushJournal();
    logger.info('one-shot testnet session shutting down', { reason, ordersAttempted: oneShotAttempts });
    if (typeof options.onShutdown === 'function') {
      try {
        await options.onShutdown(shutdown);
      } catch (error) {
        logger.error('one-shot onShutdown callback failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return shutdown;
  }

  /**
   * @param {string} eventType
   * @param {{ engaged: boolean, reason: string | null, engagedAt: string | null }} state
   */
  function recordKillSwitch(eventType, state) {
    appendToJournal(
      createJournalEvent({
        eventType,
        timestamp: now(),
        reason: state.reason,
        metadata: { engaged: state.engaged, engagedAt: state.engagedAt, mode: sessionMode },
      }),
    );
  }

  /** Entries taken this session (the daily counter the Risk Engine consumes). */
  let tradesToday = 0;

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
    mode: sessionMode,
    adapterKind: adapter.kind(),
    journal,
    oneShot,

    /** True once the one-shot session has performed its graceful shutdown. */
    isShutdown: () => shutdown !== null,

    /** The terminal one-shot shutdown record, or null while it is still armed. */
    shutdownInfo: () => shutdown,

    /** Order submissions this session has handed to the executor (0 or 1). */
    ordersAttempted: () => oneShotAttempts,

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
     * The full pipeline for one proposal: journal it, ask the Risk Engine, then
     * (and only then) let the testnet executor submit an approval.
     *
     * @param {{ proposal: unknown, market: import('../market/market-snapshot.mjs').MarketSnapshot }} input
     */
    async submit(input) {
      const { proposal, market } = input ?? {};

      // A one-shot session accepts exactly one attempt. Once it has shut down,
      // further submissions are refused before risk or execution is reached.
      if (oneShot && shutdown !== null) {
        appendToJournal(
          createJournalEvent({
            eventType: JOURNAL_EVENT.TESTNET_ONCE_ORDER_BLOCKED,
            timestamp: now(),
            symbol: proposal?.symbol ?? null,
            side: proposal?.side ?? null,
            reason: REASON_CODE.ONE_SHOT_SHUTDOWN,
            metadata: { mode: sessionMode },
          }),
        );
        await flushJournal();
        return {
          approved: false,
          executed: false,
          riskResult: null,
          reasonCode: REASON_CODE.ONE_SHOT_SHUTDOWN,
          message: 'The TESTNET_ONCE session has already completed and shut down.',
          shutdown: true,
        };
      }

      // No intent is a terminal one-shot outcome: there is nothing to risk.
      if (oneShot && (proposal === null || proposal === undefined)) {
        await shutdownOnce(REASON_CODE.NO_SIGNAL, { reasonCode: REASON_CODE.NO_SIGNAL, executed: false });
        return {
          approved: false,
          executed: false,
          riskResult: null,
          reasonCode: REASON_CODE.NO_SIGNAL,
          message: 'No trade intent was produced; the one-shot session shut down without submitting an order.',
          shutdown: true,
        };
      }

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
            mode: sessionMode,
          },
        }),
      );

      const snapshot = await adapter.getAccountState();
      const riskAccount = {
        ...toRiskAccountView(snapshot),
        tradesToday,
      };

      const riskResult = evaluateTrade({
        proposal,
        account: riskAccount,
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
            metadata: { message: riskResult.message, mode: sessionMode },
          }),
        );
        await flushJournal();
        logger.info('proposal rejected', { reason: riskResult.reasonCode, symbol: proposal?.symbol });
        if (oneShot) {
          await shutdownOnce('RISK_REJECTED', {
            reasonCode: riskResult.reasonCode,
            executed: false,
            symbol: riskResult.symbol ?? proposal?.symbol ?? null,
            side: riskResult.side ?? proposal?.side ?? null,
          });
        }
        return {
          approved: false,
          executed: false,
          riskResult,
          reasonCode: riskResult.reasonCode,
          message: riskResult.message,
          ...(oneShot ? { shutdown: true } : {}),
        };
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
            mode: sessionMode,
          },
        }),
      );

      // In one-shot mode the submission goes through the execution-boundary
      // guard; otherwise the existing continuous path is untouched.
      const executionResult = oneShot
        ? await guardedOpenPosition({ proposal, riskResult, market })
        : await adapter.openPosition({ proposal, riskResult, market });

      if (!executionResult.ok) {
        await flushJournal();
        if (oneShot) {
          await shutdownOnce('EXECUTION_FAILED', {
            reasonCode: executionResult.reasonCode ?? REASON_CODE.INTERNAL_ERROR,
            executed: false,
            symbol: proposal?.symbol ?? null,
            side: proposal?.side ?? null,
          });
        }
        return {
          approved: true,
          executed: false,
          riskResult,
          executionResult,
          reasonCode: executionResult.reasonCode ?? REASON_CODE.INTERNAL_ERROR,
          message: executionResult.message,
          ...(oneShot ? { shutdown: true } : {}),
        };
      }

      tradesToday += 1;
      await flushJournal();
      if (oneShot) {
        await shutdownOnce('ORDER_COMPLETED', {
          reasonCode: REASON_CODE.APPROVED,
          executed: true,
          symbol: proposal?.symbol ?? null,
          side: proposal?.side ?? null,
          quantity: executionResult?.fill?.filledQuantity ?? riskResult.estimatedQuantity ?? null,
        });
      }
      return {
        approved: true,
        executed: true,
        riskResult,
        executionResult,
        reasonCode: REASON_CODE.APPROVED,
        ...(oneShot ? { shutdown: true } : {}),
      };
    },

    /**
     * Reconcile tracked orders against the exchange through the shared engine.
     *
     * @param {import('../market/market-snapshot.mjs').MarketSnapshot} market
     */
    async onMarketUpdate(market) {
      if (typeof adapter.onMarketUpdate !== 'function') {
        return { closed: [], updated: 0, errors: [] };
      }
      return adapter.onMarketUpdate(market);
    },

    async engageKillSwitch(reason) {
      const state = killSwitch.engage(reason);
      recordKillSwitch(JOURNAL_EVENT.KILL_SWITCH_ENGAGED, state);
      logger.warn('kill switch engaged', { reason: state.reason, mode: sessionMode });
      await flushJournal();
      return state;
    },

    async disengageKillSwitch() {
      const state = killSwitch.disengage();
      recordKillSwitch(JOURNAL_EVENT.KILL_SWITCH_DISENGAGED, state);
      logger.info('kill switch disengaged', { mode: sessionMode });
      await flushJournal();
      return state;
    },

    killSwitchState: () => killSwitch.snapshot(),
    flushJournal,
  };

  return Object.freeze(api);
}
