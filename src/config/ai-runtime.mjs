/**
 * Single-mode AI runtime configuration (UAI-05A/05C, architecture §5,
 * ADR-005 rev 2).
 *
 * In legacy mode this module is inert: `AI_RUNTIME_MODE` absent or `legacy`
 * returns `{ mode: 'legacy' }` and no other variable is read, which keeps the
 * existing behaviour byte-compatible.
 *
 * In single mode the manifest is the sole identity authority. Provider, model
 * and endpoint may not come from the environment, and every legacy identity
 * variable is a hard conflict — even when it happens to hold the same value,
 * because two equal-looking authorities still drift independently. The API key
 * remains a separate local secret and is never stored in this config object.
 *
 * @module config/ai-runtime
 */
import path from 'node:path';
import { ConfigError } from './config-error.mjs';
import { IDENTIFIER_PATTERN } from './ai-identity-manifest.mjs';

/** Runtime modes. `legacy` is the unchanged pre-v1.1 behaviour. */
export const AI_RUNTIME_MODE = Object.freeze({
  LEGACY: 'legacy',
  SINGLE: 'single',
});

export const AI_RUNTIME_MODES = Object.freeze(Object.values(AI_RUNTIME_MODE));

/**
 * Environment variables that would create a second identity authority. A
 * non-empty value in single mode is a configuration error.
 */
