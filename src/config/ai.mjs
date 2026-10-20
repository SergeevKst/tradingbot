/**
 * AI configuration (MASTER_SPEC §19, §39).
 *
 * The model, provider and endpoint come from configuration, never from
 * hard-coded business logic, so DeepSeek can be replaced without rewriting the
 * application. AI is DISABLED by default.
 *
 * This module does NOT read the API key. As with exchange credentials, the key
 * is reachable only through `loadAICredentials()`, which the trading core never
 * calls; a disabled or unconfigured AI layer therefore needs no secret at all.
 *
 * @module config/ai
 */
import { ConfigError } from './config-error.mjs';
import { isAbsent, parseBoolean, parseEnum, parseNumber } from './parse.mjs';

/** Providers known to this build. */
export const AI_PROVIDER = Object.freeze({
  DEEPSEEK: 'deepseek',
  MOCK: 'mock',
});

export const AI_PROVIDERS = Object.freeze(Object.values(AI_PROVIDER));

/**
 * Conservative defaults. The endpoint is DeepSeek's public API; the model is
 * read from `AI_MODEL`, so switching models is a configuration change (§39).
 */
export const DEFAULT_AI_CONFIG = Object.freeze({
  enabled: false,
  provider: AI_PROVIDER.DEEPSEEK,
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  timeoutMs: 20000,
});

/**
 * @typedef {object} AIConfig
 * @property {boolean} enabled AI is opt-in and off by default
 * @property {'deepseek' | 'mock'} provider
 * @property {string} model concrete model id
 * @property {string} baseUrl provider API base URL
 * @property {number} timeoutMs request timeout in milliseconds
 */

/**
 * @param {unknown} raw
 * @returns {Readonly<AIConfig>}
 * @throws {ConfigError}
 */
export function validateAIConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('AIConfig must be an object', { field: 'ai' });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  if (typeof input.enabled !== 'boolean') {
    throw new ConfigError('AIConfig.enabled must be a boolean', { field: 'ai.enabled', value: input.enabled });
  }
  if (!AI_PROVIDERS.includes(/** @type {string} */ (input.provider))) {
    throw new ConfigError(`AIConfig.provider must be one of: ${AI_PROVIDERS.join(', ')}`, {
      field: 'ai.provider',
      value: input.provider,
    });
  }
  if (typeof input.model !== 'string' || input.model.trim() === '') {
    throw new ConfigError('AIConfig.model must be a non-empty string', { field: 'ai.model', value: input.model });
  }
  if (typeof input.baseUrl !== 'string' || input.baseUrl.trim() === '') {
    throw new ConfigError('AIConfig.baseUrl must be a non-empty string', { field: 'ai.baseUrl', value: input.baseUrl });
  }
  if (!Number.isFinite(input.timeoutMs) || /** @type {number} */ (input.timeoutMs) <= 0) {
    throw new ConfigError('AIConfig.timeoutMs must be a positive finite number', {
      field: 'ai.timeoutMs',
      value: input.timeoutMs,
    });
  }

  return Object.freeze({
    enabled: input.enabled,
    provider: /** @type {'deepseek' | 'mock'} */ (input.provider),
    model: input.model.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    timeoutMs: /** @type {number} */ (input.timeoutMs),
  });
}

/**
 * Resolve the AI configuration from the environment. Never reads the API key.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<AIConfig>}
 * @throws {ConfigError}
 */
export function loadAIConfig(env = process.env) {
  const model = isAbsent(env.AI_MODEL) ? DEFAULT_AI_CONFIG.model : String(env.AI_MODEL).trim();
  const baseUrl = isAbsent(env.AI_BASE_URL) ? DEFAULT_AI_CONFIG.baseUrl : String(env.AI_BASE_URL).trim();

  return validateAIConfig({
    enabled: parseBoolean(env.AI_ENABLED, { field: 'AI_ENABLED', fallback: DEFAULT_AI_CONFIG.enabled }),
    provider: parseEnum(env.AI_PROVIDER, {
      field: 'AI_PROVIDER',
      allowed: AI_PROVIDERS,
      fallback: DEFAULT_AI_CONFIG.provider,
      uppercase: true,
    }),
    model,
    baseUrl,
    timeoutMs: parseNumber(env.AI_TIMEOUT_MS, {
      field: 'AI_TIMEOUT_MS',
      fallback: DEFAULT_AI_CONFIG.timeoutMs,
      exclusiveMin: 0,
    }),
  });
}

/**
 * Read the DeepSeek API key.
 *
 * The ONLY place an AI credential is read. Used by the composition root when
 * the AI layer is explicitly enabled; tests inject a fake and the trading core
 * never calls this.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ apiKey: string }}
 * @throws {ConfigError} when the key is missing
 */
export function loadAICredentials(env = process.env) {
  if (isAbsent(env.DEEPSEEK_API_KEY)) {
    throw new ConfigError('DEEPSEEK_API_KEY is required to enable the DeepSeek AI provider', {
      field: 'DEEPSEEK_API_KEY',
    });
  }
  return { apiKey: env.DEEPSEEK_API_KEY };
}
