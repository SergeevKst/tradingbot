/**
 * Order reconciliation — pure comparison of local and exchange state
 * (MASTER_SPEC §13, §15).
 *
 * Given what the local ledger believes and what the exchange reports, this
 * decides one of four things, deterministically and without I/O:
 *
 *   MATCHED   local already agrees with the exchange
 *   ADVANCED  the exchange is ahead (new status and/or more filled quantity)
 *   MISMATCH  the two disagree in a way that must stop trading (exchange
 *             regressed, symbol/quantity differ, illegal state transition)
 *   UNKNOWN   the exchange has no record (or gave none) for a live local order
 *
 * Partial fills are first-class: `filledDelta` is the quantity that filled since
 * the last local observation, so a caller can act on just the increment.
 *
 * @module reconciliation/order-reconciler
 */
import { ORDER_STATUS } from '../types/enums.mjs';
import { isKnownOrderStatus, reduceOrderStatus } from '../testnet/order-state-machine.mjs';
import { ReconciliationError } from '../errors/taxonomy.mjs';

export const RECONCILE_OUTCOME = Object.freeze({
  MATCHED: 'MATCHED',
  ADVANCED: 'ADVANCED',
  MISMATCH: 'MISMATCH',
  UNKNOWN: 'UNKNOWN',
});

/** Quantities are floats from the exchange; absorb representation noise. */
const EPSILON = 1e-9;

/**
 * @typedef {object} LocalOrder
 * @property {string} idempotencyKey
 * @property {string} [clientOrderId]
 * @property {string} [orderId]
 * @property {string} symbol
 * @property {string} [status] a domain ORDER_STATUS, or UNKNOWN
 * @property {number} [filledQuantity]
 * @property {number} [quantity]
 */

/**
 * @param {{ local: LocalOrder, remote: import('../domain/order.mjs').Order | null }} input
 * @returns {Readonly<{ outcome: string, status: string, filledQuantity: number, filledDelta: number, previousStatus: string, previousFilledQuantity: number, reason: string | null, orderId: string | null }>}
 * @throws {ReconciliationError} when the local order itself is malformed
 */
export function reconcileOrder({ local, remote }) {
  if (local === null || typeof local !== 'object') {
    throw new ReconciliationError('reconcileOrder requires a local order', { details: { field: 'local' } });
  }
  const previousStatus = typeof local.status === 'string' ? local.status : 'UNKNOWN';
  const previousFilledQuantity = finiteOrZero(local.filledQuantity);

  if (remote === null || remote === undefined) {
    return freeze({
      outcome: RECONCILE_OUTCOME.UNKNOWN,
      status: previousStatus,
      filledQuantity: previousFilledQuantity,
      filledDelta: 0,
      previousStatus,
      previousFilledQuantity,
      reason: 'ORDER_NOT_FOUND',
      orderId: local.orderId ?? null,
    });
  }

  if (remote.symbol !== local.symbol) {
    return mismatch(local, previousStatus, previousFilledQuantity, 'SYMBOL_MISMATCH', remote);
  }
  if (local.quantity !== undefined && !nearlyEqual(Number(local.quantity), Number(remote.quantity))) {
    return mismatch(local, previousStatus, previousFilledQuantity, 'QUANTITY_MISMATCH', remote);
  }

  const remoteFilled = finiteOrZero(remote.filledQuantity);
  if (remoteFilled + EPSILON < previousFilledQuantity) {
    // The exchange cannot un-fill an order; seeing less filled than before means
    // the local (or exchange) record is wrong. Fail closed.
    return mismatch(local, previousStatus, previousFilledQuantity, 'FILLED_QUANTITY_REGRESSION', remote);
  }

  const status = resolveStatus(local, remote);
  if (status === null) {
    return mismatch(local, previousStatus, previousFilledQuantity, 'ILLEGAL_STATUS_TRANSITION', remote);
  }

  const advanced = status !== previousStatus || remoteFilled > previousFilledQuantity + EPSILON;
  return freeze({
    outcome: advanced ? RECONCILE_OUTCOME.ADVANCED : RECONCILE_OUTCOME.MATCHED,
    status,
    filledQuantity: roundQty(Math.max(previousFilledQuantity, remoteFilled)),
    filledDelta: roundQty(Math.max(0, remoteFilled - previousFilledQuantity)),
    previousStatus,
    previousFilledQuantity,
    reason: advanced ? 'STATE_ADVANCED' : null,
    orderId: remote.orderId ?? local.orderId ?? null,
  });
}

/**
 * Advance the local status towards the exchange status. When local has no usable
 * status (REQUESTED/UNKNOWN), the exchange is authoritative.
 *
 * @param {LocalOrder} local
 * @param {import('../domain/order.mjs').Order} remote
 * @returns {string | null} null when the transition is illegal
 */
function resolveStatus(local, remote) {
  const remoteStatus = remote.status;
  if (!isKnownOrderStatus(remoteStatus)) return null;
  if (!isKnownOrderStatus(local.status)) return remoteStatus;
  if (local.status === remoteStatus) return remoteStatus;
  try {
    return reduceOrderStatus(local.status, remoteStatus);
  } catch {
    return null;
  }
}

/**
 * @param {LocalOrder} local
 * @param {string} previousStatus
 * @param {number} previousFilledQuantity
 * @param {string} reason
 * @param {import('../domain/order.mjs').Order} remote
 */
function mismatch(local, previousStatus, previousFilledQuantity, reason, remote) {
  return freeze({
    outcome: RECONCILE_OUTCOME.MISMATCH,
    status: previousStatus,
    filledQuantity: previousFilledQuantity,
    filledDelta: 0,
    previousStatus,
    previousFilledQuantity,
    reason,
    orderId: remote?.orderId ?? local.orderId ?? null,
  });
}

/**
 * @param {{ outcome: string, status: string, filledQuantity: number, filledDelta: number, previousStatus: string, previousFilledQuantity: number, reason: string | null, orderId: string | null }} value
 */
function freeze(value) {
  return Object.freeze(value);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function finiteOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {number} a
 * @param {number} b
 */
function nearlyEqual(a, b) {
  return Math.abs(a - b) <= EPSILON;
}

/**
 * Remove binary floating-point noise so a delta like 0.29999999999999993 is
 * reported as 0.3. Quantities are not money; 12 decimal places is far beyond
 * any exchange's quantity step and keeps reconciliation deterministic.
 *
 * @param {number} value
 * @returns {number}
 */
function roundQty(value) {
  return Number(value.toFixed(12));
}

/** Terminal domain statuses: no reconciliation action remains. */
export function isResolvedStatus(status) {
  return [ORDER_STATUS.FILLED, ORDER_STATUS.CANCELED, ORDER_STATUS.REJECTED, ORDER_STATUS.EXPIRED].includes(status);
}
