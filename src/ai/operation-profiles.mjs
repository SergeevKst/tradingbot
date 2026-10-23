/**
 * Operation profiles for the six AI operations of the unified single-mode
 * release (UAI-05A, architecture §4.1).
 *
 * A capability profile is the reviewed, content-addressable bundle of provider
 * settings for ANALYZE, SCOUT, GUARD, MONITOR, STOPCHECK and REFLECT. It is
 * deliberately separate from the manifest: the manifest answers "which
 * deployment-wide identity", the profile answers "which provider settings",
 * and the manifest commits to the profile by digest so two builds cannot apply
 * different options under one profile name.
 *
 * The profile contains no credentials, prompts or parsing rules.
 *
 * @module ai/operation-profiles
 */
import { StrictJsonError, canonicalizeJson, digestJson, isPlainObject } from '../config/jcs.mjs';
import { ConfigError } from '../config/config-error.mjs';

/** Every operation the release protocol knows, in the fixed canonical order. */
export const AI_OPERATIONS = Object.freeze([
  'ANALYZE',
  'SCOUT',
  'GUARD',
  'MONITOR',
  'STOPCHECK',
  'REFLECT',
]);

/** Operation sets per participant role (architecture §3.1). */
export const ROLE_OPERATIONS = Object.freeze({
  'core-analysis': Object.freeze(['ANALYZE']),
  telegram: Object.freeze(['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT']),
});

/** Settings keys a profile entry may contain. Closed schema. */
export const OPERATION_SETTING_KEYS = Object.freeze([
  'temperature',
  'reasoningEffort',
  'maxOutputTokens',
  'stream',
  'responseFormat',
  'timeoutMs',
]);

/** Reasoning efforts an approved profile may select. */
export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high']);

/** Response formats the in-process transports support. */
export const RESPONSE_FORMATS = Object.freeze(['json_object', 'text']);

/** Upper bound for a per-operation timeout (10 minutes). */
export const MAX_OPERATION_TIMEOUT_MS = 600000;

/**
 * Default reviewed settings, mirroring the existing legacy transports:
 *   - ANALYZE: temperature 0, JSON object, 20 s (core provider default);
 *   - SCOUT: temperature 0.7, no reasoning effort (cheap/fast);
 *   - GUARD: temperature 0, low reasoning effort (adversarial, cost-capped);
 *   - MONITOR/STOPCHECK: temperature 0, low reasoning effort;
 *   - REFLECT: temperature 0, no reasoning effort.
 *
 * These are settings only — they change no prompt, parser or threshold.
 */
const DEFAULT_OPERATIONS = Object.freeze({
  ANALYZE: Object.freeze({
    temperature: 0,
    reasoningEffort: null,
    maxOutputTokens: null,
    stream: false,
    responseFormat: 'json_object',
    timeoutMs: 20000,
  }),
  SCOUT: Object.freeze({
    temperature: 0.7,
    reasoningEffort: null,
    maxOutputTokens: null,
    stream: false,
    responseFormat: 'json_object',
    timeoutMs: 60000,
  }),
  GUARD: Object.freeze({
    temperature: 0,
    reasoningEffort: 'low',
    maxOutputTokens: null,
    stream: false,
    responseFormat: 'json_object',
    timeoutMs: 60000,
  }),
  MONITOR: Object.freeze({
    temperature: 0,
    reasoningEffort: 'low',
    maxOutputTokens: null,
    stream: false,
    responseFormat: 'json_object',
    timeoutMs: 60000,
  }),
  STOPCHECK: Object.freeze({
    temperature: 0,
    reasoningEffort: 'low',
    maxOutputTokens: null,
    stream: false,
    responseFormat: 'json_object',
    timeoutMs: 60000,
  }),
  REFLECT: Object.freeze({
    temperature: 0,
    reasoningEffort: null,
    maxOutputTokens: null,
    stream: false,
    responseFormat: 'json_object',
    timeoutMs: 60000,
  }),
});

