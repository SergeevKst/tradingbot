/**
 * Codex provider configuration (config layer).
 *
 * Everything the Codex adapter needs to know about the deployment lives here:
 * the model catalog the build was reviewed against, the environment allowlist
 * for the child process, and the opt-in switch. No other module reads
 * `process.env` for this feature — the security invariant in
 * `test/security.test.mjs` ("only the config layer reads process.env") is the
 * reason, and it is a good one: a provider that reads ambient environment can
 * pick up a credential it was never meant to see.
 *
 * The child environment is rebuilt from an allowlist. `OPENAI_API_KEY`,
 * `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` and every exchange/bot/provider secret
 * are dropped, so a stray key cannot silently turn subscription inference into
 * metered API billing and the bot's secrets never reach a model process.
 *
 * @module config/codex
 */
import { ConfigError } from './config-error.mjs';
import { isAbsent, parseBoolean, parseNumber } from './parse.mjs';

/** Provider identifier used throughout the routing layer. */
export const CODEX_PROVIDER_ID = 'codex';

/** The canonical local-transport identity stored in a manifest / registry. */
export const CODEX_LOCAL_IDENTITY = 'cli://codex';

/**
 * Model slugs reported by `codex debug models` on codex-cli 0.163.0.
 * `gpt-6-astra` is Astra; `gpt-6.1-sol` is the documented cheaper workhorse
 * ("near-Astra performance at a lower cost").
 */
export const CODEX_KNOWN_MODELS = Object.freeze([
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6.1-terra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-reserve',
]);

/** Cheapest suitable model for routine, high-frequency operations. */
export const CODEX_ROUTINE_MODEL = 'gpt-6.1-sol';

/** Frontier model; only for operations explicitly configured to use it. */
export const CODEX_ASTRA_MODEL = 'gpt-6-astra';

/** Reasoning efforts the Codex CLI accepts for the reviewed models. */
export const CODEX_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high']);

/** Environment variables a Codex child may inherit. */
export const CODEX_CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'CODEX_HOME',
  'SHELL',
  'TERM',
]);

/** Names/prefixes that must never reach the child, even if allowlisted above. */
export const CODEX_CHILD_ENV_FORBIDDEN_PREFIXES = Object.freeze([
  'OPENAI_',
  'ANTHROPIC_',
  'DEEPSEEK_',
  'KIMI_',
  'MOONSHOT_',
  'OPENROUTER_',
  'BYBIT_',
  'TELEGRAM_',
  'CODEX_ACCESS_TOKEN',
  'CODEX_API_KEY',
]);

/**
 * Build the child environment from an allowlist. Pure: the caller supplies the
 * source map (the config layer passes `process.env`).
 *
 * @param {Record<string, string | undefined>} [source]
 * @returns {Record<string, string>}
 */
export function buildCodexChildEnv(source = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  if (source === null || typeof source !== 'object') return env;
  for (const key of CODEX_CHILD_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value !== 'string' || value === '') continue;
    const forbidden = CODEX_CHILD_ENV_FORBIDDEN_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix));
    if (forbidden) continue;
    env[key] = value;
  }
  return env;
}

/**
 * @typedef {object} CodexProviderConfig
 * @property {boolean} enabled opt-in; false by default
 * @property {string} command executable name or absolute path
 * @property {string} model routine model id
 * @property {readonly string[]} astraOperations operations allowed to use Astra
 * @property {number} timeoutMs per-call timeout
 * @property {number} maxCallsPerHour sliding-window call budget
 * @property {Record<string, string>} childEnv sanitized environment for the child
 */

/**
 * Load the Codex provider configuration. Disabled unless explicitly enabled.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<CodexProviderConfig>}
 */
export function loadCodexProviderConfig(env = process.env) {
  const enabled = parseBoolean(env?.AI_CODEX_ENABLED, { field: 'AI_CODEX_ENABLED', fallback: false });
  const command = isAbsent(env?.AI_CODEX_COMMAND) ? 'codex' : String(env.AI_CODEX_COMMAND).trim();
  if (command === '') {
    throw new ConfigError('AI_CODEX_COMMAND must be a non-empty executable name or path', {
      field: 'AI_CODEX_COMMAND',
      value: env?.AI_CODEX_COMMAND,
    });
  }
  if (/[\s\u0000-\u001f]/.test(command)) {
    // Deliberately stricter than spawn(argv) strictly needs: whitespace is
    // rejected along with control characters, so a configured command can never
    // smuggle extra argv bytes or a shell fragment even though the child is
    // started with `shell: false`.
    throw new ConfigError('AI_CODEX_COMMAND must not contain whitespace or control characters', {
      field: 'AI_CODEX_COMMAND',
    });
  }
  const model = isAbsent(env?.AI_CODEX_MODEL) ? CODEX_ROUTINE_MODEL : String(env.AI_CODEX_MODEL).trim();
  if (!CODEX_KNOWN_MODELS.includes(model)) {
    throw new ConfigError(`AI_CODEX_MODEL must be one of the reviewed models (${CODEX_KNOWN_MODELS.join(', ')})`, {
      field: 'AI_CODEX_MODEL',
      value: env?.AI_CODEX_MODEL,
    });
  }
  const astraOperations = isAbsent(env?.AI_CODEX_ASTRA_OPERATIONS)
    ? []
    : String(env.AI_CODEX_ASTRA_OPERATIONS)
        .split(',')
        .map((entry) => entry.trim().toUpperCase())
        .filter((entry) => entry !== '');
  for (const operation of astraOperations) {
    if (!['ANALYZE', 'SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT'].includes(operation)) {
      throw new ConfigError(`AI_CODEX_ASTRA_OPERATIONS contains an unknown operation ${JSON.stringify(operation)}`, {
        field: 'AI_CODEX_ASTRA_OPERATIONS',
        value: operation,
      });
    }
  }
  const timeoutMs = parseNumber(env?.AI_CODEX_TIMEOUT_MS, {
    field: 'AI_CODEX_TIMEOUT_MS',
    fallback: 120000,
    exclusiveMin: 0,
    integer: true,
  });
  const maxCallsPerHour = parseNumber(env?.AI_CODEX_MAX_CALLS_PER_HOUR, {
    field: 'AI_CODEX_MAX_CALLS_PER_HOUR',
    fallback: 30,
    exclusiveMin: 0,
    integer: true,
  });
  return Object.freeze({
    enabled,
    command,
    model,
    astraOperations: Object.freeze(astraOperations),
    timeoutMs,
    maxCallsPerHour,
    childEnv: Object.freeze(buildCodexChildEnv(env)),
  });
}
