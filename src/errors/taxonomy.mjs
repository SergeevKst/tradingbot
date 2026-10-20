/**
 * The classified error taxonomy (MASTER_SPEC §22).
 *
 * One class per failure domain, each with a fixed `code` and an explicit
 * `retryable` default:
 *
 *   ValidationError      malformed domain input            not retryable
 *   ConfigurationError   invalid/absent configuration       not retryable
 *   ExchangeError        exchange accepted then refused     not retryable
 *   NetworkError         transport/timeout                  RETRYABLE
 *   AuthenticationError  bad or missing credentials         not retryable
 *   RateLimitError       throttled by the exchange          RETRYABLE
 *   OrderError           order was not placed/modified      not retryable (non-idempotent)
 *   RiskError            risk evaluation could not run      not retryable
 *   AIProviderError      model provider failure             RETRYABLE
 *   DataError            market/feature data is unusable    not retryable
 *   ReconciliationError  local and exchange state disagree  not retryable
 *
 * "Non-idempotent operations must not be blindly retried" (§22) is why
 * OrderError defaults to non-retryable even though it may describe a transient
 * exchange hiccup: replaying a create-order is a new trade, not a retry.
 *
 * @module errors/taxonomy
 */
import { AppError } from './app-error.mjs';
import { AI_PROVIDER_ERROR_CODE, AIProviderError } from './ai-provider-error.mjs';

/** Stable codes for every error class. */
export const ERROR_CODE = Object.freeze({
  VALIDATION: 'VALIDATION_ERROR',
  CONFIGURATION: 'CONFIGURATION_ERROR',
  EXCHANGE: 'EXCHANGE_ERROR',
  NETWORK: 'NETWORK_ERROR',
  AUTHENTICATION: 'AUTHENTICATION_ERROR',
  RATE_LIMIT: 'RATE_LIMIT_ERROR',
  ORDER: 'ORDER_ERROR',
  RISK: 'RISK_ERROR',
  AI_PROVIDER: AI_PROVIDER_ERROR_CODE,
  DATA: 'DATA_ERROR',
  RECONCILIATION: 'RECONCILIATION_ERROR',
});

/** Re-exported so `errors/taxonomy` stays the single taxonomy entry point. */
export { AIProviderError };

export class ValidationError extends AppError {
  /** @param {string} message @param {import('./app-error.mjs').AppErrorOptions} [options] */
  constructor(message, options = {}) {
    super(message, { code: ERROR_CODE.VALIDATION, retryable: false, ...options });
  }
}

export class ConfigurationError extends AppError {
  /** @param {string} message @param {import('./app-error.mjs').AppErrorOptions} [options] */
  constructor(message, options = {}) {
    super(message, { code: ERROR_CODE.CONFIGURATION, retryable: false, ...options });
  }
}

export class ExchangeError extends AppError {
  /** @param {string} message @param {import('./app-error.mjs').AppErrorOptions} [options] */
  constructor(message, options = {}) {
    super(message, { code: ERROR_CODE.EXCHANGE, retryable: false, ...options });
  }
}

export class NetworkError extends AppError {
  /** @param {string} message @param {import('./app-error.mjs').AppErrorOptions} [options] */
  constructor(message, options = {}) {
    super(message, { code: ERROR_CODE.NETWORK, retryable: true, ...options });
  }
}

export class AuthenticationError extends AppError {
  /** @param {string} message @param {import('./app-error.mjs').AppErrorOptions} [options] */
  constructor(message, options = {}) {
    super(message, { code: ERROR_CODE.AUTHENTICATION, retryable: false, ...options });
  }
}

export class RateLimitError extends AppError {
  /** @param {string} message @param {import('./app-error.mjs').AppErrorOptions} [options] */
  constructor(message, options = {}) {
    super(message, { code: ERROR_CODE.RATE_LIMIT, retryable: true, ...options });
  }
}

export class OrderError extends AppError {
  /** @param {string} message @param {import('./app-error.mjs').AppErrorOptions} [options] */
  constructor(message, options = {}) {
    super(message, { code: ERROR_CODE.ORDER, retryable: false, ...options });
  }
}

export class RiskError extends AppError {
  /** @param {string} message @param {import('./app-error.mjs').AppErrorOptions} [options] */
  constructor(message, options = {}) {
    super(message, { code: ERROR_CODE.RISK, retryable: false, ...options });
  }
}

export class DataError extends AppError {
  /** @param {string} message @param {import('./app-error.mjs').AppErrorOptions} [options] */
  constructor(message, options = {}) {
    super(message, { code: ERROR_CODE.DATA, retryable: false, ...options });
  }
}

export class ReconciliationError extends AppError {
  /** @param {string} message @param {import('./app-error.mjs').AppErrorOptions} [options] */
  constructor(message, options = {}) {
    super(message, { code: ERROR_CODE.RECONCILIATION, retryable: false, ...options });
  }
}

/**
 * Decide whether an error may be retried by the retry policy.
 *
 * Fail closed: an unknown error is NOT retryable.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryable(error) {
  return error instanceof AppError && error.retryable === true;
}
