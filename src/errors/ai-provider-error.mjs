/**
 * AIProviderError — the AI/model-provider failure member of the §22 taxonomy.
 *
 * It is split out of `taxonomy.mjs` so the AI layer has one obvious place to
 * import from, and so the coarse failure `kind` can grow without touching the
 * core taxonomy. The class itself is the SAME object `taxonomy.mjs` re-exports:
 * there must be exactly one `AIProviderError`, or an `instanceof` check at a
 * caller would silently fail closed on the wrong copy.
 *
 * A provider failure is retryable by DEFAULT (transport, timeout, 5xx), because
 * asking a model again is safe: it is read-only analysis that never reaches an
 * order path. Callers may still pass `retryable: false` for a failure they
 * know is permanent (for example a malformed response that cannot improve).
 *
 * @module errors/ai-provider-error
 */
import { AppError } from './app-error.mjs';

/** Stable code for the AI provider failure domain. */
export const AI_PROVIDER_ERROR_CODE = 'AI_PROVIDER_ERROR';

/** Coarse, machine-readable reasons a provider attempt can fail. */
export const AI_PROVIDER_ERROR_KIND = Object.freeze({
  /** Transport failure before any HTTP status was seen. */
  TRANSPORT: 'TRANSPORT',
  /** Request timed out. */
  TIMEOUT: 'TIMEOUT',
  /** Credentials were rejected. */
  AUTHENTICATION: 'AUTHENTICATION',
  /** The provider throttled the request. */
  RATE_LIMIT: 'RATE_LIMIT',
  /** The provider answered, but the answer was unusable. */
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  /** Anything not otherwise classified. */
  UNKNOWN: 'UNKNOWN',
});

const KINDS = Object.freeze(Object.values(AI_PROVIDER_ERROR_KIND));

/**
 * @typedef {object} AIProviderErrorOptions
 * @property {string} [code] override the stable code
 * @property {boolean} [retryable] whether a blind retry is ever safe
 * @property {string} [kind] one of AI_PROVIDER_ERROR_KIND
 * @property {Record<string, unknown>} [details] structured, non-secret context
 * @property {unknown} [cause] original error, preserved for diagnosis
 */

export class AIProviderError extends AppError {
  /**
   * @param {string} message human-readable explanation
   * @param {AIProviderErrorOptions} [options]
   */
  constructor(message, options = {}) {
    super(message, { code: AI_PROVIDER_ERROR_CODE, retryable: true, ...options });
    const requested = options.kind;
    /** @type {string} */
    this.kind = typeof requested === 'string' && KINDS.includes(requested)
      ? requested
      : AI_PROVIDER_ERROR_KIND.UNKNOWN;
  }

  /** @override */
  toJSON() {
    return { ...super.toJSON(), kind: this.kind };
  }
}

/**
 * True for the AI provider error defined here. Fail closed: any other value is
 * not an `AIProviderError`.
 *
 * @param {unknown} error
 * @returns {error is AIProviderError}
 */
export function isAIProviderError(error) {
  return error instanceof AIProviderError;
}
