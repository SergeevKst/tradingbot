/**
 * Restart state reload from the journal (MASTER_SPEC §14, Phase 9).
 *
 * The journal is appended before and after every order decision, so replaying it
 * deterministically reconstructs what was in flight when the process died: which
 * intents were reserved, which orders the exchange confirmed, and which are
 * stuck UNKNOWN. This is what lets a restarted process refuse a duplicate it
 * already submitted — the guard is rebuilt from history, not memory.
 *
 * Replay is a pure fold over the events, in order; it performs no I/O.
 *
 * @module recovery/journal-replay
 */
import { ORDER_STATUS } from '../types/enums.mjs';
import { EXECUTION_STATE } from '../types/enums.mjs';
import { GUARD_STATE } from '../reconciliation/duplicate-guard.mjs';
import { JOURNAL_EVENT } from '../state/journal.mjs';

/** Journal event types that mutate the recovered order ledger. */
const ORDER_EVENTS = Object.freeze([
  JOURNAL_EVENT.ORDER_SUBMIT_ATTEMPTED,
  JOURNAL_EVENT.ORDER_SUBMITTED,
  JOURNAL_EVENT.ORDER_SUBMIT_FAILED,
  JOURNAL_EVENT.ORDER_SUBMIT_UNKNOWN,
  JOURNAL_EVENT.ORDER_RECONCILED,
  JOURNAL_EVENT.ORDER_RECONCILE_MISMATCH,
]);

/** Map a recovered guard state to the execution lifecycle (§13). */
const STATE_TO_EXECUTION = Object.freeze({
  [GUARD_STATE.RESERVED]: EXECUTION_STATE.REQUESTED,
  [GUARD_STATE.SUBMITTED]: EXECUTION_STATE.SUBMITTED,
  [GUARD_STATE.UNKNOWN]: EXECUTION_STATE.UNKNOWN,
  [GUARD_STATE.FAILED]: EXECUTION_STATE.FAILED,
});

/**
 * Fold journal events into an order ledger.
 *
 * @param {import('../state/journal.mjs').JournalEvent[]} events
 * @returns {Readonly<{
 *   orders: object[],
 *   byKey: Map<string, object>,
 *   openOrders: object[],
 *   unknownOrders: object[],
 *   duplicates: string[],
 * }>}
 */
export function replayOrderEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError('replayOrderEvents requires an array of journal events');
  }

  /** @type {Map<string, object>} */
  const byKey = new Map();
  const attempts = new Map();

  for (const event of events) {
    if (event === null || typeof event !== 'object' || !ORDER_EVENTS.includes(event.eventType)) continue;
    const meta = event.metadata ?? {};
    const key = meta.idempotencyKey;
    if (typeof key !== 'string' || key === '') continue;

    if (event.eventType === JOURNAL_EVENT.ORDER_SUBMIT_ATTEMPTED) {
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      if (!byKey.has(key)) {
        byKey.set(key, {
          idempotencyKey: key,
          clientOrderId: meta.clientOrderId ?? null,
          orderId: null,
          symbol: event.symbol ?? null,
          side: event.side ?? null,
          quantity: event.quantity ?? null,
          status: EXECUTION_STATE.REQUESTED,
          filledQuantity: 0,
          state: GUARD_STATE.RESERVED,
          mismatch: false,
        });
      }
      continue;
    }

    const existing = byKey.get(key);
    if (existing === undefined) continue;

    switch (event.eventType) {
      case JOURNAL_EVENT.ORDER_SUBMITTED:
        existing.orderId = meta.orderId ?? existing.orderId;
        existing.status = meta.status ?? existing.status ?? ORDER_STATUS.NEW;
        existing.state = GUARD_STATE.SUBMITTED;
        break;
      case JOURNAL_EVENT.ORDER_SUBMIT_FAILED:
        existing.state = GUARD_STATE.FAILED;
        existing.status = EXECUTION_STATE.FAILED;
        break;
      case JOURNAL_EVENT.ORDER_SUBMIT_UNKNOWN:
        existing.state = GUARD_STATE.UNKNOWN;
        existing.status = EXECUTION_STATE.UNKNOWN;
        break;
      case JOURNAL_EVENT.ORDER_RECONCILED:
        existing.orderId = meta.orderId ?? existing.orderId;
        existing.status = meta.status ?? existing.status;
        existing.filledQuantity = finite(meta.filledQuantity, existing.filledQuantity);
        existing.state = GUARD_STATE.SUBMITTED;
        break;
      case JOURNAL_EVENT.ORDER_RECONCILE_MISMATCH:
        existing.mismatch = true;
        break;
      default:
        break;
    }
  }

  const orders = [...byKey.values()].map((order) => Object.freeze({ ...order, executionState: STATE_TO_EXECUTION[order.state] ?? order.state }));
  const openOrders = orders.filter(
    (order) =>
      order.state !== GUARD_STATE.FAILED &&
      ![ORDER_STATUS.FILLED, ORDER_STATUS.CANCELED, ORDER_STATUS.REJECTED, ORDER_STATUS.EXPIRED].includes(order.status),
  );
  const unknownOrders = orders.filter((order) => order.state === GUARD_STATE.UNKNOWN);
  const duplicates = [...attempts.entries()].filter(([, count]) => count > 1).map(([key]) => key);

  return Object.freeze({
    orders,
    byKey,
    openOrders: Object.freeze(openOrders),
    unknownOrders: Object.freeze(unknownOrders),
    duplicates: Object.freeze(duplicates),
  });
}

/**
 * Read the journal and replay it.
 *
 * @param {{ journal: { read: Function } }} input
 * @returns {Promise<ReturnType<typeof replayOrderEvents>>}
 */
export async function recoverOrderState(input) {
  if (input === null || typeof input !== 'object' || input.journal === null || typeof input.journal.read !== 'function') {
    throw new TypeError('recoverOrderState requires { journal } with a read() method');
  }
  const { events } = await input.journal.read();
  return replayOrderEvents(events);
}

/**
 * Load the recovered ledger into a duplicate guard so duplicate prevention
 * survives a restart.
 *
 * @param {ReturnType<import('../reconciliation/duplicate-guard.mjs').createDuplicateGuard>} guard
 * @param {ReturnType<typeof replayOrderEvents>} replay
 * @returns {number} the number of restored records
 */
export function restoreGuard(guard, replay) {
  return guard.restore(
    replay.orders.map((order) => ({
      idempotencyKey: order.idempotencyKey,
      clientOrderId: order.clientOrderId,
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      status: order.status,
      filledQuantity: order.filledQuantity,
      state: order.state,
      mismatch: order.mismatch,
    })),
  );
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finite(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
