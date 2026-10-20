/**
 * Configuration error type.
 *
 * Every configuration problem — invalid TRADING_MODE, malformed risk limit,
 * missing credential required by the selected mode — surfaces as a ConfigError
 * so the process fails loudly at startup instead of running with a partial or
 * silently-defaulted configuration.
 *
 * It is the concrete configuration member of the §22 taxonomy: it extends
 * `ConfigurationError`, so it gains a stable `code` and a non-retryable default
 * while keeping the `field` / `value` shape every existing caller depends on.
 *
 * @module config/config-error
 */
import { ConfigurationError } from '../errors/taxonomy.mjs';

export class ConfigError extends ConfigurationError {
  /**
   * @param {string} message human-readable explanation
   * @param {{ field?: string, value?: unknown }} [details] offending field/value
   */
  constructor(message, details = {}) {
    super(message, { details: { field: details.field, value: details.value } });
    this.name = 'ConfigError';
    /** @type {string | undefined} */
    this.field = details.field;
    /** @type {unknown} */
    this.value = details.value;
  }
}