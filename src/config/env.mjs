/**
 * Environment + configuration entry point.
 *
 * This is the ONLY module in the project allowed to read `process.env`.
 * Everything else receives an already-validated configuration object, which
 * keeps configuration decisions in one reviewable place and makes the trading
 * core trivially testable with an injected environment.
 *
 * Credential isolation (Stage 2 requirement)
 * ------------------------------------------
 * `loadConfig()` — used by the trading core — reads NO exchange credentials at
 * all. It cannot leak what it never touches, and PAPER mode runs without any
 * `BYBIT_API_KEY` / `BYBIT_API_SECRET` being present. Credentials are reachable
 * only through `loadExchangeCredentials()`, which is intended for the
 * standalone operational scripts and is never called on the trading path.
 *
 * @module config/env
 */
import { ConfigError } from './config-error.mjs';
import { isAbsent, parseBoolean, parseEnum } from './parse.mjs';
import { TRADING_MODE, isOfflineMode, isTestnetFamilyMode, resolveTradingMode } from './trading-mode.mjs';
import { loadRiskLimits } from './risk.mjs';
import { loadPaperConfig } from './paper.mjs';

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
 * @property {import('./paper.mjs').PaperConfig & { market: import('./paper.mjs').MarketConfig }} paper
 * @property {string} logLevel
 * @property {{ hasApiKey: boolean, hasApiSecret: boolean }} credentials presence only
 */

/**
 * Load and validate the application configuration.
 *
 * Deliberately never reads BYBIT_API_KEY / BYBIT_API_SECRET: the trading core
 * has no business knowing them. `credentials` is reported as `false/false` for
 * information only, so callers cannot use `loadConfig` as a credential probe.
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

  // A LIVE configuration is refused outright in Stages 1-2. Two independent
  // reasons, both explicit: the execution layer does not exist, and a
  // live-intended run that silently degraded to simulation would be worse
  // than one that refuses to start.
  if (tradingMode === TRADING_MODE.LIVE) {
    if (!liveTradingAllowed) {
      throw new ConfigError(
        'TRADING_MODE=LIVE requires ALLOW_LIVE_TRADING=true. Live execution is not implemented.',
        { field: 'ALLOW_LIVE_TRADING', value: env.ALLOW_LIVE_TRADING },
      );
    }
    throw new ConfigError(
      'TRADING_MODE=LIVE is not supported: no live execution path exists. Use PAPER or BACKTEST.',
      { field: 'TRADING_MODE', value: tradingMode },
    );
  }

  // TESTNET_ONCE is a testnet mode, so it can never be combined with the LIVE
  // opt-in: a configuration that claims both is contradictory and is refused
  // rather than resolved in either direction.
  if (tradingMode === TRADING_MODE.TESTNET_ONCE && liveTradingAllowed) {
    throw new ConfigError(
      'TRADING_MODE=TESTNET_ONCE is a testnet mode and cannot be combined with ALLOW_LIVE_TRADING=true. Refusing an ambiguous live/testnet configuration.',
      { field: 'ALLOW_LIVE_TRADING', value: env.ALLOW_LIVE_TRADING },
    );
  }

  // Fail closed on an ambiguous TESTNET/TESTNET_ONCE configuration. Both are
  // pinned to the testnet host; a run that asked for either while the host
  // resolved to mainnet must abort rather than silently fall back to production.
  if (isTestnetFamilyMode(tradingMode) && !testnet) {
    throw new ConfigError(
      `TRADING_MODE=${tradingMode} requires BYBIT_TESTNET=true so the exchange host is api-testnet.bybit.com. Refusing to fall back to production.`,
      { field: 'BYBIT_TESTNET', value: env.BYBIT_TESTNET },
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
    paper: loadPaperConfig(env),
    logLevel,
    // Always false by design: the core does not read credentials.
    credentials: Object.freeze({ hasApiKey: false, hasApiSecret: false }),
  };

  return Object.freeze(config);
}

/**
 * Read exchange credentials.
 *
 * The ONLY credential accessor in the project. Used by standalone operational
 * scripts (`scripts/`); the trading core never imports or calls it, and PAPER
 * mode runs entirely without keys.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ apiKey: string, apiSecret: string }}
 * @throws {ConfigError} when either credential is missing
 */
export function loadExchangeCredentials(env = process.env) {
  if (isAbsent(env.BYBIT_API_KEY) || isAbsent(env.BYBIT_API_SECRET)) {
    throw new ConfigError('Exchange credentials are required for this operation but were not provided', {
      field: 'BYBIT_API_KEY/BYBIT_API_SECRET',
    });
  }
  return { apiKey: env.BYBIT_API_KEY, apiSecret: env.BYBIT_API_SECRET };
}

/**
 * A safe, log-ready description of the configuration.
 *
 * Contains no secret material whatsoever, and reports no credential state
 * because the core cannot observe it.
 *
 * @param {Readonly<AppConfig>} config
 */
export function describeConfig(config) {
  return {
    tradingMode: config.tradingMode,
    offlineMode: config.offlineMode,
    testnet: config.testnet,
    logLevel: config.logLevel,
    risk: { ...config.risk },
    paper: { ...config.paper },
  };
}