/**
 * Basic order state machine (MASTER_SPEC Phase 8).
 *
 * An order's live status arrives repeatedly from the REST query and the private
 * stream, often out of order and sometimes duplicated. This is the deterministic
 * reducer that folds those updates into a single state and refuses transitions
 * that cannot physically happen (a Filled order cannot become New again).
 *
 * It is pure: no I/O, no clock, no randomness. Unknown states and illegal moves
 * fail closed with an `OrderError` — an order in an impossible state must stop
 * the caller, not be smoothed over.
 *
 * @module testnet/order-state-machine
 */
import { ORDER_STATUS, ORDER_STATUSES } from '../types/enums.mjs';
import { OrderError } from '../errors/taxonomy.mjs';

/** Terminal states that accept no further transition. */
const TERMINAL = Object.freeze([ORDER_STATUS.FILLED, ORDER_STATUS.CANCELED, ORDER_STATUS.REJECTED, ORDER_STATUS.EXPIRED]);

/** Legal non-terminal -> next-state transitions. */
const TRANSITIONS = Object.freeze({
  [ORDER_STATUS.NEW]: Object.freeze([
    ORDER_STATUS.PARTIALLY_FILLED,
    ORDER_STATUS.FILLED,
    ORDER_STATUS.CANCELED,
    ORDER_STATUS.REJECTED,
    ORDER_STATUS.EXPIRED,
  ]),
  [ORDER_STATUS.PARTIALLY_FILLED]: Object.freeze([ORDER_STATUS.FILLED, ORDER_STATUS.CANCELED, ORDER_STATUS.EXPIRED]),
});

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isKnownOrderStatus(status) {
  return typeof status === 'string' && ORDER_STATUSES.includes(status);
}

/**
 * @param {unknown} status
 * @returns {boolean}
 * @throws {OrderError} on an unknown status
 */
export function isTerminalOrderStatus(status) {
  requireKnown(status);
  return TERMINAL.includes(/** @type {string} */ (status));
}

/**
 * The state a freshly accepted order starts in.
 *
 * @returns {string}
 */
export function initialOrderStatus() {
  return ORDER_STATUS.NEW;
}

/**
 * Fold one observed status into the current state.
 *
 * A repeated identical status is an idempotent no-op. Any other move must be in
 * the transition table, otherwise it is an `OrderError`.
 *
 * @param {string} current
 * @param {string} incoming
 * @returns {string} the next state (equals `incoming` when legal)
 * @throws {OrderError}
 */
export function reduceOrderStatus(current, incoming) {
  requireKnown(current);
  requireKnown(incoming);

  if (current === incoming) return current;

  const allowed = TRANSITIONS[current];
  if (allowed !== undefined && allowed.includes(incoming)) return incoming;

  throw new OrderError(`Illegal order state transition ${current} -> ${incoming}`, {
    details: { field: 'orderStatus', from: current, to: incoming },
  });
}

/**
 * @param {unknown} status
 * @throws {OrderError}
 */
function requireKnown(status) {
  if (!isKnownOrderStatus(status)) {
    throw new OrderError(`Unknown order status ${JSON.stringify(status)}`, { details: { field: 'orderStatus', value: status } });
  }
}
