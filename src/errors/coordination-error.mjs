/**
 * Coordination errors for the unified single-mode release protocol.
 *
 * These are NOT provider errors and must never be retried as if they were: a
 * missing control record, a retired generation or a mismatched artifact is a
 * fail-closed condition, and retrying it would either bypass the barrier or
 * spend a provider request under an identity the release does not authorize.
 * `retryable` is therefore always `false` (architecture §5).
 *
 * Messages never contain credentials, prompts or full environment values.
 *
 * @module errors/coordination-error
 */
import { AppError } from './app-error.mjs';
import { COORDINATION_ERROR_CODE, COORDINATION_ERROR_CODES } from '../config/ai-release-schema.mjs';

export { COORDINATION_ERROR_CODE, COORDINATION_ERROR_CODES };

/** Prefix used by every coordination code in the shared taxonomy. */
export const COORDINATION_ERROR_PREFIX = 'COORDINATION';

/**
 * @typedef {object} CoordinationErrorOptions
 * @property {string} [code]
 * @property {Record<string, unknown>} [details]
 * @property {unknown} [cause]
 */

export class CoordinationError extends AppError {
  /**
   * @param {string} message
   * @param {CoordinationErrorOptions} [options]
   */
  constructor(message, options = {}) {
    const code = options.code ?? COORDINATION_ERROR_CODE.INTERNAL_ERROR;
    if (!COORDINATION_ERROR_CODES.includes(code)) {
      throw new TypeError(`unknown coordination error code ${JSON.stringify(code)}`);
    }
    super(message, {
      code,
      retryable: false,
      details: options.details,
      cause: options.cause,
    });
  }
}

/**
 * @param {unknown} error
 * @returns {error is CoordinationError}
 */
export function isCoordinationError(error) {
  return error instanceof CoordinationError;
}

/**
 * Map any thrown value to a safe coordination code for an ack/status report.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function coordinationCodeOf(error) {
  if (error instanceof CoordinationError) return error.code;
  return COORDINATION_ERROR_CODE.INTERNAL_ERROR;
}

/**
 * Narrow helper used by call sites that must reject work rather than continue.
 *
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {CoordinationError}
 */
export function coordinationFailure(code, message, details) {
  return new CoordinationError(message, { code, details });
}
