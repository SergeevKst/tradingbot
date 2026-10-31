/**
 * Single-mode AI runtime configuration (UAI-05A/05C, architecture §5,
 * ADR-005 rev 2).
 *
 * In legacy mode this module is inert: `AI_RUNTIME_MODE` absent or `legacy`
 * returns `{ mode: 'legacy' }` and no other variable is read, which keeps the
 * existing behaviour byte-compatible. The one exception is a reviewed
 * `AI_SKILL_MODE=v2`, which is refused rather than silently downgraded to the
 * hard-coded prompts because no manifest identity exists to bind a package to.
 *
 * In single mode the manifest is the sole identity authority. Provider, model
 * and endpoint may not come from the environment, and every legacy identity
 * variable is a hard conflict — even when it happens to hold the same value,
 * because two equal-looking authorities still drift independently.
 *
 * Which variables count as an identity depends on the reviewed `AI_SKILL_MODE`:
 * under `legacy` dispatch `KIMI_API_KEY` selects a provider for REFLECT, while
 * under `v2` the provider comes from the bound model registry and the same
 * variable is a provider-scoped credential read only by `loadProviderApiKey`.
 * Secrets are never stored in this config object.
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
 * Reviewed dispatch mode of the AI operations themselves.
 *
 *   legacy — the pre-Skill prompt/completion dispatch. Allowed only as an
 *            explicit migration compatibility mode on a v1 record
 *            (architecture v1.1 §10 Phase C).
 *   v2     — every operation dispatches through its approved Skill Package and
 *            bound model identity. Requires a schemaVersion 2 joint binding.
 *
 * This is a reviewed configuration value, never inferred from a missing
 * registry, file presence or process state.
 */
export const AI_SKILL_MODE = Object.freeze({
  LEGACY: 'legacy',
  V2: 'v2',
});

export const AI_SKILL_MODES = Object.freeze(Object.values(AI_SKILL_MODE));

/**
 * Environment variables that would create a second provider, model or endpoint
 * authority. A non-empty value in single mode is a configuration error in every
 * dispatch mode: identity comes from the approved manifest and, in v2, from the
 * bound joint generation.
 *
 * `SCOUT_API_KEY` / `GUARD_API_KEY` are role-scoped aliases of the legacy prompt
 * dispatch. They are never a provider-scoped credential (`loadProviderApiKey`
 * resolves credentials by provider, not by role), so keeping one set in v2 would
 * silently point at nothing; they stay hard conflicts in both modes.
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
  'SCOUT_REASONING_EFFORT',
  'GUARD_REASONING_EFFORT',
]);

/**
 * Provider-scoped credentials the v2 transport injects (architecture §6.1).
 *
 * These name a secret, never a model or an endpoint: in v2 the provider identity
 * comes from the bound model registry, so holding one is not a competing
 * authority. `loadProviderApiKey` is the only reader and a key is never reused
 * across origins.
 */
const PROVIDER_CREDENTIALS = Object.freeze({
  deepseek: Object.freeze(['AI_API_KEY', 'DEEPSEEK_API_KEY']),
  kimi: Object.freeze(['KIMI_API_KEY']),
  openrouter: Object.freeze(['OPENROUTER_API_KEY']),
});

/** Every provider-scoped credential variable, in a stable order. */
export const PROVIDER_CREDENTIAL_ENV = Object.freeze([
  ...new Set(Object.values(PROVIDER_CREDENTIALS).flat()),
]);

/**
 * Variables that are a competing identity only while the *legacy* prompt
 * dispatch is configured.
 *
 * `KIMI_API_KEY` is the Kimi credential for the v2 transport, but the legacy
 * REFLECT path uses it to select the Kimi endpoint (`src/telegram/bot.mjs`), so
 * under legacy dispatch it is a second identity authority. The reviewed
 * `AI_SKILL_MODE` therefore decides its meaning: identity in legacy, credential
 * in v2.
 */