/** Canonical empty profile body for each supported provider. */
export const DEFAULT_CAPABILITY_PROFILE_BODIES = Object.freeze({
  deepseek: Object.freeze({
    schemaVersion: 1,
    profileId: 'deepseek-unified-v1',
    providerId: 'deepseek',
    operations: DEFAULT_OPERATIONS,
  }),
  kimi: Object.freeze({
    schemaVersion: 1,
    profileId: 'kimi-unified-v1',
    providerId: 'kimi',
    operations: DEFAULT_OPERATIONS,
  }),
});

/** Default per-operation settings (frozen copies). */
export function defaultOperationSettings() {
  return /** @type {Record<string, Readonly<object>>} */ (DEFAULT_OPERATIONS);
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(value)) {
    throw new ConfigError(`${field} must match [a-zA-Z0-9._-]{1,128}`, { field });
  }
}

/**
 * Validate one operation's settings. Closed schema: unknown keys fail.
 *
 * @param {unknown} raw
 * @param {string} field
 * @returns {Readonly<object>}
 */
export function validateOperationSettings(raw, field) {
  if (!isPlainObject(raw)) throw new ConfigError(`${field} must be an object`, { field });
  const input = /** @type {Record<string, unknown>} */ (raw);
  for (const key of Object.keys(input)) {
    if (!OPERATION_SETTING_KEYS.includes(key)) {
      throw new ConfigError(`${field} has an unknown setting ${JSON.stringify(key)}`, { field, key });
    }
  }
  const temperature = input.temperature;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new ConfigError(`${field}.temperature must be a number between 0 and 2`, { field: `${field}.temperature` });
  }
  const reasoningEffort = input.reasoningEffort;
  if (reasoningEffort !== null && !REASONING_EFFORTS.includes(/** @type {string} */ (reasoningEffort))) {
    throw new ConfigError(`${field}.reasoningEffort must be null or one of ${REASONING_EFFORTS.join(', ')}`, {
      field: `${field}.reasoningEffort`,
    });
  }
  const maxOutputTokens = input.maxOutputTokens;
  if (
    maxOutputTokens !== null &&
    (!Number.isSafeInteger(maxOutputTokens) || /** @type {number} */ (maxOutputTokens) <= 0)
  ) {
    throw new ConfigError(`${field}.maxOutputTokens must be null or a positive safe integer`, {
      field: `${field}.maxOutputTokens`,
    });
  }
  if (input.stream !== false) {
    throw new ConfigError(`${field}.stream must be false (streaming is not an approved capability)`, {
      field: `${field}.stream`,
    });
  }
  if (!RESPONSE_FORMATS.includes(/** @type {string} */ (input.responseFormat))) {
    throw new ConfigError(`${field}.responseFormat must be one of ${RESPONSE_FORMATS.join(', ')}`, {
      field: `${field}.responseFormat`,
    });
  }
  const timeoutMs = input.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || /** @type {number} */ (timeoutMs) <= 0 || /** @type {number} */ (timeoutMs) > MAX_OPERATION_TIMEOUT_MS) {
    throw new ConfigError(`${field}.timeoutMs must be a positive safe integer <= ${MAX_OPERATION_TIMEOUT_MS}`, {
      field: `${field}.timeoutMs`,
    });
  }
  return Object.freeze({
    temperature: /** @type {number} */ (temperature),
    reasoningEffort: /** @type {string | null} */ (reasoningEffort),
    maxOutputTokens: /** @type {number | null} */ (maxOutputTokens),
    stream: false,
    responseFormat: /** @type {string} */ (input.responseFormat),
    timeoutMs: /** @type {number} */ (timeoutMs),
  });
}

/**
 * Validate a capability profile (closed schema, exactly the six operations).
 *
 * @param {unknown} raw
 * @returns {Readonly<{ schemaVersion: number, profileId: string, providerId: string, operations: Readonly<Record<string, Readonly<object>>> }>}
 */