export const CONFLICTING_IDENTITY_ENV = Object.freeze([
  'AI_PROVIDER',
  'AI_MODEL',
  'AI_BASE_URL',
  'AI_GUARD_MODEL',
  'AI_REFLECT_MODEL',
  'SCOUT_PROVIDER',
  'GUARD_PROVIDER',
  'SCOUT_BASE_URL',
  'GUARD_BASE_URL',
  'SCOUT_MODEL',
  'GUARD_MODEL',
  'SCOUT_API_KEY',
  'GUARD_API_KEY',
  'KIMI_API_KEY',
  'SCOUT_REASONING_EFFORT',
  'GUARD_REASONING_EFFORT',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isAbsent(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * @typedef {object} SingleModeConfig
 * @property {'single'} mode
 * @property {string} controlDir absolute path
 * @property {string} deploymentId
 * @property {string | null} slot participant slot, null for an observer
 * @property {string} expectedManifestVersion
 * @property {string} expectedManifestSha256
 * @property {string | null} artifactSha256
 * @property {boolean} hasApiKey whether a local secret is present (value never retained)
 */

/**
 * Load and strictly validate the AI runtime configuration.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ mode: 'legacy' } | SingleModeConfig}
 * @throws {ConfigError}
 */
export function loadAIRuntimeConfig(env = process.env) {
  const rawMode = isAbsent(env.AI_RUNTIME_MODE) ? AI_RUNTIME_MODE.LEGACY : String(env.AI_RUNTIME_MODE).trim().toLowerCase();
  if (!AI_RUNTIME_MODES.includes(rawMode)) {
    throw new ConfigError(`AI_RUNTIME_MODE must be one of: ${AI_RUNTIME_MODES.join(', ')}`, {
      field: 'AI_RUNTIME_MODE',
    });
  }
  if (rawMode === AI_RUNTIME_MODE.LEGACY) return Object.freeze({ mode: AI_RUNTIME_MODE.LEGACY });

  const conflicts = CONFLICTING_IDENTITY_ENV.filter((name) => !isAbsent(env[name]));
  if (conflicts.length > 0) {
    throw new ConfigError(
      `single mode takes provider identity exclusively from the approved manifest; these variables must be unset: ${conflicts.join(', ')}`,
      { field: conflicts[0], conflicts },
    );
  }

  const controlDir = isAbsent(env.AI_CONTROL_DIR) ? '' : String(env.AI_CONTROL_DIR);
  if (controlDir === '' || !path.isAbsolute(controlDir)) {
    throw new ConfigError('AI_CONTROL_DIR is required in single mode and must be an absolute path', {
      field: 'AI_CONTROL_DIR',
    });
  }
  const deploymentId = isAbsent(env.AI_DEPLOYMENT_ID) ? '' : String(env.AI_DEPLOYMENT_ID).trim();
  if (!UUID_PATTERN.test(deploymentId)) {
    throw new ConfigError('AI_DEPLOYMENT_ID is required in single mode and must be a lowercase UUID', {
      field: 'AI_DEPLOYMENT_ID',
    });
  }
  const expectedManifestVersion = isAbsent(env.AI_EXPECTED_MANIFEST_VERSION)
    ? ''
    : String(env.AI_EXPECTED_MANIFEST_VERSION).trim();
  if (!IDENTIFIER_PATTERN.test(expectedManifestVersion)) {
    throw new ConfigError('AI_EXPECTED_MANIFEST_VERSION is required in single mode and must be a valid identifier', {
      field: 'AI_EXPECTED_MANIFEST_VERSION',
    });
  }
  const expectedManifestSha256 = isAbsent(env.AI_EXPECTED_MANIFEST_SHA256)
    ? ''
    : String(env.AI_EXPECTED_MANIFEST_SHA256).trim().toLowerCase();
  if (!DIGEST_PATTERN.test(expectedManifestSha256)) {
    throw new ConfigError('AI_EXPECTED_MANIFEST_SHA256 is required in single mode and must be a SHA-256 digest', {
      field: 'AI_EXPECTED_MANIFEST_SHA256',
    });
  }

  const rawSlot = isAbsent(env.AI_PARTICIPANT_SLOT) ? null : String(env.AI_PARTICIPANT_SLOT).trim();
  if (rawSlot !== null && !IDENTIFIER_PATTERN.test(rawSlot)) {
    throw new ConfigError('AI_PARTICIPANT_SLOT must be a valid slot identifier when set', {
      field: 'AI_PARTICIPANT_SLOT',
    });
  }
  const rawArtifact = isAbsent(env.AI_ARTIFACT_SHA256) ? null : String(env.AI_ARTIFACT_SHA256).trim().toLowerCase();
  if (rawArtifact !== null && !DIGEST_PATTERN.test(rawArtifact)) {
    throw new ConfigError('AI_ARTIFACT_SHA256 must be a SHA-256 digest when set', { field: 'AI_ARTIFACT_SHA256' });
  }
  if (rawSlot !== null && rawArtifact === null) {
    throw new ConfigError('AI_ARTIFACT_SHA256 is required for a participant slot in single mode', {
      field: 'AI_ARTIFACT_SHA256',
    });
  }
  const hasApiKey = !isAbsent(env.AI_API_KEY) || !isAbsent(env.DEEPSEEK_API_KEY);
  // A key is NOT required here: a disabled observer and an injected fake
  // transport must both be able to start. The real provider factory fails
  // closed when inference is actually constructed without a secret.

  return Object.freeze({
    mode: AI_RUNTIME_MODE.SINGLE,
    controlDir: path.resolve(controlDir),
    deploymentId,
    slot: rawSlot,
    expectedManifestVersion,
    expectedManifestSha256,
    artifactSha256: rawArtifact,
    hasApiKey,
  });
}

/**
 * Redacted configuration summary. Safe to log, print in a release report or put
 * in an ack: no key material, no environment dump.
 *
 * @param {ReturnType<typeof loadAIRuntimeConfig>} config
 * @returns {Readonly<object>}
 */
export function describeAIRuntimeConfig(config) {
  if (config.mode === AI_RUNTIME_MODE.LEGACY) {
    return Object.freeze({ mode: AI_RUNTIME_MODE.LEGACY, identityValidated: false, inferenceEnabled: false });
  }
  return Object.freeze({
    mode: config.mode,
    controlDir: config.controlDir,
    deploymentId: config.deploymentId,
    slot: config.slot,
    expectedManifestVersion: config.expectedManifestVersion,
    expectedManifestSha256: config.expectedManifestSha256,
    artifactSha256: config.artifactSha256,
    hasApiKey: config.hasApiKey,
  });
}

/**
 * @param {unknown} config
 * @returns {config is SingleModeConfig}
 */
export function isSingleModeConfig(config) {
  return Boolean(config) && /** @type {any} */ (config).mode === AI_RUNTIME_MODE.SINGLE;
}

/**
 * Read the local secret. This is the only place single mode reads a key, and
 * the caller is responsible for not serialising it into manifests, acks,
 * evidence, audit lines or reports.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 * @throws {ConfigError} when no key is present
 */
export function loadSingleModeApiKey(env = process.env) {
  const key = isAbsent(env.AI_API_KEY) ? env.DEEPSEEK_API_KEY : env.AI_API_KEY;
  if (isAbsent(key)) {
    throw new ConfigError('AI_API_KEY is required to enable real inference', { field: 'AI_API_KEY' });
  }
  return String(key);
}
