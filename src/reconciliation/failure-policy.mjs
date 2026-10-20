/**
 * Submission failure policy (MASTER_SPEC §13, §22, §14).
 *
 * "Never assume that a failed network request means an order was not created."
 * So the only question this module answers is *what a failure lets us conclude*:
 *
 *   REFUSED    the exchange (or validation) said no — no order exists. The key
 *              can be safely released and the intent retried.
 *   AMBIGUOUS  the request may or may not have been applied (timeout, transport
 *              error, 5xx, rate limit). NEVER resubmit; reconcile by key.
 *   RETRYABLE  a read-only operation that is safe to retry directly.
 *
 * Unknown errors default to AMBIGUOUS: fail closed, reconcile, never guess.
 *
 * @module reconciliation/failure-policy
 */
import { ERROR_CODE } from '../errors/taxonomy.mjs';
import { isAppError } from '../errors/app-error.mjs';

export const FAILURE_DECISION = Object.freeze({
  REFUSED: 'REFUSED',
  AMBIGUOUS: 'AMBIGUOUS',
  RETRYABLE: 'RETRYABLE',
});

/**
 * Classify an error thrown while submitting an order.
 *
 * @param {unknown} error
 * @returns {Readonly<{ decision: string, code: string, retryable: boolean, message: string }>}
 */
export function classifySubmissionFailure(error) {
  const code = isAppError(error) ? error.code : 'UNKNOWN_ERROR';
  const message = error instanceof Error ? error.message : String(error);

  switch (code) {
    case ERROR_CODE.ORDER:
    case ERROR_CODE.EXCHANGE:
    case ERROR_CODE.VALIDATION:
    case ERROR_CODE.CONFIGURATION:
    case ERROR_CODE.AUTHENTICATION:
      // The exchange explicitly refused, or the request never left the process.
      return freeze(FAILURE_DECISION.REFUSED, code, false, message);
    case ERROR_CODE.NETWORK:
    case ERROR_CODE.RATE_LIMIT:
    case ERROR_CODE.DATA:
      // A transport/timeout/throttle/malformed response tells us nothing about
      // whether the order landed.
      return freeze(FAILURE_DECISION.AMBIGUOUS, code, true, message);
    default:
      return freeze(FAILURE_DECISION.AMBIGUOUS, code, false, message);
  }
}

/**
 * Classify an error thrown while *reading* order state. Reads are idempotent, so
 * a transport/latency failure is safe to retry directly.
 *
 * @param {unknown} error
 * @returns {Readonly<{ decision: string, code: string, retryable: boolean, message: string }>}
 */
export function classifyReadFailure(error) {
  const code = isAppError(error) ? error.code : 'UNKNOWN_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  if (code === ERROR_CODE.NETWORK || code === ERROR_CODE.RATE_LIMIT) {
    return freeze(FAILURE_DECISION.RETRYABLE, code, true, message);
  }
  return freeze(FAILURE_DECISION.REFUSED, code, false, message);
}

/**
 * @param {string} decision
 * @param {string} code
 * @param {boolean} retryable
 * @param {string} message
 */
function freeze(decision, code, retryable, message) {
  return Object.freeze({ decision, code, retryable, message });
}