export function validateCapabilityProfile(raw) {
  if (!isPlainObject(raw)) throw new ConfigError('capability profile must be an object', { field: 'profile' });
  const input = /** @type {Record<string, unknown>} */ (raw);
  for (const key of Object.keys(input)) {
    if (!['schemaVersion', 'profileId', 'providerId', 'operations'].includes(key)) {
      throw new ConfigError(`capability profile has an unknown field ${JSON.stringify(key)}`, { field: key });
    }
  }
  if (input.schemaVersion !== 1) {
    throw new ConfigError('capability profile schemaVersion must be 1', { field: 'profile.schemaVersion' });
  }
  assertIdentifier(input.profileId, 'profile.profileId');
  if (input.providerId !== 'deepseek' && input.providerId !== 'kimi') {
    throw new ConfigError('capability profile providerId must be deepseek or kimi', { field: 'profile.providerId' });
  }
  if (!isPlainObject(input.operations)) {
    throw new ConfigError('capability profile operations must be an object', { field: 'profile.operations' });
  }
  const operations = /** @type {Record<string, unknown>} */ (input.operations);
  const keys = Object.keys(operations);
  for (const key of keys) {
    if (!AI_OPERATIONS.includes(key)) {
      throw new ConfigError(`capability profile has an unknown operation ${JSON.stringify(key)}`, {
        field: `profile.operations.${key}`,
      });
    }
  }
  for (const operation of AI_OPERATIONS) {
    if (!(operation in operations)) {
      throw new ConfigError(`capability profile is missing operation ${operation}`, {
        field: `profile.operations.${operation}`,
      });
    }
  }
  /** @type {Record<string, Readonly<object>>} */
  const validated = {};
  for (const operation of AI_OPERATIONS) {
    validated[operation] = validateOperationSettings(operations[operation], `profile.operations.${operation}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    profileId: /** @type {string} */ (input.profileId),
    providerId: /** @type {string} */ (input.providerId),
    operations: Object.freeze(validated),
  });
}

/**
 * Canonical serialization of a capability profile (content-addressable form).
 *
 * @param {unknown} profile
 * @returns {string}
 */
export function canonicalizeCapabilityProfile(profile) {
  const validated = validateCapabilityProfile(profile);
  return canonicalizeJson(validated, { label: 'capability profile' });
}

/**
 * Digest of the canonical profile bytes, which is what the manifest commits to.
 *
 * @param {unknown} profile
 * @returns {string}
 */
export function capabilityProfileSha256(profile) {
  return digestJson(validateCapabilityProfile(profile), { label: 'capability profile' });
}

/**
 * Build a profile from a reviewed body with optional per-operation overrides.
 *
 * @param {{ profileId: string, providerId: 'deepseek' | 'kimi', operations?: Record<string, object> }} input
 * @returns {Readonly<object>}
 */
export function createCapabilityProfile(input) {
  const base = DEFAULT_CAPABILITY_PROFILE_BODIES[input.providerId];
  if (!base) throw new ConfigError('providerId must be deepseek or kimi', { field: 'providerId' });
  return validateCapabilityProfile({
    schemaVersion: 1,
    profileId: input.profileId,
    providerId: input.providerId,
    operations: input.operations ?? base.operations,
  });
}

/**
 * @param {Readonly<object>} profile a validated profile
 * @param {string} operation
 * @returns {Readonly<object>}
 */
export function getOperationSettings(profile, operation) {
  if (!AI_OPERATIONS.includes(operation)) {
    throw new ConfigError(`unknown AI operation ${JSON.stringify(operation)}`, { field: 'operation' });
  }
  const settings = /** @type {any} */ (profile).operations?.[operation];
  if (!settings) throw new ConfigError(`profile has no settings for ${operation}`, { field: 'operation' });
  return settings;
}

/**
 * Re-export so callers do not import two JSON helpers.
 * @param {unknown} value
 * @param {{ label?: string }} [options]
 * @returns {string}
 */
export function operationProfileDigest(value, options) {
  try {
    return digestJson(value, options);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new ConfigError(`capability profile cannot be canonicalized: ${error.message}`, { field: 'profile' });
    }
    throw error;
  }
}
