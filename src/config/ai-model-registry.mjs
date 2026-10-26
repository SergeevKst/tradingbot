/**
 * Model Registry v1 — Versioned, Content-Addressed Multi-Model Routing Configuration.
 *
 * This module implements the Unified Multi-Model Routing configuration system
 * described in architecture task t_a7022256 (approved via independent review t_3a76efe0).
 *
 * The registry provides:
 *   - A versioned configuration of models available for AI operations
 *   - Content-addressed integrity via SHA-256 hashing of canonical JSON
 *   - Operation-to-model routing with explicit fallback policy
 *   - Trust-tier classification (consequential vs supplementary vs informational)
 *
 * Security properties preserved from UAI v1.1 single-mode:
 *   - No I/O in this module (all parsing/canonicalization pure computation)
 *   - Strict validation rejects unknown fields, oversized payloads, BOM markers
 *   - Canonical serialization enables reproducible digests for binding hash inclusion
 *   - Fail-closed: any validation failure throws CoordinationError
 *
 * @module config/ai-model-registry
 */
import { createHash } from 'node:crypto';
import { ConfigError } from './config-error.mjs';
import { StrictJsonError, digestJson, isPlainObject, parseStrictJsonBytes } from './jcs.mjs';
import { IDENTIFIER_PATTERN, DIGEST_PATTERN } from './ai-identity-manifest.mjs';
import { COORDINATION_ERROR_CODE, CoordinationError } from '../errors/coordination-error.mjs';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum size of registry data (16 KB). Enforced before parsing. */
export const REGISTRY_MAX_BYTES = 16 * 1024;

/** Schema version supported by this module. */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1]);

/** Schema version expected by the current deployment. */
export const EXPECTED_SCHEMA_VERSION = 1;

/** Operations that are classified as consequential — never silently fall through on provider failure. */
export const CONSEQUENTIAL_OPERATIONS = Object.freeze(['ANALYZE', 'GUARD', 'STOPCHECK']);

/** Operations allowed as supplementary or informational — may have configurable fallbacks. */
export const NON_CONSEQUENTIAL_OPERATIONS = Object.freeze(['SCOUT', 'MONITOR', 'REFLECT']);

/** Complete set of valid operations (must match ai-identity-manifest AI_OPERATIONS exactly). */
export const ALL_OPERATIONS = Object.freeze([...CONSEQUENTIAL_OPERATIONS, ...NON_CONSEQUENTIAL_OPERATIONS]);

/** Valid trust tier values for model classification. */
export const TRUST_TIERS = Object.freeze(['consequential', 'supplementary', 'informational']);

/** Size ceiling for a resolved identity output object. */
export const RESOLVED_IDENTITY_MAX_BYTES = 4 * 1024;

// ─── Identity & Digest Patterns ─────────────────────────────────────────────

/** Identifier pattern used throughout the registry for keys and IDs. */
const KEY_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

/** Lowercase hex SHA-256 digest pattern. */
const HEX_DIGEST = /^[0-9a-f]{64}$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Helper: validate an identifier against the standard pattern. */
function assertIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(value)) {
    throw new ConfigError(`${field} must be an alphanumeric identifier`, { field });
  }
  return value;
}

/** Canonicalize and validate a URL string. Must be absolute HTTPS with path exactly `/v1`. */
function normalizeBaseUrlString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${field} must be a non-empty string`, { field });
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${field} must be a valid absolute URL`, { field });
  }
  // Require HTTPS
  if (url.protocol !== 'https:') {
    throw new ConfigError(`${field} must use HTTPS protocol`, { field });
  }
  // Require no userinfo, query, fragment
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ConfigError(`${field} must not contain userinfo, query string, or fragment`, { field });
  }
  // Path must end with /v1 or be just /v1
  const normalizedPath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  if (normalizedPath !== '/v1') {
    throw new ConfigError(`${field} path must be /v1`, { field });
  }
  return `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}/v1`;
}

/** Assert a value matches the key pattern (registry-specific, no leading dots). */
function assertRegistryKey(value, field) {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new ConfigError(`${field} must be a non-empty registry key`, { field });
  }
  return value;
}

/** Assert a digest value. */
function assertDigest(value, field) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new ConfigError(`${field} must be a lowercase 64-character SHA-256 hex digest`, { field });
  }
  return value;
}

