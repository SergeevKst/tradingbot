/**
 * AppError — the root of the project error taxonomy.
 *
 * Every error the trading core raises deliberately should carry a stable,
 * machine-readable `code` and an explicit `retryable` flag, so callers can
 * branch on behaviour instead of parsing prose (MASTER_SPEC §22).
 *
 * `retryable` is a property of the error CLASS, not of the moment: a network
 * timeout is retryable, an order rejection is not. Keeping it here stops a
 * caller from "helpfully" retrying a non-idempotent operation.
 *
 * This module imports nothing. It is the dependency root of the whole tree.
 *
 * @module errors/app-error
 */

/** Fallback code for an error that declares no more specific one. */
export const DEFAULT_ERROR_CODE = 'APP_ERROR';

/**
 * @typedef {object} AppErrorOptions
 * @property {string} [code] stable machine-readable code
 * @property {boolean} [retryable] whether a blind retry is ever safe
 * @property {Record<string, unknown>} [details] structured, non-secret context
 * @property {unknown} [cause] original error, preserved for diagnosis
 */

export class AppError extends Error {
  /**
   * @param {string} message human-readable explanation
   * @param {AppErrorOptions} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    /** @type {string} */
    this.code = options.code ?? DEFAULT_ERROR_CODE;
    /** @type {boolean} fail-closed default: never retry unless declared safe */
    this.retryable = options.retryable ?? false;
    /** @type {Readonly<Record<string, unknown>>} */
    this.details = Object.freeze({ ...(options.details ?? {}) });
    if (Error.captureStackTrace) Error.captureStackTrace(this, new.target);
  }

  /** Log-ready description. Contains no stack and no secret material. */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

/**
 * True for any error defined by this project.
 *
 * @param {unknown} error
 * @returns {error is AppError}
 */
export function isAppError(error) {
  return error instanceof AppError;
}
