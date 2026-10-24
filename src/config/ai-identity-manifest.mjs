/**
 * Model identity manifest: the single source of deployment-wide AI identity
 * (UAI-05A, ADR-001 rev 2 / ADR-005 rev 2).
 *
 * Identity is the configured provider + canonical HTTPS endpoint + exact model
 * ID + reviewed capability profile. It is *not* proof of immutable vendor
 * weights; see the amendment's trust boundary. Everything here is pure
 * validation: no file or network I/O, no secret loading, and no secret ever
 * appears in a message this module produces.
 *
 * @module config/ai-identity-manifest
 */
import { readFileSync } from 'node:fs';
import { ConfigError } from './config-error.mjs';
import { StrictJsonError, digestJson, isPlainObject, parseStrictJsonBytes } from './jcs.mjs';
import { capabilityProfileSha256, validateCapabilityProfile } from '../ai/operation-profiles.mjs';

/** Size ceilings from architecture §4. */
export const MANIFEST_MAX_BYTES = 16 * 1024;
export const CONTROL_RECORD_MAX_BYTES = 256 * 1024;
export const ACK_MAX_BYTES = 16 * 1024;
export const RELEASE_DESCRIPTOR_MAX_BYTES = 256 * 1024;

/** Exact identifier grammar used for every id in the release contract. */
export const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
/** Lowercase SHA-256 hex digest. */
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Host allowlist bound to the provider enum (architecture §4.1, extended by Multi-Model v1.2). */
export const PROVIDER_HOST_ALLOWLIST = Object.freeze({
  deepseek: Object.freeze(['api.deepseek.com']),
  kimi: Object.freeze(['api.moonshot.ai', 'api.moonshot.cn']),
  openrouter: Object.freeze(['openrouter.ai']),
});

/** Default identity port; any other explicit port is noncanonical. */
export const HTTPS_DEFAULT_PORT = '443';

/** The only canonical API root path. */
export const CANONICAL_API_PATH = '/v1';

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function assertIdentifier(value, field) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new ConfigError(`${field} must match [a-zA-Z0-9._-]{1,128}`, { field });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function assertDigest(value, field) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new ConfigError(`${field} must be a lowercase 64-character SHA-256 digest`, { field });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
export function assertPhaseInteger(value, field) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
    throw new ConfigError(`${field} must be a non-negative safe integer`, { field });
  }
  return /** @type {number} */ (value);
}

/**
 * Test-only URL policy. Production callers never pass this, so a loopback HTTP
 * endpoint cannot be enabled from the environment.
 *
 * @typedef {object} CanonicalUrlPolicy
 * @property {boolean} [allowLoopback]
 * @property {string[]} [extraHosts] exact lowercase hostnames
 * @property {boolean} [allowHttp]
 */

/**
 * Normalize an authoring URL to the canonical form. Used by authoring tools and
 * by the validator, which additionally requires the stored string to already be
 * canonical.
 *
 * @param {unknown} raw
 * @param {{ providerId: 'deepseek' | 'kimi', policy?: CanonicalUrlPolicy }} options
 * @returns {string}
 */
export function normalizeBaseUrl(raw, options) {
  const field = 'canonicalBaseUrl';
  if (typeof raw !== 'string' || raw === '') {
    throw new ConfigError(`${field} must be a non-empty string`, { field });
  }
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) {
    throw new ConfigError(`${field} must not contain whitespace or control characters`, { field });
  }
  if (raw.includes('\\')) {
    throw new ConfigError(`${field} must not contain backslashes`, { field });
  }
  /** @type {URL} */
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${field} is not a valid absolute URL`, { field });
  }
  const policy = options.policy ?? {};
  const httpAllowed = policy.allowHttp === true && policy.allowLoopback === true;
  if (url.protocol !== 'https:' && !(httpAllowed && url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new ConfigError(`${field} must use HTTPS`, { field });
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError(`${field} must not contain userinfo`, { field });
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConfigError(`${field} must not contain a query string or fragment`, { field });
  }
  if (url.port !== '' && url.port !== HTTPS_DEFAULT_PORT) {
    const testLoopback = policy.allowLoopback === true && policy.allowHttp === true && isLoopbackHost(url.hostname);
    if (!testLoopback) {
      throw new ConfigError(`${field} must use the default HTTPS port`, { field });
    }
  }
  if (url.pathname.includes('%')) {
    throw new ConfigError(`${field} must not contain percent escapes in the path`, { field });
  }
  const segments = url.pathname.split('/');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new ConfigError(`${field} must not contain dot path segments`, { field });
    }
  }
  if (url.pathname !== CANONICAL_API_PATH && url.pathname !== `${CANONICAL_API_PATH}/`) {
    throw new ConfigError(`${field} path must be exactly ${CANONICAL_API_PATH}`, { field });
  }
  const hostname = url.hostname.toLowerCase();
  const allowlisted = PROVIDER_HOST_ALLOWLIST[options.providerId] ?? [];
  const extraHosts = policy.extraHosts ?? [];
  const loopbackAllowed = policy.allowLoopback === true && isLoopbackHost(hostname);
  if (!allowlisted.includes(hostname) && !extraHosts.includes(hostname) && !loopbackAllowed) {
    throw new ConfigError(
      `${field} host ${JSON.stringify(hostname)} is not allowlisted for provider ${options.providerId}`,
      { field },
    );
  }
  return `${url.protocol}//${hostname}${url.port === '' || url.port === HTTPS_DEFAULT_PORT ? '' : `:${url.port}`}${CANONICAL_API_PATH}`;
}

