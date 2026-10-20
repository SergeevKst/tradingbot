/**
 * RecoverySession — the session-level gate around order reconciliation
 * (MASTER_SPEC §15, Phase 9).
 *
 * The startup reconciler decides *whether* trading may resume; this session
 * remembers that decision and exposes it as an explicit gate. No order may be
 * submitted until `assertCanTrade()` passes, and the session flips to disabled
 * if a later reconciliation discovers a disagreement.
 *
 * @module session/recovery-session
 */
import { ReconciliationError } from '../errors/taxonomy.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';
import { createStartupReconciler } from '../recovery/startup-reconciler.mjs';

/**
 * Create a recovery session. Call `start()` before allowing any trading.
 *
 * @param {Parameters<typeof createStartupReconciler>[0]} options
 */
export function createRecoverySession(options) {
  const reconciler = createStartupReconciler(options);
  /** @type {Awaited<ReturnType<typeof reconciler.start>> | null} */
  let lastResult = null;
  let started = false;

  /** True only after a successful reconciliation that enabled trading. */
  function tradingEnabled() {
    return started && lastResult?.tradingEnabled === true;
  }

  return Object.freeze({
    engine: reconciler.engine,
    guard: reconciler.guard,

    /** Run (or re-run) the startup sequence and store the gate decision. */
    async start() {
      lastResult = await reconciler.start();
      started = true;
      return lastResult;
    },

    tradingEnabled,

    /** The most recent recovery result, or null before `start()`. */
    status() {
      return lastResult;
    },

    /**
     * Fail closed: throws unless recovery ran and enabled trading.
     *
     * @throws {ReconciliationError}
     */
    assertCanTrade() {
      if (tradingEnabled()) return lastResult;
      return throwDisabled(lastResult);
    },

    /** Reconcile the currently tracked orders again and update the gate. */
    async reconcileNow(input = {}) {
      const reconcile = await reconciler.engine.reconcileOpenOrders(input);
      if (lastResult !== null) {
        lastResult = Object.freeze({
          ...lastResult,
          tradingEnabled: reconcile.tradingEnabled,
          reasonCode: reconcile.tradingEnabled ? REASON_CODE.APPROVED : reconcile.reasonCode,
          reconcile,
        });
      }
      return reconcile;
    },
  });
}

/**
 * @param {unknown} lastResult
 * @returns {never}
 * @throws {ReconciliationError}
 */
function throwDisabled(lastResult) {
  const reasonCode = /** @type {any} */ (lastResult)?.reasonCode ?? REASON_CODE.RECONCILIATION_FAILED;
  throw new ReconciliationError(
    `Trading is disabled: startup reconciliation has not completed successfully (${reasonCode}).`,
    { details: { field: 'tradingEnabled', reasonCode } },
  );
}