/** Classify an operation's trust tier based on known consequential list. */
function classifyTrustTier(operation) {
  if (CONSEQUENTIAL_OPERATIONS.includes(operation)) {
    return 'consequential';
  }
  if (NON_CONSEQUENTIAL_OPERATIONS.includes(operation)) {
    return 'supplementary';
  }
  throw new ConfigError(`unknown operation ${JSON.stringify(operation)} — not in ALL_OPERATIONS`, { field: 'operation' });
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a single model entry within the registry.
 * Each model entry has: providerId, modelId, canonicalBaseUrl, capabilityProfileId, capabilityProfileSha256, trustTier
 *
 * @param {object} raw - Parsed model entry object
 * @returns {Readonly<object>} Validated and frozen model entry
 */
function validateModelEntry(raw) {
  if (!isPlainObject(raw)) {
    throw new ConfigError('model entry must be a plain object', { field: 'model' });
  }

  const input = /** @type {Record<string, unknown>} */ (raw);

  // Reject unknown fields — closed schema
  const KNOWN_FIELDS = new Set(['providerId', 'modelId', 'canonicalBaseUrl', 'capabilityProfileId', 'capabilityProfileSha256', 'trustTier']);
  for (const key of Object.keys(input)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new ConfigError(`model entry has unknown field ${JSON.stringify(key)}`, { field: key });
    }
  }

  // Required fields
  for (const key of KNOWN_FIELDS) {
    if (!(key in input)) {
      throw new ConfigError(`model entry missing required field ${key}`, { field: key });
    }
  }

  return Object.freeze({
    providerId: assertIdentifier(input.providerId, 'model.providerId'),
    modelId: assertIdentifier(input.modelId, 'model.modelId'),
    canonicalBaseUrl: normalizeBaseUrlString(input.canonicalBaseUrl, 'model.canonicalBaseUrl'),
    capabilityProfileId: assertIdentifier(input.capabilityProfileId, 'model.capabilityProfileId'),
    capabilityProfileSha256: assertDigest(input.capabilityProfileSha256, 'model.capabilityProfileSha256'),
    trustTier: (() => {
      const tier = String(input.trustTier);
      if (!TRUST_TIERS.includes(tier)) {
        throw new ConfigError(`model.trustTier must be one of ${TRUST_TIERS.join(', ')}`, { field: 'model.trustTier' });
      }
      return tier;
    })(),
  });
}

/**
 * Validate the entire ModelRegistry v1 document.
 *
 * @param {unknown} raw - Fully parsed registry object
 * @returns {{ schemaVersion: number, registryId: string, models: Record<string, Readonly<object>>, routingTable: Record<string, string>, fallbacks: Record<string, null | string>, digestSha256: string }}
 */