/**
 * Canonicalize and validate an API root URL.
 *
 * Rules (architecture §4.1): WHATWG parse; reject whitespace/control
 * characters, userinfo, query, fragment, percent escapes in the path,
 * backslashes and dot path segments; require HTTPS; allowlisted exact hostname;
 * default port only; path exactly `/v1` or `/v1/`. A manifest is stored in
 * canonical form, so the validator also rejects a noncanonical (but parseable)
 * string.
 *
 * @param {unknown} raw
 * @param {{ providerId: 'deepseek' | 'kimi', policy?: CanonicalUrlPolicy }} options
 * @returns {string}
 */
export function canonicalizeBaseUrl(raw, options) {
  const canonical = normalizeBaseUrl(raw, options);
  if (raw !== canonical) {
    throw new ConfigError(
      `canonicalBaseUrl is not canonical; expected ${JSON.stringify(canonical)}`,
      { field: 'canonicalBaseUrl' },
    );
  }
  return canonical;
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/**
 * The one permitted chat-completions URL for a validated manifest.
 *
 * @param {Readonly<{ canonicalBaseUrl: string }>} manifest
 * @returns {string}
 */
export function deriveChatCompletionsUrl(manifest) {
  const base = /** @type {any} */ (manifest).canonicalBaseUrl;
  if (typeof base !== 'string' || !base.endsWith(CANONICAL_API_PATH)) {
    throw new ConfigError('manifest has no canonical API root', { field: 'canonicalBaseUrl' });
  }
  return `${base}/chat/completions`;
}

/** Fields of a `ModelIdentityManifest` (closed schema). */
export const MANIFEST_FIELDS = Object.freeze([
  'schemaVersion',
  'manifestVersion',
  'providerId',
  'modelId',
  'canonicalBaseUrl',
  'capabilityProfileId',
  'capabilityProfileSha256',
]);

/**
 * Validate a parsed manifest object.
 *
 * @param {unknown} raw
 * @param {{ policy?: CanonicalUrlPolicy }} [options]
 * @returns {Readonly<object>}
 */
export function validateModelIdentityManifest(raw, options = {}) {
  if (!isPlainObject(raw)) {
    throw new ConfigError('model identity manifest must be a JSON object', { field: 'manifest' });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);
  for (const key of Object.keys(input)) {
    if (!MANIFEST_FIELDS.includes(key)) {
      throw new ConfigError(`model identity manifest has an unknown field ${JSON.stringify(key)}`, { field: key });
    }
  }
  for (const key of MANIFEST_FIELDS) {
    if (!(key in input)) {
      throw new ConfigError(`model identity manifest is missing field ${key}`, { field: key });
    }
  }
  if (input.schemaVersion !== 1) {
    throw new ConfigError('manifest schemaVersion must be exactly 1', { field: 'schemaVersion' });
  }
  assertIdentifier(input.manifestVersion, 'manifestVersion');
  if (input.providerId !== 'deepseek' && input.providerId !== 'kimi') {
    throw new ConfigError('manifest providerId must be deepseek or kimi', { field: 'providerId' });
  }
  if (typeof input.modelId !== 'string') {
    throw new ConfigError('manifest modelId must be a string', { field: 'modelId' });
  }
  const modelId = input.modelId;
  if (modelId !== modelId.trim() || modelId === '' || modelId.length > 128) {
    throw new ConfigError('manifest modelId must be trimmed, non-empty and at most 128 characters', { field: 'modelId' });
  }
  if (/[\u0000-\u001f\u007f]/.test(modelId)) {
    throw new ConfigError('manifest modelId must not contain control characters', { field: 'modelId' });
  }
  const canonicalBaseUrl = canonicalizeBaseUrl(input.canonicalBaseUrl, {
    providerId: /** @type {'deepseek' | 'kimi'} */ (input.providerId),
    policy: options.policy,
  });
  assertIdentifier(input.capabilityProfileId, 'capabilityProfileId');
  assertDigest(input.capabilityProfileSha256, 'capabilityProfileSha256');
  return Object.freeze({
    schemaVersion: 1,
    manifestVersion: /** @type {string} */ (input.manifestVersion),
    providerId: /** @type {'deepseek' | 'kimi'} */ (input.providerId),
    modelId,
    canonicalBaseUrl,
    capabilityProfileId: /** @type {string} */ (input.capabilityProfileId),
    capabilityProfileSha256: /** @type {string} */ (input.capabilityProfileSha256),
  });
}

/**
 * Digest of the validated manifest (JCS bytes, digest not part of the object).
 *
 * @param {unknown} manifest
 * @param {{ policy?: CanonicalUrlPolicy }} [options]
 * @returns {string}
 */
export function computeManifestDigest(manifest, options = {}) {
  return digestJson(validateModelIdentityManifest(manifest, options), { label: 'manifest' });
}

/**
 * Load and validate a manifest from bytes, enforcing version/hash expectations.
 *
 * @param {Buffer | Uint8Array} bytes
 * @param {{ expectedVersion?: string, expectedSha256?: string, policy?: CanonicalUrlPolicy, label?: string }} [options]
 * @returns {Readonly<{ manifest: Readonly<object>, manifestSha256: string }>}
 */
export function loadModelIdentityManifestFromBytes(bytes, options = {}) {
  const label = options.label ?? 'manifest';
  /** @type {unknown} */
  let parsed;
  try {
    parsed = parseStrictJsonBytes(bytes, { label, maxBytes: MANIFEST_MAX_BYTES });
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new ConfigError(`${label} is not strict JSON: ${error.message}`, { field: 'manifest' });
    }
    throw error;
  }
  const manifest = validateModelIdentityManifest(parsed, { policy: options.policy });
  const manifestSha256 = computeManifestDigest(manifest, { policy: options.policy });
  if (options.expectedVersion !== undefined && manifest.manifestVersion !== options.expectedVersion) {
    throw new ConfigError(
      `${label} version mismatch: expected ${JSON.stringify(options.expectedVersion)}, found ${JSON.stringify(manifest.manifestVersion)}`,
      { field: 'manifestVersion' },
    );
  }
  if (options.expectedSha256 !== undefined && manifestSha256 !== options.expectedSha256) {
    throw new ConfigError(`${label} content digest does not match the expected manifest hash`, {
      field: 'manifestSha256',
    });
  }
  return Object.freeze({ manifest, manifestSha256 });
}