export const LEGACY_PROMPT_IDENTITY_ENV = Object.freeze(['KIMI_API_KEY']);

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
 * @property {'v2' | 'legacy'} skillMode reviewed dispatch mode of the AI operations
 * @property {string} expectedManifestVersion
 * @property {string} expectedManifestSha256
 * @property {string | null} artifactSha256
 * @property {string[]} credentialProviders provider ids whose credential is present
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
  // Both reviewed mode selectors are resolved before any identity check: which
  // variables are a competing identity depends on the dispatch mode. A Kimi
  // credential is a legacy identity selector but the v2 provider secret.
  const rawSkillMode = isAbsent(env.AI_SKILL_MODE)
    ? AI_SKILL_MODE.LEGACY
    : String(env.AI_SKILL_MODE).trim().toLowerCase();
  if (!AI_SKILL_MODES.includes(rawSkillMode)) {
    throw new ConfigError(`AI_SKILL_MODE must be one of: ${AI_SKILL_MODES.join(', ')}`, {
      field: 'AI_SKILL_MODE',
    });
  }

  if (rawMode === AI_RUNTIME_MODE.LEGACY) {
    // There is no manifest identity to bind a packaged skill to, so a request
    // for v2 dispatch cannot be honoured here. Refusing the launch is the only
    // alternative to silently running the hard-coded prompts.
    if (rawSkillMode === AI_SKILL_MODE.V2) {
      throw new ConfigError(
        'AI_SKILL_MODE=v2 requires AI_RUNTIME_MODE=single: the v2 dispatch is bound to the admitted release identity',
        { field: 'AI_SKILL_MODE' },
      );
    }
    return Object.freeze({ mode: AI_RUNTIME_MODE.LEGACY });
  }

  const conflicts = [
    ...CONFLICTING_IDENTITY_ENV,
    ...(rawSkillMode === AI_SKILL_MODE.LEGACY ? LEGACY_PROMPT_IDENTITY_ENV : []),
  ].filter((name) => !isAbsent(env[name]));
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
  // Provider-scoped credentials present in this process, reduced to provider
  // ids. A v2 deployment binds models by provider, so a Kimi-only process has a
  // usable secret even when the DeepSeek variables are unset.
  const credentialProviders = Object.keys(PROVIDER_CREDENTIALS).filter(
    (providerId) => loadProviderApiKey(providerId, env) !== null,
  );
  const hasApiKey = credentialProviders.length > 0;
  // A key is NOT required here: a disabled observer and an injected fake
  // transport must both be able to start. The real provider factory fails
  // closed when inference is actually constructed without a secret.

  return Object.freeze({
    mode: AI_RUNTIME_MODE.SINGLE,
    controlDir: path.resolve(controlDir),
    deploymentId,
    slot: rawSlot,
    skillMode: rawSkillMode,
    expectedManifestVersion,
    expectedManifestSha256,
    artifactSha256: rawArtifact,
    credentialProviders,
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
    skillMode: config.skillMode,
    expectedManifestVersion: config.expectedManifestVersion,
    expectedManifestSha256: config.expectedManifestSha256,
    artifactSha256: config.artifactSha256,
    credentialProviders: [.../** @type {any} */ (config).credentialProviders],
    hasApiKey: /** @type {any} */ (config).hasApiKey,
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

/**
 * Provider-scoped credential lookup for the v2 transport (architecture §6.1:
 * a credential is selected by resolved provider/endpoint and injected only
 * inside the transport). A key is never reused across origins.
 *
 * @param {string} providerId
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function loadProviderApiKey(providerId, env = process.env) {
  const candidates = Object.hasOwn(PROVIDER_CREDENTIALS, providerId) ? PROVIDER_CREDENTIALS[providerId] : [];
  for (const name of candidates) {
    if (!isAbsent(env[name])) return String(env[name]);
  }
  return null;
}

/**
 * Build a `credentialProvider(identity)` callback for the v2 transport, keyed to
 * the resolved provider identity.
 *
 * @param {{ env?: Record<string, string | undefined> }} [input]
 * @returns {(identity: { providerId: string }) => string | null}
 */
export function createProviderCredentialResolver(input = {}) {
  const env = input.env ?? process.env;
  return (identity) => {
    const providerId = identity !== null && typeof identity === 'object' ? identity.providerId : null;
    if (typeof providerId !== 'string' || providerId === '') return null;
    return loadProviderApiKey(providerId, env);
  };
}
