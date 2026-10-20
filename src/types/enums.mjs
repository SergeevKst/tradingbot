/**
 * Canonical enum vocabularies shared by the domain types.
 *
 * Only exchange-agnostic vocabularies belong here. Bybit's raw string codes are
 * mapped onto these in the exchange layer, so the domain never has to know what
 * Bybit happened to call a status (MASTER_SPEC §48).
 *
 * @module types/enums
 */

/** How an order is priced. */
export const ORDER_TYPE = Object.freeze({
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
});

/** Lifecycle of an order, as the core models it. */
export const ORDER_STATUS = Object.freeze({
  NEW: 'NEW',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELED: 'CANCELED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
});

/** How long an order remains live. */
export const TIME_IN_FORCE = Object.freeze({
  GTC: 'GTC',
  IOC: 'IOC',
  FOK: 'FOK',
  POST_ONLY: 'POST_ONLY',
});

/**
 * Execution lifecycle of a submitted intent (MASTER_SPEC §13).
 *
 * This is intentionally distinct from ORDER_STATUS: the exchange reports an
 * order as NEW/PARTIALLY_FILLED/FILLED/..., while the local execution layer also
 * has to model the moments before and around that, where the truth is not yet
 * known — REQUESTED (submitted, no answer), UNKNOWN (ambiguous failure, needs
 * reconciliation) and FAILED (provably never placed).
 */
export const EXECUTION_STATE = Object.freeze({
  REQUESTED: 'REQUESTED',
  SUBMITTED: 'SUBMITTED',
  ACCEPTED: 'ACCEPTED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  CANCELED: 'CANCELED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});

/** Whether a modelled position is still held. */
export const POSITION_STATUS = Object.freeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
});

/** The outcome of evaluating a strategy. */
export const SIGNAL_ACTION = Object.freeze({
  EMIT: 'EMIT',
  NO_SIGNAL: 'NO_SIGNAL',
});

/** Directional view of an AI analysis; never an order. */
export const ANALYSIS_BIAS = Object.freeze({
  BULLISH: 'BULLISH',
  BEARISH: 'BEARISH',
  NEUTRAL: 'NEUTRAL',
});

/** @type {readonly string[]} */
export const ORDER_TYPES = Object.freeze(Object.values(ORDER_TYPE));
/** @type {readonly string[]} */
export const ORDER_STATUSES = Object.freeze(Object.values(ORDER_STATUS));
/** @type {readonly string[]} */
export const TIMES_IN_FORCE = Object.freeze(Object.values(TIME_IN_FORCE));
/** @type {readonly string[]} */
export const EXECUTION_STATES = Object.freeze(Object.values(EXECUTION_STATE));
/** @type {readonly string[]} */
export const POSITION_STATUSES = Object.freeze(Object.values(POSITION_STATUS));
/** @type {readonly string[]} */
export const SIGNAL_ACTIONS = Object.freeze(Object.values(SIGNAL_ACTION));
/** @type {readonly string[]} */
export const ANALYSIS_BIASES = Object.freeze(Object.values(ANALYSIS_BIAS));
