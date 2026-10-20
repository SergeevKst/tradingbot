/**
 * Explicit configuration schema (MASTER_SPEC §19).
 *
 * The running configuration is not one anonymous bag: it composes named
 * sub-configurations, and each is validated at startup. `assertRuntimeConfig`
 * is the fail-closed check — invalid configuration refuses to start rather than
 * trading with a partial or silently-defaulted value.
 *
 * Nothing here reads `process.env`. `loadConfig` resolves the environment into
 * values; this module validates a composed object so the same check can be run
 * on a hand-built or test configuration.
 *
 * @module config/schema
 */
import { ConfigError } from './config-error.mjs';
import { AI_PROVIDERS } from './ai.mjs';
import { LOG_LEVEL } from './env.mjs';
import { TRADING_MODE, isTradingMode } from './trading-mode.mjs';
import { validateRiskLimits } from './risk.mjs';

/**
 * @typedef {object} ExchangeConfig
 * @property {boolean} testnet
 * @property {string} baseUrl
 * @property {string} [category] market category, e.g. "linear"
 */

/**
 * @typedef {object} TradingConfig
 * @property {'BACKTEST' | 'PAPER' | 'TESTNET' | 'LIVE'} mode
 * @property {boolean} offlineMode
 * @property {boolean} liveTradingAllowed
 */

/**
 * @typedef {import('./risk.mjs').RiskLimits} RiskConfig
 */

/**
 * @typedef {object} StrategyConfig
 * @property {string | null} defaultStrategyId
 * @property {Readonly<Record<string, number>>} parameters
 */

/**
 * @typedef {object} AIConfig
 * @property {boolean} enabled disabled by default
 * @property {'deepseek' | 'mock'} [provider]
 * @property {string} [model] concrete model id, from configuration
 * @property {string} [baseUrl] provider API base URL
 * @property {number} [timeoutMs] request timeout in milliseconds
 */

/**
 * @typedef {object} LoggingConfig
 * @property {'SILENT' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'} level
 */

/**
 * @typedef {object} RuntimeConfig
 * @property {ExchangeConfig} exchange
 * @property {TradingConfig} trading
 * @property {RiskConfig} risk
 * @property {StrategyConfig} strategy
 * @property {AIConfig} ai
 * @property {LoggingConfig} logging
 */

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {Record<string, unknown>}
 * @throws {ConfigError}
 */
function requireObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`RuntimeConfig.${field} must be an object`, { field, value });
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {boolean}
 * @throws {ConfigError}
 */
function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new ConfigError(`RuntimeConfig.${field} must be a boolean, got ${JSON.stringify(value)}`, { field, value });
  }
  return value;
}

/**
 * Validate a composed runtime configuration. Throws on the first violation.
 *
 * @param {unknown} config
 * @returns {RuntimeConfig}
 * @throws {ConfigError}
 */
export function assertRuntimeConfig(config) {
  const root = requireObject(config, 'config');

  const exchange = requireObject(root.exchange, 'exchange');
  requireBoolean(exchange.testnet, 'exchange.testnet');
  if (typeof exchange.baseUrl !== 'string' || exchange.baseUrl.trim() === '') {
    throw new ConfigError('RuntimeConfig.exchange.baseUrl must be a non-empty string', {
      field: 'exchange.baseUrl',
      value: exchange.baseUrl,
    });
  }

  const trading = requireObject(root.trading, 'trading');
  if (!isTradingMode(trading.mode)) {
    throw new ConfigError(`RuntimeConfig.trading.mode must be a valid trading mode, got ${JSON.stringify(trading.mode)}`, {
      field: 'trading.mode',
      value: trading.mode,
    });
  }
  if (trading.mode === TRADING_MODE.LIVE) {
    throw new ConfigError('RuntimeConfig.trading.mode LIVE is not supported: no live execution path exists', {
      field: 'trading.mode',
      value: trading.mode,
    });
  }
  requireBoolean(trading.offlineMode, 'trading.offlineMode');
  requireBoolean(trading.liveTradingAllowed, 'trading.liveTradingAllowed');

  const risk = requireObject(root.risk, 'risk');
  validateRiskLimits(/** @type {import('./risk.mjs').RiskLimits} */ (/** @type {unknown} */ (risk)));

  const strategy = requireObject(root.strategy, 'strategy');
  if (strategy.defaultStrategyId !== null && typeof strategy.defaultStrategyId !== 'string') {
    throw new ConfigError('RuntimeConfig.strategy.defaultStrategyId must be a string or null', {
      field: 'strategy.defaultStrategyId',
      value: strategy.defaultStrategyId,
    });
  }
  const parameters = requireObject(strategy.parameters, 'strategy.parameters');
  for (const [name, value] of Object.entries(parameters)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ConfigError(`RuntimeConfig.strategy.parameters.${name} must be a finite number`, {
        field: `strategy.parameters.${name}`,
        value,
      });
    }
  }

  const ai = requireObject(root.ai, 'ai');
  requireBoolean(ai.enabled, 'ai.enabled');
  // The remaining AI fields are optional here so an existing minimal
  // `{ enabled: false }` configuration stays valid; when present they must be
  // well formed, and `loadAIConfig` supplies the defaults.
  if (ai.provider !== undefined && !AI_PROVIDERS.includes(/** @type {any} */ (ai.provider))) {
    throw new ConfigError(`RuntimeConfig.ai.provider must be one of: ${AI_PROVIDERS.join(', ')}`, {
      field: 'ai.provider',
      value: ai.provider,
    });
  }
  if (ai.model !== undefined && (typeof ai.model !== 'string' || ai.model.trim() === '')) {
    throw new ConfigError('RuntimeConfig.ai.model must be a non-empty string', { field: 'ai.model', value: ai.model });
  }
  if (ai.baseUrl !== undefined && (typeof ai.baseUrl !== 'string' || ai.baseUrl.trim() === '')) {
    throw new ConfigError('RuntimeConfig.ai.baseUrl must be a non-empty string', {
      field: 'ai.baseUrl',
      value: ai.baseUrl,
    });
  }
  if (ai.timeoutMs !== undefined && (typeof ai.timeoutMs !== 'number' || !Number.isFinite(ai.timeoutMs) || ai.timeoutMs <= 0)) {
    throw new ConfigError('RuntimeConfig.ai.timeoutMs must be a positive finite number', {
      field: 'ai.timeoutMs',
      value: ai.timeoutMs,
    });
  }

  const logging = requireObject(root.logging, 'logging');
  if (!Object.values(LOG_LEVEL).includes(/** @type {any} */ (logging.level))) {
    throw new ConfigError(
      `RuntimeConfig.logging.level must be one of: ${Object.values(LOG_LEVEL).join(', ')} — got ${JSON.stringify(logging.level)}`,
      { field: 'logging.level', value: logging.level },
    );
  }

  return /** @type {RuntimeConfig} */ (config);
}
