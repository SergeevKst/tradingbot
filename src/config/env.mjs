/**
 * Environment + configuration entry point.
 *
 * This is the ONLY module in the project allowed to read `process.env`.
 * Everything else receives an already-validated configuration object, which
 * keeps configuration decisions in one reviewable place and makes the trading
 * core trivially testable with an injected environment.
 *
 * Secrets are read here and held behind an explicit accessor. They are never
 * logged: `describeConfig()` intentionally omits every credential and reports
 * presence as a boolean instead.
 *
 * @module config/env
 */
import { ConfigError } from './config-error.mjs';
import { parseBoolean, parseEnum } from './parse.mjs';
import { isAbsent } from './parse.mjs';
import { TRADING_MODE, isOfflineMode, resolveTradingMode } from './trading-mode.mjs';
import { loadRiskLimits } from './risk.mjs';

/** Log verbosity levels, ordered from most to least severe. */
export const LOG_LEVEL = Object.freeze({
  SILENT: 'SILENT',
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
});

/** Known Bybit API hosts. Not configurable: an unknown host is a red flag. */
const BYBIT_HOSTS = Object.freeze({
  MAINNET: 'https://api.bybit.com',
  TESTNET: 'https://api-testnet.bybit.com',
});

/**
 * @typedef {object} AppConfig
 * @property {import('./trading-mode.mjs').TradingModeName} tradingMode
 * @property {boolean} offlineMode true when the mode must not touch the exchange
 * @property {boolean} liveTradingAllowed explicit human opt-in for LIVE
 * @property {boolean} testnet
 * @property {string} bybitBaseUrl
 * @property {import('./risk.mjs').RiskLimits} risk
 * @property {string} logLevel
 * @property {{ hasApiKey: boolean, hasApiSecret: boolean }} credentials presence only
 */

/**
 * Load and validate the application configuration.
 *
 * @param {Record<string, string | undefined>} [env] environment source (defaults to process.env)
 * @returns {Readonly<AppConfig>}
 * @throws {ConfigError} on any invalid or inconsistent value
 */
export function loadConfig(env = process.env) {
  const tradingMode = resolveTradingMode(env.TRADING_MODE);

  const testnet = parseBoolean(env.BYBIT_TESTNET, { field: 'BYBIT_TESTNET', fallback: false });
  const liveTradingAllowed = parseBoolean(env.ALLOW_LIVE_TRADING, {
    field: 'ALLOW_LIVE_TRADING',
    fallback: false,
  });

  const logLevel = parseEnum(env.LOG_LEVEL, {
    field: 'LOG_LEVEL',
    allowed: Object.values(LOG_LEVEL),
    fallback: LOG_LEVEL.INFO,
    uppercase: true,
  });

  // A LIVE configuration is refused outright in Stage 1. Two independent
  // reasons, both explicit: the execution layer does not exist, and a
  // live-intended run that silently degraded to simulation would be worse
  // than one that refuses to start.
  if (tradingMode === TRADING_MODE.LIVE) {
    if (!liveTradingAllowed) {
      throw new ConfigError(
        'TRADING_MODE=LIVE requires ALLOW_LIVE_TRADING=true. Live execution is not implemented in Stage 1.',
        { field: 'ALLOW_LIVE_TRADING', value: env.ALLOW_LIVE_TRADING },
      );
    }
    throw new ConfigError(
      'TRADING_MODE=LIVE is not supported in Stage 1: no live execution path exists. Use PAPER or BACKTEST.',
      { field: 'TRADING_MODE', value: tradingMode },
    );
  }

  const hasApiKey = !isAbsent(env.BYBIT_API_KEY);
  const hasApiSecret = !isAbsent(env.BYBIT_API_SECRET);

  // Credentials are optional in offline modes and required only later, but a
  // half-configured pair is always a mistake worth failing on.
  if (hasApiKey !== hasApiSecret) {
    throw new ConfigError(
      'Incomplete Bybit credentials: BYBIT_API_KEY and BYBIT_API_SECRET must be provided together',
      { field: hasApiKey ? 'BYBIT_API_SECRET' : 'BYBIT_API_KEY' },
    );
  }

  /** @type {AppConfig} */
  const config = {
    tradingMode,
    offlineMode: isOfflineMode(tradingMode),
    liveTradingAllowed,
    testnet,
    bybitBaseUrl: testnet ? BYBIT_HOSTS.TESTNET : BYBIT_HOSTS.MAINNET,
    risk: loadRiskLimits(env),
    logLevel,
    credentials: Object.freeze({ hasApiKey, hasApiSecret }),
  };

  return Object.freeze(config);
}

/**
 * Read credentials. Kept separate from `loadConfig` so that the credential
 * values never travel inside the config object that gets logged or passed
 * around.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ apiKey: string, apiSecret: string }}
 * @throws {ConfigError} when either credential is missing
 */
export function loadCredentials(env = process.env) {
  if (isAbsent(env.BYBIT_API_KEY) || isAbsent(env.BYBIT_API_SECRET)) {
    throw new ConfigError('Bybit credentials are required for this operation but were not provided', {
      field: 'BYBIT_API_KEY/BYBIT_API_SECRET',
    });
  }
  return { apiKey: env.BYBIT_API_KEY, apiSecret: env.BYBIT_API_SECRET };
}

/**
 * A safe, log-ready description of the configuration.
 *
 * Contains no secret material whatsoever — credentials are reduced to booleans.
 *
 * @param {Readonly<AppConfig>} config
 */
export function describeConfig(config) {
  return {
    tradingMode: config.tradingMode,
    offlineMode: config.offlineMode,
    testnet: config.testnet,
    bybitBaseUrl: config.bybitBaseUrl,
    logLevel: config.logLevel,
    credentials: { ...config.credentials },
    risk: { ...config.risk },
  };
}