/**
 * @param {string} path
 * @param {{ expectedVersion?: string, expectedSha256?: string, policy?: CanonicalUrlPolicy, label?: string }} [options]
 * @returns {Readonly<{ manifest: Readonly<object>, manifestSha256: string }>}
 */
export function loadModelIdentityManifestFile(path, options = {}) {
  return loadModelIdentityManifestFromBytes(readFileSync(path), options);
}

/**
 * Validate that a profile matches the manifest's committed capability identity.
 *
 * @param {{ manifest: Readonly<object>, profile: unknown }} input
 * @returns {Readonly<object>} the validated profile
 */
export function assertProfileMatchesManifest(input) {
  const manifest = /** @type {any} */ (input.manifest);
  const profile = validateCapabilityProfile(input.profile);
  if (profile.profileId !== manifest.capabilityProfileId) {
    throw new ConfigError(
      `capability profile id ${JSON.stringify(profile.profileId)} does not match manifest ${JSON.stringify(manifest.capabilityProfileId)}`,
      { field: 'capabilityProfileId' },
    );
  }
  if (profile.providerId !== manifest.providerId) {
    throw new ConfigError('capability profile providerId does not match the manifest provider', {
      field: 'capabilityProfileId',
    });
  }
  const digest = capabilityProfileSha256(profile);
  if (digest !== manifest.capabilityProfileSha256) {
    throw new ConfigError('capability profile digest does not match the manifest', {
      field: 'capabilityProfileSha256',
    });
  }
  return profile;
}
