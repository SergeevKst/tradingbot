/**
 * AI-derived effect gateway (UAI-06B, architecture §5 "AI-derived effects").
 *
 * This is the only path from the bot to an exchange write that is derived from
 * AI output. It exists because the effect is never adjacent to the model call:
 * a Scout/Guard response is turned into a preview ticket, an exit proposal or an
 * unattended entry, and the human (or the timer) may dispatch it minutes later.
 * `src/telegram/bot.mjs` therefore routes every AI-derived dispatch through this
 * module, which owns one lifecycle:
 *
 *   provenance  — a pending approval sidecar (generation + binding) bound to the
 *                 exact artifact the ticket was built from;
 *   consumption — synchronous counted token before the caller's first await;
 *   check       — control record reread immediately before the dispatch;
 *   settlement  — `settle()` when the outcome is known, `retain()` when it is
 *                 unknown (the counted token then blocks a QUIESCED ack until an
 *                 operator reconciles it), `rearm()` when the effect definitely
 *                 did not happen so the operator can retry.
 *
 * Deterministic protection (harvest/time-stop/trailing stops) never uses this
 * module: those paths are not AI-derived and must keep running in every phase.
 *
 * @module telegram/ai-effect-gateway
 */
import { isCoordinationError, CoordinationError, COORDINATION_ERROR_CODE } from '../errors/coordination-error.mjs';

/**
 * An exchange answered with an explicit error code: the order was definitively
 * not accepted (e.g. insufficient balance, invalid quantity). Anything else —
 * a socket error, a timeout, a DNS failure — leaves the outcome unknown and must
 * be reconciled, never retried.
 */
const DEFINITE_DISPATCH_FAILURE = /retCode=-?\d+/;

/** @typedef {'definite' | 'unknown'} DispatchOutcome */

/**
 * @param {unknown} error
 * @returns {DispatchOutcome}
 */
export function classifyDispatchOutcome(error) {
  if (isCoordinationError(error)) return 'definite';
  const message = error instanceof Error ? error.message : String(error);
  return DEFINITE_DISPATCH_FAILURE.test(message) ? 'definite' : 'unknown';
}

/**
 * An exchange write whose outcome is unknown. The error is re-thrown with this
 * marker so the caller can tell the operator that reconciliation is required
 * instead of reporting an ordinary failure.
 */
export class UnknownEffectOutcome extends CoordinationError {
  /**
   * @param {string} message
   * @param {string} lane
   * @param {unknown} cause
   */
  constructor(message, lane, cause) {
    super(message, {
      code: COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE,
      details: { lane, requiresReconciliation: true },
      cause,
    });
    this.name = 'UnknownEffectOutcome';
    this.lane = lane;
    this.requiresReconciliation = true;
  }
}

/**
 * @param {{ composition: any | null, logger?: { warn: Function, error: Function, info: Function } }} input
 */
