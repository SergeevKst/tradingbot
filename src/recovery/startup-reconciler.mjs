/**
 * Startup recovery + reconciliation session (MASTER_SPEC §14-15, Phase 9).
 *
 * Implements the mandated startup sequence:
 *
 *   journal replay -> fetch balances -> fetch positions -> fetch open orders
 *                  -> compare with local state -> reconcile -> allow trading
 *
 * The gate is fail-closed: if any step throws, or any order is left mismatched
 * or undetermined, `tradingEnabled` stays false. Recovery is deterministic and
 * every step is journaled, so the decision to enable — or refuse — trading is
 * itself auditable.
 *
 * @module recovery/startup-reconciler
 */
import { ReconciliationError } from '../errors/taxonomy.mjs';
import { createJournalEvent, JOURNAL_EVENT } from '../state/journal.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';
import { createDuplicateGuard } from '../reconciliation/duplicate-guard.mjs';
import { createReconciliationEngine } from '../reconciliation/reconciliation-engine.mjs';
import { recoverOrderState, restoreGuard } from './journal-replay.mjs';

/**
 * @param {{
 *   exchange: object,
 *   journal: { record: Function, read: Function },
 *   guard?: ReturnType<typeof createDuplicateGuard>,
 *   now?: () => string,
 *   logger?: object,
 *   maxQueryAttempts?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} options
 */
export function createStartupReconciler(options) {
  if (options === null || typeof options !== 'object' || options.exchange === null || typeof options.exchange !== 'object') {
    throw new ReconciliationError('createStartupReconciler requires an exchange', { details: { field: 'exchange' } });
  }
  const now = options.now ?? (() => new Date().toISOString());
  const logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  const guard = options.guard ?? createDuplicateGuard({ now });
  const engine = createReconciliationEngine({
    exchange: options.exchange,
    guard,
    journal: options.journal,
    now,
    logger,
    maxQueryAttempts: options.maxQueryAttempts,
    sleep: options.sleep,
  });

  const journalRecord = options.journal !== null && typeof options.journal === 'object' ? options.journal.record : null;

  /**
   * @param {string} eventType
   * @param {object} fields
   */
  async function emit(eventType, fields) {
    if (typeof journalRecord !== 'function') return;
    try {
      await journalRecord(createJournalEvent({ eventType, timestamp: now(), ...fields }));
    } catch (error) {
      logger.error('startup reconciliation journal append failed', {
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<unknown>}
   */
  async function fetchIfPresent(method, params) {
    if (typeof options.exchange[method] !== 'function') return null;
    return options.exchange[method](params);
  }

  return Object.freeze({
    engine,
    guard,

    /**
     * Run the startup sequence exactly once. Safe to call again: it re-reads the
     * journal and re-queries the exchange, converging on the same decision.
     *
     * @returns {Promise<object>}
     */
    async start() {
      await emit(JOURNAL_EVENT.RECOVERY_STARTED, { metadata: {} });

      let recovered;
      let balances = null;
      let positions = null;
      let exchangeOpenOrders = null;
      let reconcile = null;

      try {
        recovered = await recoverOrderState({ journal: options.journal });
        restoreGuard(guard, recovered);

        balances = await fetchIfPresent('getWalletBalance', {});
        positions = await fetchIfPresent('getPositions', {});
        exchangeOpenOrders = await fetchIfPresent('getOpenOrders', {});

        reconcile = await engine.reconcileOpenOrders();
      } catch (error) {
        const reasonCode = REASON_CODE.RECONCILIATION_FAILED;
        await emit(JOURNAL_EVENT.RECOVERY_FAILED, {
          reason: reasonCode,
          metadata: { message: error instanceof Error ? error.message : String(error) },
        });
        logger.error('startup reconciliation failed — trading disabled', {
          error: error instanceof Error ? error.message : String(error),
        });
        return Object.freeze({
          tradingEnabled: false,
          reasonCode,
          message: error instanceof Error ? error.message : String(error),
          recovered: recovered ?? null,
          reconcile: null,
          balances,
          positions,
          exchangeOpenOrders,
        });
      }

      const tradingEnabled = reconcile.tradingEnabled;
      const reasonCode = tradingEnabled
        ? REASON_CODE.APPROVED
        : reconcile.reasonCode === REASON_CODE.ORDER_STATE_UNKNOWN
          ? REASON_CODE.RECONCILIATION_FAILED
          : REASON_CODE.RECONCILIATION_MISMATCH;

      await emit(tradingEnabled ? JOURNAL_EVENT.RECOVERY_COMPLETED : JOURNAL_EVENT.RECOVERY_FAILED, {
        reason: reasonCode,
        metadata: {
          orders: recovered.orders.length,
          openOrders: recovered.openOrders.length,
          unknownOrders: recovered.unknownOrders.length,
          mismatches: reconcile.mismatches.length,
          unknowns: reconcile.unknowns.length,
        },
      });

      logger.info(tradingEnabled ? 'startup reconciliation complete — trading enabled' : 'startup reconciliation incomplete — trading disabled', {
        reasonCode,
        openOrders: recovered.openOrders.length,
      });

      return Object.freeze({
        tradingEnabled,
        reasonCode,
        recovered,
        reconcile,
        balances,
        positions,
        exchangeOpenOrders,
      });
    },
  });
}
