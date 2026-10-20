/**
 * Reconciliation engine (MASTER_SPEC §13-15, Phase 9).
 *
 * The orchestrator that turns the pure pieces — idempotency keys, the duplicate
 * guard, the failure policy, the order reconciler — into safe behaviour against
 * an exchange that can time out, lie by omission, or answer slowly.
 *
 * Guarantees:
 *   - at-most-once submission per idempotency key (duplicate prevention);
 *   - an ambiguous write failure never triggers a blind resubmit — it triggers
 *     a lookup by clientOrderId instead;
 *   - a state that cannot be determined is left UNKNOWN and fails closed, never
 *     guessed into FILLED or FAILED;
 *   - every decision is journaled.
 *
 * The exchange is fully injected, so the whole layer is testable without a
 * network, a credential, or a socket.
 *
 * @module reconciliation/reconciliation-engine
 */
import { OrderError, ReconciliationError } from '../errors/taxonomy.mjs';
import { createJournalEvent, JOURNAL_EVENT } from '../state/journal.mjs';
import { ORDER_STATUS } from '../types/enums.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';
import { createOrderRequest } from '../domain/order.mjs';
import { createClientOrderId, createIdempotencyKey } from './idempotency.mjs';
import { createDuplicateGuard, GUARD_STATE } from './duplicate-guard.mjs';
import { classifySubmissionFailure, FAILURE_DECISION } from './failure-policy.mjs';
import { isResolvedStatus, RECONCILE_OUTCOME, reconcileOrder } from './order-reconciler.mjs';

/** Outcomes of a bounded order-state query. */
export const QUERY_STATUS = Object.freeze({
  FOUND: 'FOUND',
  NOT_FOUND: 'NOT_FOUND',
  UNDETERMINED: 'UNDETERMINED',
});

/**
 * @param {{
 *   exchange: { placeOrder: Function, getOrder: Function },
 *   journal?: { record: Function } | Function,
 *   guard?: ReturnType<typeof createDuplicateGuard>,
 *   now?: () => string,
 *   logger?: object,
 *   maxQueryAttempts?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} options
 */
