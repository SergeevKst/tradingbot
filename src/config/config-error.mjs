/**
 * Configuration error type.
 *
 * Every configuration problem — invalid TRADING_MODE, malformed risk limit,
 * missing credential required by the selected mode — surfaces as a ConfigError
 * so the process fails loudly at startup instead of running with a partial or
 * silently-defaulted configuration.
 *
 * This module has no imports on purpose: it is the root of the config layer.
 */
export class ConfigError extends Error {
  /**
   * @param {string} message human-readable explanation
   * @param {{ field?: string, value?: unknown }} [details] offending field/value
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'ConfigError';
    /** @type {string | undefined} */
    this.field = details.field;
    /** @type {unknown} */
    this.value = details.value;
  }
}