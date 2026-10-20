/**
 * Machine-readable rejection reason codes.
 *
 * Every risk decision carries one of these codes so that callers, tests and
 * future monitoring can branch on a stable identifier instead of parsing prose.
 * Free-text `message` fields are supplementary only.
 *
 * @module domain/reason-code
 */

export const REASON_CODE = Object.freeze({
  APPROVED: 'APPROVED',
  /** A strategy evaluated its context and deliberately emitted no proposal. */
  NO_SIGNAL: 'NO_SIGNAL',

  // --- proposal shape / validity -------------------------------------------
  INVALID_SYMBOL: 'INVALID_SYMBOL',
  INVALID_SIDE: 'INVALID_SIDE',
  INVALID_ENTRY_PRICE: 'INVALID_ENTRY_PRICE',
  INVALID_STOP_LOSS: 'INVALID_STOP_LOSS',
  INVALID_TAKE_PROFIT: 'INVALID_TAKE_PROFIT',
  INVALID_CONFIDENCE: 'INVALID_CONFIDENCE',
  MISSING_STRATEGY_ID: 'MISSING_STRATEGY_ID',
  MALFORMED_PROPOSAL: 'MALFORMED_PROPOSAL',

  // --- geometry -------------------------------------------------------------
  STOP_LOSS_ON_WRONG_SIDE: 'STOP_LOSS_ON_WRONG_SIDE',
  TAKE_PROFIT_ON_WRONG_SIDE: 'TAKE_PROFIT_ON_WRONG_SIDE',
  ZERO_RISK_DISTANCE: 'ZERO_RISK_DISTANCE',
  NONSENSICAL_PRICE_GEOMETRY: 'NONSENSICAL_PRICE_GEOMETRY',

  // --- protective orders ----------------------------------------------------
  MISSING_STOP_LOSS: 'MISSING_STOP_LOSS',
  MISSING_TAKE_PROFIT: 'MISSING_TAKE_PROFIT',
  INVALID_RISK_REWARD: 'INVALID_RISK_REWARD',

  // --- limits ---------------------------------------------------------------
  RISK_LIMIT_EXCEEDED: 'RISK_LIMIT_EXCEEDED',
  RISK_AMOUNT_TOO_SMALL: 'RISK_AMOUNT_TOO_SMALL',
  DAILY_LOSS_LIMIT: 'DAILY_LOSS_LIMIT',
  MAX_DRAWDOWN: 'MAX_DRAWDOWN',
  MAX_OPEN_POSITIONS: 'MAX_OPEN_POSITIONS',
  MAX_TRADES_PER_DAY: 'MAX_TRADES_PER_DAY',
  SYMBOL_EXPOSURE_LIMIT: 'SYMBOL_EXPOSURE_LIMIT',
  TOTAL_EXPOSURE_LIMIT: 'TOTAL_EXPOSURE_LIMIT',
  LEVERAGE_LIMIT: 'LEVERAGE_LIMIT',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  POSITION_NOTIONAL_TOO_SMALL: 'POSITION_NOTIONAL_TOO_SMALL',
  CONFLICTING_POSITION: 'CONFLICTING_POSITION',
  DUPLICATE_PROPOSAL: 'DUPLICATE_PROPOSAL',

  // --- infrastructure -------------------------------------------------------
  INVALID_ACCOUNT_STATE: 'INVALID_ACCOUNT_STATE',
  INVALID_MARKET_STATE: 'INVALID_MARKET_STATE',
  INVALID_RISK_CONFIG: 'INVALID_RISK_CONFIG',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNSUPPORTED_MODE: 'UNSUPPORTED_MODE',
  LIVE_TRADING_DISABLED: 'LIVE_TRADING_DISABLED',
  KILL_SWITCH_ENGAGED: 'KILL_SWITCH_ENGAGED',

  // --- execution (Stage 2 paper layer) --------------------------------------
  /** Bid or ask is missing, so no honest fill price can be produced. */
  MISSING_BID_ASK: 'MISSING_BID_ASK',
  /** No usable reference price (neither mark nor last) to evaluate triggers. */
  MISSING_REFERENCE_PRICE: 'MISSING_REFERENCE_PRICE',
  /** Sizing produced a quantity that does not survive qtyStep/min/max rules. */
  UNREPRESENTABLE_QUANTITY: 'UNREPRESENTABLE_QUANTITY',
  /** No open position on that symbol. */
  NO_OPEN_POSITION: 'NO_OPEN_POSITION',
  /** A position already exists on that symbol (one net position per symbol). */
  POSITION_ALREADY_OPEN: 'POSITION_ALREADY_OPEN',
  /** Instrument metadata was required but not supplied. */
  MISSING_INSTRUMENT_INFO: 'MISSING_INSTRUMENT_INFO',
  /** The executor was handed a risk result that was not an approval. */
  EXECUTION_REQUIRES_APPROVAL: 'EXECUTION_REQUIRES_APPROVAL',
  /** Protected level failed its own geometry check when being modified. */
  INVALID_PROTECTION_LEVEL: 'INVALID_PROTECTION_LEVEL',
  /** The adapter is not permitted to place real orders. */
  REAL_ORDERS_NOT_PERMITTED: 'REAL_ORDERS_NOT_PERMITTED',

  // --- one-shot TESTNET_ONCE ------------------------------------------------
  /** The single permitted submission was already attempted; a second is refused. */
  ONE_SHOT_EXHAUSTED: 'ONE_SHOT_EXHAUSTED',
  /** The one-shot session has already completed and shut down. */
  ONE_SHOT_SHUTDOWN: 'ONE_SHOT_SHUTDOWN',

  // --- live safety gate (MASTER_SPEC Phase 10, §46) -------------------------
  /** At least one §46 checklist condition or runtime safety check failed. */
  LIVE_GATE_REFUSED: 'LIVE_GATE_REFUSED',
  /** LIVE_ENABLED is not explicitly true, so live activation is refused. */
  LIVE_FLAG_NOT_ENABLED: 'LIVE_FLAG_NOT_ENABLED',
  /** One or more §46 checklist items are missing or not attested true. */
  LIVE_CHECKLIST_INCOMPLETE: 'LIVE_CHECKLIST_INCOMPLETE',
  /** Live and testnet credentials are not separated. */
  LIVE_CREDENTIAL_SEPARATION_FAILED: 'LIVE_CREDENTIAL_SEPARATION_FAILED',
  /** The risk limit set is invalid for a live run. */
  LIVE_RISK_CONFIG_INVALID: 'LIVE_RISK_CONFIG_INVALID',
  /** The emergency stop control is missing or malformed. */
  LIVE_KILL_SWITCH_INVALID: 'LIVE_KILL_SWITCH_INVALID',
  /** The emergency stop is engaged, so live activation/entry is refused. */
  LIVE_KILL_SWITCH_ENGAGED: 'LIVE_KILL_SWITCH_ENGAGED',
  /** No append-only audit journal is available to record live events. */
  LIVE_AUDIT_UNAVAILABLE: 'LIVE_AUDIT_UNAVAILABLE',

  // --- reconciliation / recovery (MASTER_SPEC Phase 9) ----------------------
  /** The same idempotency key was already submitted; the retry is refused. */
  DUPLICATE_ORDER: 'DUPLICATE_ORDER',
  /** A network/API failure left it unknown whether the order exists. */
  ORDER_STATE_UNKNOWN: 'ORDER_STATE_UNKNOWN',
  /** The exchange has no record of an order the local state believes exists. */
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  /** Local and exchange state disagree in a way that must stop trading. */
  RECONCILIATION_MISMATCH: 'RECONCILIATION_MISMATCH',
  /** Startup reconciliation did not complete; trading stays disabled (§15). */
  RECONCILIATION_FAILED: 'RECONCILIATION_FAILED',
  /** A bounded reconciliation query could not determine the order state. */
  RECONCILIATION_UNDETERMINED: 'RECONCILIATION_UNDETERMINED',
});

/** @type {readonly string[]} */
export const REASON_CODES = Object.freeze(Object.values(REASON_CODE));

/** Codes that mean "approved". */
export const APPROVED_CODE = REASON_CODE.APPROVED;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isReasonCode(value) {
  return typeof value === 'string' && REASON_CODES.includes(value);
}

/**
 * Coerce an unknown error into a safe reason code.
 *
 * Fail-closed helper: anything unrecognised becomes INTERNAL_ERROR, which is a
 * rejection, never an approval.
 *
 * @param {string} code
 * @returns {string}
 */
export function coerceReasonCode(code) {
  return isReasonCode(code) ? code : REASON_CODE.INTERNAL_ERROR;
}