/**
 * Live configuration (MASTER_SPEC Phase 10, §46).
 *
 * Live trading is the one mode that can lose real money, so its configuration
 * is deliberately separate from every other mode:
 *
 *   - activation is an explicit `LIVE_ENABLED=true` opt-in AND
 *     `TRADING_MODE=LIVE` — never inferred, never defaulted;
 *   - credentials are DEDICATED `BYBIT_LIVE_API_KEY` / `BYBIT_LIVE_API_SECRET`
 *     variables, distinct from the testnet pair and the operational pair, and
 *     the loader never falls back to either;
 *   - the host is fixed to mainnet and a testnet flag in a live configuration
 *     is refused, because mixing the two credential domains is exactly the
 *     mistake this layer exists to prevent.
 *
 * This module only *loads and validates* live configuration. It does not, and
 * must not, arm live trading: the §46 gate (`safety/live-gate.mjs`) still
 * decides readiness, and this build has no live execution path.
 *
 * Like every config module it is testable with an injected environment.
 *
 * @module config/live
 */
import { ConfigError } from './config-error.mjs';
import { isAbsent, parseBoolean } from './parse.mjs';
import { TRADING_MODE, resolveTradingMode } from './trading-mode.mjs';

/** The production REST host. Live has exactly one, and it is not configurable. */
export const LIVE_REST_BASE_URL = 'https://api.bybit.com';

/**
 * Load the live configuration.
 *
 * Reads only `LIVE_ENABLED`, `TRADING_MODE`, `BYBIT_TESTNET` and
 * `TESTNET_ENABLED`. It never reads credential values — those are behind
 * `loadLiveCredentials`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<{ enabled: boolean, mode: string, testnet: false, restBaseUrl: string, category: string }>}
 * @throws {ConfigError} when the live configuration is inconsistent
 */
export function loadLiveConfig(env = process.env) {
  const enabled = parseBoolean(env.LIVE_ENABLED, { field: 'LIVE_ENABLED', fallback: false });
  const mode = resolveTradingMode(env.TRADING_MODE);

  if (enabled && mode !== TRADING_MODE.LIVE) {
    throw new ConfigError(
      `LIVE_ENABLED=true requires TRADING_MODE=LIVE, got ${JSON.stringify(mode)}. Activation must be explicit in both places.`,
      { field: 'TRADING_MODE', value: env.TRADING_MODE },
    );
  }

  // A live run must never point at the testnet host or use testnet credentials.
  const testnetFlag = parseBoolean(env.BYBIT_TESTNET, { field: 'BYBIT_TESTNET', fallback: false });
  const testnetEnabled = parseBoolean(env.TESTNET_ENABLED, { field: 'TESTNET_ENABLED', fallback: false });
  if (enabled && (testnetFlag || testnetEnabled)) {
    throw new ConfigError(
      'LIVE refuses a testnet configuration: live and testnet are separate credential domains and must never be mixed.',
      { field: 'BYBIT_TESTNET/TESTNET_ENABLED', value: testnetFlag || testnetEnabled },
    );
  }

  return Object.freeze({
    enabled,
    mode,
    testnet: /** @type {false} */ (false),
    restBaseUrl: LIVE_REST_BASE_URL,
    category: 'linear',
  });
}

/**
 * Load the dedicated live credentials.
 *
 * The only live credential accessor. It reads `BYBIT_LIVE_API_KEY` /
 * `BYBIT_LIVE_API_SECRET` and never falls back to testnet or operational keys:
 * a missing pair is a hard error, so an operator holding only testnet keys
 * cannot accidentally sign a mainnet request.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<{ apiKey: string, apiSecret: string }>}
 * @throws {ConfigError} when either live variable is missing
 */
export function loadLiveCredentials(env = process.env) {
  if (isAbsent(env.BYBIT_LIVE_API_KEY) || isAbsent(env.BYBIT_LIVE_API_SECRET)) {
    throw new ConfigError(
      'Dedicated live credentials are required but were not provided. Testnet and operational credentials are never used for live.',
      { field: 'BYBIT_LIVE_API_KEY/BYBIT_LIVE_API_SECRET' },
    );
  }
  return Object.freeze({ apiKey: env.BYBIT_LIVE_API_KEY, apiSecret: env.BYBIT_LIVE_API_SECRET });
}