export function validateModelRegistry(raw) {
  if (!isPlainObject(raw)) {
    throw new ConfigError('model registry must be a JSON object', { field: 'registry' });
  }

  const input = /** @type {Record<string, unknown>} */ (raw);

  // Reject unknown top-level fields
  const KNOWN_TOP_LEVEL = new Set(['schemaVersion', 'registryId', 'models', 'routingTable', 'fallbacks', '_notes']);
  for (const key of Object.keys(input)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      throw new ConfigError(`model registry has unknown field ${JSON.stringify(key)}`, { field: key });
    }
  }

  // Required fields
  for (const key of ['schemaVersion', 'registryId', 'models', 'routingTable', 'fallbacks']) {
    if (!(key in input)) {
      throw new ConfigError(`model registry missing required field ${key}`, { field: key });
    }
  }

  // Schema version check
  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    throw new ConfigError(`model registry schemaVersion must be ${EXPECTED_SCHEMA_VERSION}, got ${JSON.stringify(schemaVersion)}`, { field: 'schemaVersion' });
  }

  // Registry ID validation
  const registryId = assertIdentifier(input.registryId, 'registryId');

  // Models dictionary — each key maps to a validated model entry
  if (!isPlainObject(input.models)) {
    throw new ConfigError('registry.models must be an object', { field: 'models' });
  }
  const validatedModels = {};
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (input.models))) {
    const modelKey = assertRegistryKey(key, `models.${key}`);
    validatedModels[modelKey] = validateModelEntry(value);
  }
  if (Object.keys(validatedModels).length === 0) {
    throw new ConfigError('registry.models must contain at least one model entry', { field: 'models' });
  }

  // Routing table — each operation maps to a model key
  if (!isPlainObject(input.routingTable)) {
    throw new ConfigError('registry.routingTable must be an object', { field: 'routingTable' });
  }
  const routingTable = {};
  for (const [operation, modelKey] of Object.entries(/** @type {Record<string, unknown>} */ (input.routingTable))) {
    if (!ALL_OPERATIONS.includes(operation)) {
      throw new ConfigError(`routingTable references unknown operation ${JSON.stringify(operation)}`, { field: `routingTable.${operation}` });
    }
    if (typeof modelKey !== 'string' || !KEY_PATTERN.test(modelKey)) {
      throw new ConfigError(`routingTable.${operation} must reference a valid model key`, { field: `routingTable.${operation}` });
    }
    if (!(modelKey in validatedModels)) {
      throw new ConfigError(`routingTable.${operation} references undefined model key ${JSON.stringify(modelKey)}`, { field: `routingTable.${operation}` });
    }
    routingTable[operation] = modelKey;
  }

  // Fallbacks — optional model key per operation, null means "no fallback"
  if (!isPlainObject(input.fallbacks)) {
    throw new ConfigError('registry.fallbacks must be an object', { field: 'fallbacks' });
  }
  const fallbacks = {};
  for (const [operation, fallbackKey] of Object.entries(/** @type {Record<string, unknown>} */ (input.fallbacks))) {
    if (!ALL_OPERATIONS.includes(operation)) {
      throw new ConfigError(`fallbacks references unknown operation ${JSON.stringify(operation)}`, { field: `fallbacks.${operation}` });
    }
    if (fallbackKey !== null && typeof fallbackKey !== 'string') {
      throw new ConfigError(`fallbacks.${operation} must be null or a string`, { field: `fallbacks.${operation}` });
    }
    if (typeof fallbackKey === 'string') {
      if (!KEY_PATTERN.test(fallbackKey)) {
        throw new ConfigError(`fallbacks.${operation} invalid model key`, { field: `fallbacks.${operation}` });
      }
      if (!(fallbackKey in validatedModels)) {
        throw new ConfigError(`fallbacks.${operation} references undefined model key`, { field: `fallbacks.${operation}` });
      }
    }
    fallbacks[operation] = fallbackKey ?? null;
  }

  // Compute digest
  const digestSha256 = (() => {
    try {
      return digestJson({ schemaVersion, registryId, models: input.models, routingTable, fallbacks }, { label: 'registry' });
    } catch (error) {
      if (error instanceof StrictJsonError) {
        throw new ConfigError(`model registry cannot be canonicalized: ${error.message}`, { field: 'digest' });
      }
      throw error;
    }
  })();

  return Object.freeze({
    schemaVersion,
    registryId,
    models: validatedModels,
    routingTable,
    fallbacks,
    digestSha256,
  });
}

// ─── Loading ─────────────────────────────────────────────────────────────────

/**
 * Parse and validate a registry from bytes (e.g., loaded from disk file).
 *
 * @param {Buffer | Uint8Array} bytes
 * @returns {Readonly<{ registry: ReturnType<typeof validateModelRegistry>, rawText: string }>}
 */
export function loadModelRegistryFromBytes(bytes) {
  const label = 'registry';
  if (!(bytes instanceof Uint8Array)) {
    throw new ConfigError('registry source must be Bytes/Uint8Array', { field: 'source' });
  }
  if (bytes.byteLength > REGISTRY_MAX_BYTES) {
    throw new ConfigError(`registry exceeds ${REGISTRY_MAX_BYTES}-byte limit (${bytes.byteLength} bytes)`, { field: 'source' });
  }

  // Decode UTF-8 strict
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new StrictJsonError('registry source is not valid UTF-8', { code: StrictJsonError.OVERSIZE, label });
  }

  // Parse strictly (rejects BOM, duplicate keys, trailing content, surrogates)
  let parsed;
  try {
    parsed = parseStrictJsonBytes(bytes, { label, maxBytes: REGISTRY_MAX_BYTES });
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new ConfigError(`${label} is not strict JSON: ${error.message}`, { field: 'parse' });
    }
    throw error;
  }

  // Validate structure
  const registry = validateModelRegistry(parsed);

  return Object.freeze({ registry, rawText: text });
}

/**
 * Load and validate a registry from a string.
 * Convenience wrapper around loadModelRegistryFromBytes.
 *
 * @param {string} jsonText
 * @returns {{ registry: ReturnType<typeof validateModelRegistry> }}
 */
export function loadModelRegistry(jsonText) {
  const encoder = new TextEncoder();
  return loadModelRegistryFromBytes(encoder.encode(jsonText));
}
