/**
 * Testnet configuration (MASTER_SPEC Phase 8).
 *
 * Credential isolation is the whole point of this module. The authenticated
 * testnet layer uses DEDICATED variables — `BYBIT_TESTNET_API_KEY` and
 * `BYBIT_TESTNET_API_SECRET` — that are distinct from the production pair used
 * by operational scripts. There is deliberately no fallback: if the testnet
 * pair is absent the load FAILS CLOSED, so an operator holding only production
 * keys cannot accidentally sign a testnet request (or the reverse).
 *
 * Like every other config module it is testable with an injected environment.
 *
 * @module config/testnet
 */
import { ConfigError } from './config-error.mjs';
import { isAbsent, parseBoolean } from './parse.mjs';

/** The testnet REST host, mirrored from the adapter layer for config use. */
export const TESTNET_REST_BASE_URL = 'https://api-testnet.bybit.com';

/**
 * Load the dedicated testnet credentials.
 *
 * Never reads the production credential variables.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<{ apiKey: string, apiSecret: string }>}
 * @throws {ConfigError} when either testnet variable is missing
 */
export function loadTestnetCredentials(env = process.env) {
  if (isAbsent(env.BYBIT_TESTNET_API_KEY) || isAbsent(env.BYBIT_TESTNET_API_SECRET)) {
    throw new ConfigError(
      'Dedicated testnet credentials are required but were not provided. Production credentials are never used for testnet.',
      { field: 'BYBIT_TESTNET_API_KEY/BYBIT_TESTNET_API_SECRET' },
    );
  }
  return Object.freeze({ apiKey: env.BYBIT_TESTNET_API_KEY, apiSecret: env.BYBIT_TESTNET_API_SECRET });
}

/**
 * @typedef {object} TestnetConfig
 * @property {boolean} enabled explicit opt-in for authenticated testnet I/O
 * @property {true} testnet always testnet — this layer has no mainnet mode
 * @property {string} restBaseUrl always the testnet host
 * @property {string} category product category for order calls
 */

/**
 * Load the testnet configuration.
 *
 * When `TESTNET_ENABLED=true` the credentials must be present, so an enabled
 * run cannot start in a half-configured, fail-open state.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<TestnetConfig>}
 * @throws {ConfigError}
 */
export function loadTestnetConfig(env = process.env) {
  const enabled = parseBoolean(env.TESTNET_ENABLED, { field: 'TESTNET_ENABLED', fallback: false });

  if (enabled) {
    // Validate presence eagerly: an enabled testnet run without dedicated keys
    // is a configuration error, not a run that quietly does nothing.
    loadTestnetCredentials(env);
  }

  return Object.freeze({
    enabled,
    testnet: /** @type {true} */ (true),
    restBaseUrl: TESTNET_REST_BASE_URL,
    category: 'linear',
  });
}