export function createAIEffectGateway(input) {
  const composition = input?.composition ?? null;
  const logger = input?.logger ?? { debug() {}, info() {}, warn() {}, error() {} };

  /**
   * Run AI-derived work under one counted scope. In legacy mode there is no
   * control plane and the callback simply runs with `null`.
   *
   * @template T
   * @param {string} operation
   * @param {(work: any) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function workflow(operation, fn) {
    if (composition === null) return fn(null);
    return composition.runInWorkflow(operation, (_token, work) => fn(work));
  }

  /**
   * Consume the provenance for one AI-derived effect. Synchronous and atomic:
   * it throws when the sidecar is absent (restart, decline, already consumed) or
   * belongs to a retired generation, in which case no effect may run.
   *
   * @param {string} approvalId
   * @returns {any | null} counted effect handle, or null in legacy mode
   */
  function consume(approvalId) {
    if (composition === null) return null;
    return composition.beginApprovalConsumption(approvalId);
  }

  /**
   * Bind the provenance of a consumable effect for later (the final confirm tap
   * of a preview ticket, the close button of an exit proposal).
   *
   * @param {string} approvalId
   * @param {any} handle counted handle from {@link consume} or a workflow handle
   * @param {{ operation?: string, purpose?: string }} [meta]
   */
  function hold(approvalId, handle, meta = {}) {
    if (composition === null || handle === null) return null;
    return handle.rearm(approvalId, meta);
  }

  /**
   * Run the caller's preparation step inside the counted scope.
   *
   * `prepare` is everything the dispatch needs *before* the exchange write that
   * is not itself an exchange write: reading the spot instrument metadata and
   * re-snapping the quantity, applying leverage, fetching the position a close
   * will use, and deciding whether the market has moved too far to trade. It
   * runs inside the counted scope (the token covers the whole effect, not just
   * the last call), and the control record is reread *after* it, so a generation
   * switch during a slow metadata read still prevents the write.
   *
   * It may return `{ abort: <message> }` to refuse the trade without writing
   * anything; any other return value (including `undefined`) proceeds.
   *
   * @param {{ prepare?: () => Promise<{ abort?: string } | void> }} plan
   * @returns {Promise<{ abort?: string }>} `{}` when the effect may proceed
   */
  async function prepare(plan) {
    if (typeof plan.prepare !== 'function') return {};
    const prepared = await plan.prepare();
    return prepared === null || prepared === undefined ? {} : prepared;
  }

  /**
   * Release a counted handle after the preparation failed. Nothing reached the
   * exchange — preparation only reads exchange metadata and decides — so the
   * scope is always released and never retained. When the plan is bound to a
   * ticket key the provenance returns to that ticket, which keeps the baseline
   * retry path (pick another leverage, confirm again) working without a new
   * analysis.
   *
   * @param {any} handle
   * @param {{ rearmAs?: string | null }} plan
   */
  function releaseAfterPrepareFailure(handle, plan) {
    if (typeof plan.rearmAs === 'string' && plan.rearmAs !== '') {
      try {
        handle.rearm(plan.rearmAs, { purpose: 'effect' });
        return;
      } catch (rearmError) {
        logger.warn('could not return the AI effect provenance to its ticket', {
          reason: rearmError instanceof Error ? rearmError.message : String(rearmError),
        });
      }
    }
    handle.settle();
  }

  /**
   * The legacy (no control plane) shape: preparation, its abort, then the write.
   * The plan shape is identical to the counted path, so the exchange side
   * effects are the same in both modes.
   *
   * @template T
   * @param {{ prepare?: () => Promise<{ abort?: string } | void>, effect: () => Promise<T> }} plan
   * @returns {Promise<T | { aborted: string }>}
   */
  async function dispatchUncounted(plan) {
    const prepared = await prepare(plan);
    if (prepared.abort) return { aborted: prepared.abort };
    return plan.effect();
  }

  /**
   * Dispatch one AI-derived effect under a counted handle.
   *
   * @template T
   * @param {any} handle counted handle (`beginApprovalConsumption`) or null in legacy mode
   * @param {{ lane: string, prepare?: () => Promise<{ abort?: string } | void>, effect: () => Promise<T>, rearmAs?: string | null }} plan
   * @returns {Promise<T | { aborted: string }>}
   */
  async function dispatch(handle, plan) {
    if (handle === null) return dispatchUncounted(plan);

    let prepared;
    try {
      prepared = await prepare(plan);
    } catch (error) {
      releaseAfterPrepareFailure(handle, plan);
      throw error;
    }
    if (prepared.abort) {
      // The preparation refused the trade (the market moved past the slippage
      // threshold, the position is already gone). Nothing was sent, so the
      // scope is released and the caller reports the reason to its user.
      handle.settle();
      return { aborted: prepared.abort };
    }
    try {
      handle.check();
    } catch (error) {
      // Refused before anything was sent: the analysis belongs to a retired
      // generation. Release the scope and report a stale analysis.
      handle.settle();
      throw error;
    }
    let result;
    try {
      result = await plan.effect();
    } catch (error) {
      const outcome = classifyDispatchOutcome(error);
      if (outcome === 'definite') {
        if (typeof plan.rearmAs === 'string' && plan.rearmAs !== '') {
          // Definitively refused by the exchange: keep the provenance so the
          // operator may retry the same ticket without a fresh analysis.
          handle.rearm(plan.rearmAs, { purpose: 'effect' });
        } else {
          handle.settle();
        }
        throw error;
      }
      handle.retain(`${plan.lane}: ${error instanceof Error ? error.message : String(error)}`);
      logger.error('AI-derived effect outcome is unknown; reconciliation required', {
        lane: plan.lane,
        workId: handle.token?.id ?? null,
      });
      throw new UnknownEffectOutcome(
        `${plan.lane}: the exchange outcome is unknown; it must be reconciled before AI can quiesce`,
        plan.lane,
        error,
      );
    }
    handle.settle();
    return result;
  }

  /**
   * Dispatch inside an already counted workflow scope (stop-check auto-close,
   * unattended entry). Same lifecycle as {@link dispatch}, without a sidecar:
   * preparation runs under the workflow token, then the check, then the write.
   * A preparation failure propagates and the enclosing workflow scope releases
   * its token in its own `finally`.
   *
   * @template T
   * @param {any} work workflow handle (null in legacy mode)
   * @param {{ lane: string, prepare?: () => Promise<{ abort?: string } | void>, effect: () => Promise<T> }} plan
   * @returns {Promise<T | { aborted: string }>}
   */
  async function dispatchInScope(work, plan) {
    if (work === null || work === undefined) return dispatchUncounted(plan);
    const prepared = await prepare(plan);
    if (prepared.abort) return { aborted: prepared.abort };
    try {
      work.check();
    } catch (error) {
      work.settle();
      throw error;
    }
    let result;
    try {
      result = await plan.effect();
    } catch (error) {
      if (classifyDispatchOutcome(error) === 'definite') throw error;
      work.retain(`${plan.lane}: ${error instanceof Error ? error.message : String(error)}`);
      logger.error('AI-derived effect outcome is unknown; reconciliation required', {
        lane: plan.lane,
        workId: work.token?.id ?? null,
      });
      throw new UnknownEffectOutcome(
        `${plan.lane}: the exchange outcome is unknown; it must be reconciled before AI can quiesce`,
        plan.lane,
        error,
      );
    }
    return result;
  }

  /**
   * Drop a bound effect without running it (decline, cancel, stale card).
   *
   * @param {string} approvalId
   */
  function drop(approvalId) {
    if (composition === null) return false;
    return composition.dropPendingApproval(approvalId);
  }

  return Object.freeze({
    enabled: composition !== null,
    composition,
    workflow,
    consume,
    hold,
    dispatch,
    dispatchInScope,
    drop,
    classify: classifyDispatchOutcome,
    status: () => (composition === null ? null : composition.status()),
    pending: () => (composition === null ? 0 : composition.pendingApprovalCount()),
    unresolved: () => (composition === null ? 0 : composition.unresolvedEffects()),
    reconcile: (reference) => {
      if (composition === null) {
        throw new CoordinationError('the AI effect gateway has no control plane', {
          code: COORDINATION_ERROR_CODE.ACTIVATION_PAUSED,
        });
      }
      return composition.reconcileUnresolved(reference);
    },
  });
}


