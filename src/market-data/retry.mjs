/**
 * Explicit, bounded retry policy (MASTER_SPEC §23).
 *
 * There is no `while (error) retry()`. A policy fixes the maximum attempts, the
 * exponential backoff, the jitter, and which errors may be retried. Retryability
 * is a property of the error class: `isRetryable` is true only for the taxonomy
 * classes that declare it (NetworkError, RateLimitError, AIProviderError), so a
 * non-idempotent `OrderError` is never blindly replayed.
 *
 * `sleep` and `random` are injectable so tests are deterministic and instant.
 *
 * @module market-data/retry
 */
import { ConfigurationError, isRetryable } from '../errors/taxonomy.mjs';

/**
 * @typedef {object} RetryPolicy
 * @property {number} attempts total attempts, including the first (>= 1)
 * @property {number} baseDelayMs delay before the first retry
 * @property {number} maxDelayMs cap on any single backoff delay
 * @property {number} jitter fraction of the delay applied as random jitter (0..1)
 */

/** Conservative default: three attempts, exponential backoff, 20% jitter. */
export const DEFAULT_RETRY_POLICY = Object.freeze({
  attempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
  jitter: 0.2,
});

/**
 * Validate a policy (or merge overrides onto the default).
 *
 * @param {Partial<RetryPolicy>} [overrides]
 * @returns {Readonly<RetryPolicy>}
 * @throws {ConfigurationError}
 */
export function createRetryPolicy(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new ConfigurationError('RetryPolicy must be an object', { details: { field: 'retry' } });
  }
  const policy = { ...DEFAULT_RETRY_POLICY, ...overrides };
  const { attempts, baseDelayMs, maxDelayMs, jitter } = policy;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new ConfigurationError('RetryPolicy.attempts must be an integer >= 1', {
      details: { field: 'retry.attempts', value: attempts },
    });
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new ConfigurationError('RetryPolicy.baseDelayMs must be a finite number >= 0', {
      details: { field: 'retry.baseDelayMs', value: baseDelayMs },
    });
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new ConfigurationError('RetryPolicy.maxDelayMs must be a finite number >= baseDelayMs', {
      details: { field: 'retry.maxDelayMs', value: maxDelayMs },
    });
  }
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new ConfigurationError('RetryPolicy.jitter must be a finite number in [0, 1]', {
      details: { field: 'retry.jitter', value: jitter },
    });
  }

  return Object.freeze({ attempts, baseDelayMs, maxDelayMs, jitter });
}

/**
 * @param {Readonly<RetryPolicy>} policy
 * @param {number} attempt the attempt that just failed (1-based)
 * @param {() => number} random
 * @returns {number}
 */
export function backoffDelay(policy, attempt, random) {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(policy.maxDelayMs, exponential);
  const factor = 1 + (random() * 2 - 1) * policy.jitter;
  return Math.max(0, Math.round(capped * factor));
}

/**
 * Run an operation under a retry policy.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation
 * @param {{
 *   policy?: Partial<RetryPolicy>,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   onRetry?: (info: { attempt: number, error: unknown, delayMs: number, operationName: string }) => void,
 *   operationName?: string,
 * }} [options]
 * @returns {Promise<T>}
 */
export function retry(operation, options = {}) {
  if (typeof operation !== 'function') {
    throw new ConfigurationError('retry requires an operation function');
  }
  const policy = createRetryPolicy(options.policy);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const onRetry = options.onRetry;
  const operationName = options.operationName ?? 'operation';

  if (typeof sleep !== 'function') {
    throw new ConfigurationError('retry sleep must be a function');
  }
  if (onRetry !== undefined && typeof onRetry !== 'function') {
    throw new ConfigurationError('retry onRetry must be a function');
  }

  return (async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation(attempt);
      } catch (error) {
        const canRetry = isRetryable(error) && attempt < policy.attempts;
        if (!canRetry) throw error;
        const delayMs = backoffDelay(policy, attempt, random);
        if (typeof onRetry === 'function') onRetry({ attempt, error, delayMs, operationName });
        await sleep(delayMs);
      }
    }
  })();
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