export function createReconciliationEngine(options) {
  if (options === null || typeof options !== 'object' || options.exchange === null || typeof options.exchange !== 'object') {
    throw new ReconciliationError('createReconciliationEngine requires an exchange', { details: { field: 'exchange' } });
  }
  const exchange = options.exchange;
  const now = options.now ?? (() => new Date().toISOString());
  const logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  const maxQueryAttempts = Number.isInteger(options.maxQueryAttempts) && options.maxQueryAttempts > 0 ? options.maxQueryAttempts : 3;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const guard = options.guard ?? createDuplicateGuard({ now });

  const journalRecord = toRecordFn(options.journal);

  /**
   * @param {string} eventType
   * @param {object} fields
   */
  async function emit(eventType, fields) {
    if (journalRecord === null) return;
    const event = createJournalEvent({ eventType, timestamp: now(), ...fields });
    try {
      await journalRecord(event);
    } catch (error) {
      logger.error('reconciliation journal append failed', {
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Look up one order, bounded. Distinguishes a definite answer from an
   * inability to get one — the difference between UNKNOWN and UNDETERMINED.
   *
   * @param {{ symbol: string, orderId?: string, clientOrderId?: string }} params
   * @returns {Promise<{ status: string, order: object | null }>}
   */
  async function queryOrder(params) {
    if (typeof exchange.getOrder !== 'function') {
      throw new ReconciliationError('exchange must implement getOrder', { details: { field: 'exchange' } });
    }
    for (let attempt = 1; attempt <= maxQueryAttempts; attempt += 1) {
      try {
        const order = await exchange.getOrder(params);
        if (order === null || order === undefined) return { status: QUERY_STATUS.NOT_FOUND, order: null };
        return { status: QUERY_STATUS.FOUND, order };
      } catch (error) {
        // A read that fails with a transport/latency error is safe to retry.
        const { decision } = classifySubmissionFailure(error);
        const message = error instanceof Error ? error.message : String(error);
        // The Bybit testnet client signals "no such order" as a DataError; treat
        // that specific answer as NOT_FOUND and everything else as undetermined.
        if (isNoOrderError(error, message)) return { status: QUERY_STATUS.NOT_FOUND, order: null };
        if (decision === FAILURE_DECISION.AMBIGUOUS && attempt < maxQueryAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        if (decision === FAILURE_DECISION.AMBIGUOUS) {
          return { status: QUERY_STATUS.UNDETERMINED, order: null };
        }
        // Validation/config/auth failures are not retried; the state is unknown.
        return { status: QUERY_STATUS.UNDETERMINED, order: null };
      }
    }
    return { status: QUERY_STATUS.UNDETERMINED, order: null };
  }

  /**
   * Recover after an ambiguous submission failure by looking the order up by
   * its deterministic clientOrderId. The key is NEVER released on the strength
   * of a failed request alone.
   *
   * @param {{ symbol: string, idempotencyKey: string, clientOrderId: string, request: object }} input
   */
  async function recoverAmbiguous(input) {
    const query = await queryOrder({ symbol: input.symbol, clientOrderId: input.clientOrderId });
    if (query.status === QUERY_STATUS.FOUND) {
      const record = guard.confirm(input.idempotencyKey, {
        orderId: query.order.orderId,
        clientOrderId: input.clientOrderId,
        symbol: input.symbol,
        status: query.order.status,
        filledQuantity: query.order.filledQuantity,
        quantity: query.order.quantity,
        recovered: true,
      });
      await emit(JOURNAL_EVENT.ORDER_SUBMITTED, {
        symbol: input.symbol,
        quantity: record.quantity ?? input.request.quantity,
        reason: 'RECOVERED_AFTER_AMBIGUOUS_FAILURE',
        metadata: {
          idempotencyKey: input.idempotencyKey,
          clientOrderId: input.clientOrderId,
          orderId: query.order.orderId,
        },
      });
      return { ok: true, duplicate: false, recovered: true, order: record };
    }

    // NOT_FOUND after an ambiguous write still does not prove the order was
    // never created (an IOC order leaves the realtime book immediately), so it
    // stays UNKNOWN for an operator or a later reconciliation to resolve.
    guard.markUnknown(input.idempotencyKey, {
      orderId: undefined,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      reason: REASON_CODE.ORDER_STATE_UNKNOWN,
    });
    await emit(JOURNAL_EVENT.ORDER_SUBMIT_UNKNOWN, {
      symbol: input.symbol,
      reason: query.status === QUERY_STATUS.NOT_FOUND ? REASON_CODE.ORDER_NOT_FOUND : REASON_CODE.RECONCILIATION_UNDETERMINED,
      metadata: { idempotencyKey: input.idempotencyKey, clientOrderId: input.clientOrderId, queryStatus: query.status },
    });
    return {
      ok: false,
      duplicate: false,
      unknown: true,
      reasonCode: REASON_CODE.ORDER_STATE_UNKNOWN,
      message: 'Order state is unknown after an ambiguous failure; reconcile before retrying.',
    };
  }

  const api = {
    guard,

    /**
     * Submit an order exactly once.
     *
     * @param {{ request: object, intent?: object }} input
     * @returns {Promise<object>}
     */
    async submitOrder(input) {
      if (input === null || typeof input !== 'object' || input.request === null || typeof input.request !== 'object') {
        throw new ReconciliationError('submitOrder requires { request }', { details: { field: 'request' } });
      }
      if (typeof exchange.placeOrder !== 'function') {
        throw new ReconciliationError('exchange must implement placeOrder', { details: { field: 'exchange' } });
      }
      const request = createOrderRequest({ ...input.request, clientOrderId: undefined });
      const intent = { ...request, ...(input.intent ?? {}) };
      const idempotencyKey = createIdempotencyKey(intent);
      const clientOrderId = createClientOrderId(idempotencyKey);

      const claim = guard.reserve(idempotencyKey, {
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        quantity: request.quantity,
        clientOrderId,
      });

      if (!claim.reserved) {
        await emit(JOURNAL_EVENT.DUPLICATE_ORDER_BLOCKED, {
          symbol: request.symbol,
          side: request.side,
          quantity: request.quantity,
          reason: REASON_CODE.DUPLICATE_ORDER,
          metadata: { idempotencyKey, clientOrderId, existingState: claim.existing?.state ?? null },
        });
        return {
          ok: false,
          duplicate: true,
          reasonCode: REASON_CODE.DUPLICATE_ORDER,
          message: 'A submission with this idempotency key already exists; refused to avoid a duplicate order.',
          existing: claim.existing,
        };
      }

      await emit(JOURNAL_EVENT.ORDER_SUBMIT_ATTEMPTED, {
        symbol: request.symbol,
        side: request.side,
        quantity: request.quantity,
        metadata: { idempotencyKey, clientOrderId },
      });

      let placed;
      try {
        placed = await exchange.placeOrder({ ...request, clientOrderId });
      } catch (error) {
        const failure = classifySubmissionFailure(error);
        if (failure.decision === FAILURE_DECISION.REFUSED) {
          // Provably never placed: release the key and report the refusal.
          guard.markFailed(idempotencyKey, { reason: failure.code });
          await emit(JOURNAL_EVENT.ORDER_SUBMIT_FAILED, {
            symbol: request.symbol,
            side: request.side,
            quantity: request.quantity,
            reason: failure.code,
            metadata: { idempotencyKey, clientOrderId, message: failure.message },
          });
          return {
            ok: false,
            refused: true,
            reasonCode: failure.code,
            message: failure.message,
          };
        }
        // Ambiguous: the order may exist. Recover by key, never resubmit.
        logger.warn('ambiguous submission failure — reconciling by clientOrderId', {
          clientOrderId,
          code: failure.code,
        });
        return recoverAmbiguous({ symbol: request.symbol, idempotencyKey, clientOrderId, request });
      }

      const orderId = pickOrderId(placed);
      const status = pickStatus(placed);
      const filledQuantity = pickNumber(placed, 'filledQuantity') ?? 0;
      const record = guard.confirm(idempotencyKey, {
        orderId,
        clientOrderId,
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        quantity: request.quantity,
        status,
        filledQuantity,
      });
      await emit(JOURNAL_EVENT.ORDER_SUBMITTED, {
        symbol: request.symbol,
        side: request.side,
        quantity: request.quantity,
        reason: 'SUBMITTED',
        metadata: { idempotencyKey, clientOrderId, orderId, status },
      });
      return { ok: true, duplicate: false, order: record };
    },

    /**
     * Reconcile one tracked order against the exchange.
     *
     * @param {object} localOrder
     * @returns {Promise<object>}
     */
    async reconcileOrder(localOrder) {
      const params = { symbol: localOrder.symbol };
      if (localOrder.orderId !== undefined && localOrder.orderId !== null) params.orderId = localOrder.orderId;
      else if (localOrder.clientOrderId !== undefined) params.clientOrderId = localOrder.clientOrderId;

      const query = await queryOrder(params);
      const remote = query.status === QUERY_STATUS.FOUND ? query.order : null;
      const result = reconcileOrder({ local: localOrder, remote });

      if (result.outcome === RECONCILE_OUTCOME.MISMATCH) {
        await emit(JOURNAL_EVENT.ORDER_RECONCILE_MISMATCH, {
          symbol: localOrder.symbol,
          reason: REASON_CODE.RECONCILIATION_MISMATCH,
          metadata: { idempotencyKey: localOrder.idempotencyKey, detail: result.reason, ...result },
        });
      } else {
        guard.update(localOrder.idempotencyKey, {
          status: result.status,
          filledQuantity: result.filledQuantity,
          orderId: result.orderId ?? localOrder.orderId,
        });
        await emit(JOURNAL_EVENT.ORDER_RECONCILED, {
          symbol: localOrder.symbol,
          quantity: result.filledDelta > 0 ? result.filledDelta : null,
          reason: result.outcome,
          metadata: {
            idempotencyKey: localOrder.idempotencyKey,
            previousStatus: result.previousStatus,
            status: result.status,
            filledQuantity: result.filledQuantity,
            filledDelta: result.filledDelta,
            queryStatus: query.status,
          },
        });
      }

      return Object.freeze({
        idempotencyKey: localOrder.idempotencyKey,
        outcome: result.outcome,
        status: result.status,
        filledQuantity: result.filledQuantity,
        filledDelta: result.filledDelta,
        reason: result.reason,
        queryStatus: query.status,
      });
    },

    /**
     * Reconcile every unresolved local order. Any mismatch or undeterminable
     * state disables trading, per MASTER_SPEC §15.
     *
     * @param {{ symbol?: string }} [input]
     * @returns {Promise<object>}
     */
    async reconcileOpenOrders(input = {}) {
      const locals = guard
        .entries()
        .filter((entry) => entry.state !== GUARD_STATE.FAILED)
        .filter((entry) => (input.symbol === undefined ? true : entry.symbol === input.symbol))
        .filter((entry) => !isResolvedStatus(entry.status));

      const results = [];
      const mismatches = [];
      const unknowns = [];

      for (const local of locals) {
        const result = await api.reconcileOrder({
          idempotencyKey: local.idempotencyKey,
          clientOrderId: local.clientOrderId,
          orderId: local.orderId,
          symbol: local.symbol,
          quantity: local.quantity,
          status: local.status,
          filledQuantity: local.filledQuantity,
        });
        results.push(result);
        if (result.outcome === RECONCILE_OUTCOME.MISMATCH) mismatches.push(result);
        if (result.outcome === RECONCILE_OUTCOME.UNKNOWN) unknowns.push(result);
      }

      const ok = mismatches.length === 0 && unknowns.length === 0;
      return Object.freeze({
        ok,
        tradingEnabled: ok,
        reasonCode: ok ? REASON_CODE.APPROVED : mismatches.length > 0 ? REASON_CODE.RECONCILIATION_MISMATCH : REASON_CODE.ORDER_STATE_UNKNOWN,
        results,
        mismatches,
        unknowns,
      });
    },
  };

  return Object.freeze(api);
}

/**
 * @param {unknown} journal
 * @returns {((event: object) => Promise<unknown>) | null}
 */
function toRecordFn(journal) {
  if (typeof journal === 'function') return /** @type {any} */ (journal);
  if (journal !== null && typeof journal === 'object' && typeof /** @type {any} */ (journal).record === 'function') {
    return (event) => /** @type {any} */ (journal).record(event);
  }
  return null;
}

/**
 * The testnet client throws a DataError for "no order"; that is a definite
 * answer. Any other failure is undetermined.
 *
 * @param {unknown} error
 * @param {string} message
 */
function isNoOrderError(error, message) {
  return /no order/i.test(message) || /** @type {any} */ (error)?.details?.notFound === true;
}

/** @param {unknown} value */
function pickOrderId(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const obj = /** @type {Record<string, unknown>} */ (value);
  return obj.orderId ?? obj.order_id ?? undefined;
}

/** @param {unknown} value */
function pickStatus(value) {
  if (value === null || typeof value !== 'object') return ORDER_STATUS.NEW;
  const status = /** @type {any} */ (value).status;
  return typeof status === 'string' ? status : ORDER_STATUS.NEW;
}

/** @param {unknown} value @param {string} key */
function pickNumber(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  const parsed = Number(/** @type {any} */ (value)[key]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Deterministic exponential-ish backoff with no randomness.
 *
 * @param {number} attempt
 * @returns {number}
 */
function backoffMs(attempt) {
  return Math.min(1000, 50 * 2 ** (attempt - 1));
}
