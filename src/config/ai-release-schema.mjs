/**
 * Closed schemas for the release control contract (UAI-05A/05B, amendment
 * §4, §9.1). Every object here is a closed schema: duplicate keys are rejected
 * by the strict parser, unknown keys and missing fields by these validators.
 *
 * Pure validation only — no I/O, no clock, no secrets.
 *
 * @module config/ai-release-schema
 */
import { ConfigError } from './config-error.mjs';
import { digestJson, isPlainObject } from './jcs.mjs';
import {
  ACK_MAX_BYTES,
  CONTROL_RECORD_MAX_BYTES,
  DIGEST_PATTERN,
  IDENTIFIER_PATTERN,
  MANIFEST_MAX_BYTES,
  RELEASE_DESCRIPTOR_MAX_BYTES,
  assertDigest,
  assertIdentifier,
} from './ai-identity-manifest.mjs';
import { AI_OPERATIONS } from '../ai/operation-profiles.mjs';

/** Release phases (architecture §4.3, §9.3). */
export const PHASE = Object.freeze({
  ACTIVE: 'ACTIVE',
  QUIESCING: 'QUIESCING',
  PREPARING: 'PREPARING',
  ARMED: 'ARMED',
  PAUSED: 'PAUSED',
});

export const PHASES = Object.freeze(Object.values(PHASE));

/** Non-ACTIVE phases that carry an in-flight transition. */
export const TRANSITION_PHASES = Object.freeze([PHASE.QUIESCING, PHASE.PREPARING, PHASE.ARMED]);

/** Acknowledgement statuses (architecture §4.4). */
export const ACK_STATUS = Object.freeze({
  QUIESCED: 'QUIESCED',
  PREPARED: 'PREPARED',
  ERROR: 'ERROR',
});

export const ACK_STATUSES = Object.freeze(Object.values(ACK_STATUS));

/** Retirement evidence kinds. */
export const RETIREMENT_KIND = Object.freeze({ QUIESCED: 'QUIESCED', FENCED: 'FENCED' });

/** Observer receipt statuses. */
export const OBSERVER_STATUS = Object.freeze({ VALIDATED: 'VALIDATED', ERROR: 'ERROR' });

/** Safe, non-secret error codes usable in acks, receipts and status reports. */
export const COORDINATION_ERROR_CODE = Object.freeze({
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  COORDINATION_UNAVAILABLE: 'COORDINATION_UNAVAILABLE',
  GENERATION_RETIRED: 'GENERATION_RETIRED',
  ACTIVATION_PAUSED: 'ACTIVATION_PAUSED',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  STORE_CORRUPT: 'STORE_CORRUPT',
  STORE_LOCKED: 'STORE_LOCKED',
  WORK_OUTSTANDING: 'WORK_OUTSTANDING',
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  APPROVAL_INVALID: 'APPROVAL_INVALID',
  ARTIFACT_MISMATCH: 'ARTIFACT_MISMATCH',
  PROFILE_MISMATCH: 'PROFILE_MISMATCH',
  MANIFEST_MISSING: 'MANIFEST_MISSING',
  MANIFEST_STALE: 'MANIFEST_STALE',
  INVENTORY_MISMATCH: 'INVENTORY_MISMATCH',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  MISSING_SECRET: 'MISSING_SECRET',
  SLOT_NOT_ADMITTED: 'SLOT_NOT_ADMITTED',
  SLOT_DISABLED: 'SLOT_DISABLED',
  SLOT_CONFLICT: 'SLOT_CONFLICT',
  UNSUPPORTED_PROVIDER: 'UNSUPPORTED_PROVIDER',
  INVALID_EVIDENCE: 'INVALID_EVIDENCE',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

export const COORDINATION_ERROR_CODES = Object.freeze(Object.values(COORDINATION_ERROR_CODE));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Maximum sizes re-exported for callers that read files themselves. */
export const RELEASE_LIMITS = Object.freeze({
  manifestBytes: MANIFEST_MAX_BYTES,
  controlRecordBytes: CONTROL_RECORD_MAX_BYTES,
  ackBytes: ACK_MAX_BYTES,
  releaseDescriptorBytes: RELEASE_DESCRIPTOR_MAX_BYTES,
  auditLineBytes: 64 * 1024,
});

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function assertUuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ConfigError(`${field} must be a lowercase UUID`, { field });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} field
 * @returns {string}
 */
export function assertEnum(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ConfigError(`${field} must be one of: ${allowed.join(', ')}`, { field });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
    throw new ConfigError(`${field} must be a non-negative safe integer`, { field });
  }
  return /** @type {number} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1) {
    throw new ConfigError(`${field} must be a positive safe integer`, { field });
  }
  return /** @type {number} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function assertBoolean(value, field) {
  if (typeof value !== 'boolean') throw new ConfigError(`${field} must be a boolean`, { field });
  return /** @type {boolean} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${field} must be a non-empty string`, { field });
  }
  return value;
}

/**
 * Reject unknown and missing keys for a closed schema object.
 *
 * @param {unknown} raw
 * @param {readonly string[]} allowed
 * @param {readonly string[]} required
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
export function assertClosedObject(raw, allowed, required, label) {
  if (!isPlainObject(raw)) throw new ConfigError(`${label} must be an object`, { field: label });
  /** @type {Record<string, unknown>} */
  const input = /** @type {any} */ (raw);
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${label} has an unknown field ${JSON.stringify(key)}`, { field: `${label}.${key}` });
    }
  }
  for (const key of required) {
    if (!(key in input)) {
      throw new ConfigError(`${label} is missing field ${key}`, { field: `${label}.${key}` });
    }
  }
  return input;
}

/**
 * @param {unknown} raw
 * @param {string} field
 * @returns {unknown[]}
 */
function assertArray(raw, field) {
  if (!Array.isArray(raw)) throw new ConfigError(`${field} must be an array`, { field });
  return /** @type {unknown[]} */ (raw);
}

const OPERATION_RANK = new Map(AI_OPERATIONS.map((operation, index) => [operation, index]));

/**
 * Canonical operation list: deduplicated, validated, in fixed protocol order.
 *
 * @param {unknown} raw
 * @param {string} field
 * @returns {readonly string[]}
 */
export function normalizeOperationList(raw, field) {
  const input = assertArray(raw, field);
  if (input.length === 0) throw new ConfigError(`${field} must list at least one operation`, { field });
  const seen = new Set();
  for (const operation of input) {
    if (typeof operation !== 'string' || !OPERATION_RANK.has(operation)) {
      throw new ConfigError(`${field} contains an unknown operation ${JSON.stringify(operation)}`, { field });
    }
    if (seen.has(operation)) {
      throw new ConfigError(`${field} contains duplicate operation ${operation}`, { field });
    }
    seen.add(operation);
  }
  return Object.freeze([...input].sort((a, b) => OPERATION_RANK.get(a) - OPERATION_RANK.get(b)));
}

/**
 * Validate one inventory entry.
 *
 * @param {unknown} raw
 * @param {string} field
 * @returns {Readonly<{ slot: string, operations: readonly string[], enabled: boolean }>}
 */
export function validateInventoryEntry(raw, field = 'inventory entry') {
  const input = assertClosedObject(raw, ['slot', 'operations', 'enabled'], ['slot', 'operations', 'enabled'], field);
  return Object.freeze({
    slot: assertIdentifier(input.slot, `${field}.slot`),
    operations: normalizeOperationList(input.operations, `${field}.operations`),
    enabled: assertBoolean(input.enabled, `${field}.enabled`),
  });
}

/**
 * Validate a release inventory: unique slots, sorted by slot.
 *
 * @param {unknown} raw
 * @returns {readonly Readonly<{ slot: string, operations: readonly string[], enabled: boolean }>[]}
 */
export function validateInventory(raw) {
  const input = assertArray(raw, 'inventory');
  /** @type {Readonly<{ slot: string, operations: readonly string[], enabled: boolean }>[]} */
  const entries = [];
  const seen = new Set();
  for (let index = 0; index < input.length; index += 1) {
    const entry = validateInventoryEntry(input[index], `inventory[${index}]`);
    if (seen.has(entry.slot)) {
      throw new ConfigError(`inventory contains duplicate slot ${JSON.stringify(entry.slot)}`, { field: 'inventory' });
    }
    seen.add(entry.slot);
    entries.push(entry);
  }
  entries.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  return Object.freeze(entries);
}

/**
 * Inventory digest: JCS over the inventory sorted by slot with operations in
 * protocol order (architecture §4.3).
 *
 * @param {unknown} inventory
 * @returns {string}
 */
export function computeInventoryDigest(inventory) {
  return digestJson(validateInventory(inventory), { label: 'inventory' });
}

/**
 * @param {unknown} raw
 * @param {string} field
 * @returns {Readonly<{ slot: string, artifactSha256: string }>}
 */
export function validateArtifactAssignment(raw, field = 'artifact') {
  const input = assertClosedObject(raw, ['slot', 'artifactSha256'], ['slot', 'artifactSha256'], field);
  return Object.freeze({
    slot: assertIdentifier(input.slot, `${field}.slot`),
    artifactSha256: assertDigest(input.artifactSha256, `${field}.artifactSha256`),
  });
}

/**
 * @param {unknown} raw
 * @param {string} field
 * @returns {Readonly<{ observerId: string, artifactSha256: string, required: boolean }>}
 */
export function validateObserverAssignment(raw, field = 'observer') {
  const input = assertClosedObject(
    raw,
    ['observerId', 'artifactSha256', 'required'],
    ['observerId', 'artifactSha256', 'required'],
    field,
  );
  return Object.freeze({
    observerId: assertIdentifier(input.observerId, `${field}.observerId`),
    artifactSha256: assertDigest(input.artifactSha256, `${field}.artifactSha256`),
    required: assertBoolean(input.required, `${field}.required`),
  });
}

/**
 * Validate the artifact set and its relationships with the inventory.
 *
 * @param {unknown} rawArtifacts
 * @param {unknown} rawObservers
 * @param {readonly Readonly<{ slot: string, enabled: boolean, operations: readonly string[] }>[]} inventory
 * @returns {Readonly<{ artifacts: readonly Readonly<{ slot: string, artifactSha256: string }>[], observers: readonly Readonly<{ observerId: string, artifactSha256: string, required: boolean }>[] }>}
 */
export function validateArtifactSet(rawArtifacts, rawObservers, inventory) {
  const artifactsInput = assertArray(rawArtifacts, 'artifacts');
  const observersInput = assertArray(rawObservers, 'observers');
  /** @type {Readonly<{ slot: string, artifactSha256: string }>[]} */
  const artifacts = [];
  const artifactSlots = new Set();
  for (let index = 0; index < artifactsInput.length; index += 1) {
    const entry = validateArtifactAssignment(artifactsInput[index], `artifacts[${index}]`);
    if (artifactSlots.has(entry.slot)) {
      throw new ConfigError(`artifacts contains duplicate slot ${JSON.stringify(entry.slot)}`, { field: 'artifacts' });
    }
    artifactSlots.add(entry.slot);
    artifacts.push(entry);
  }
  /** @type {Readonly<{ observerId: string, artifactSha256: string, required: boolean }>[]} */
  const observers = [];
  const observerIds = new Set();
  for (let index = 0; index < observersInput.length; index += 1) {
    const entry = validateObserverAssignment(observersInput[index], `observers[${index}]`);
    if (observerIds.has(entry.observerId)) {
      throw new ConfigError(`observers contains duplicate id ${JSON.stringify(entry.observerId)}`, { field: 'observers' });
    }
    observerIds.add(entry.observerId);
    observers.push(entry);
  }
  const slotNames = new Set(inventory.map((entry) => entry.slot));
  for (const artifact of artifacts) {
    if (!slotNames.has(artifact.slot)) {
      throw new ConfigError(`artifacts references slot ${JSON.stringify(artifact.slot)} that is not in the inventory`, {
        field: 'artifacts',
      });
    }
  }
  for (const entry of inventory) {
    if (entry.enabled && !artifactSlots.has(entry.slot)) {
      throw new ConfigError(`enabled slot ${JSON.stringify(entry.slot)} has no assigned artifact`, {
        field: 'artifacts',
      });
    }
    if (!entry.enabled && artifactSlots.has(entry.slot)) {
      throw new ConfigError(`disabled slot ${JSON.stringify(entry.slot)} must not have an active artifact assignment`, {
        field: 'artifacts',
      });
    }
  }
  for (const observer of observers) {
    if (slotNames.has(observer.observerId)) {
      throw new ConfigError(`observer ${JSON.stringify(observer.observerId)} aliases an inference slot`, {
        field: 'observers',
      });
    }
  }
  artifacts.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  observers.sort((a, b) => (a.observerId < b.observerId ? -1 : a.observerId > b.observerId ? 1 : 0));
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    observers: Object.freeze(observers),
  });
}

/**
 * Artifact-set digest: JCS over `{artifacts, observers}` (architecture §9.1).
 *
 * @param {{ artifacts: unknown, observers: unknown, inventory: unknown }} input
 * @returns {string}
 */
export function computeArtifactSetDigest(input) {
  const inventory = validateInventory(input.inventory);
  const artifactSet = validateArtifactSet(input.artifacts, input.observers, inventory);
  return digestJson({ artifacts: artifactSet.artifacts, observers: artifactSet.observers }, { label: 'artifact set' });
}

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<{ manifestVersion: string, manifestSha256: string, capabilityProfileSha256: string, inventorySha256: string, artifactSetSha256: string }>}
 */
export function validateBinding(raw, label = 'binding') {
  const input = assertClosedObject(
    raw,
    ['manifestVersion', 'manifestSha256', 'capabilityProfileSha256', 'inventorySha256', 'artifactSetSha256'],
    ['manifestVersion', 'manifestSha256', 'capabilityProfileSha256', 'inventorySha256', 'artifactSetSha256'],
    label,
  );
  return Object.freeze({
    manifestVersion: assertIdentifier(input.manifestVersion, `${label}.manifestVersion`),
    manifestSha256: assertDigest(input.manifestSha256, `${label}.manifestSha256`),
    capabilityProfileSha256: assertDigest(input.capabilityProfileSha256, `${label}.capabilityProfileSha256`),
    inventorySha256: assertDigest(input.inventorySha256, `${label}.inventorySha256`),
    artifactSetSha256: assertDigest(input.artifactSetSha256, `${label}.artifactSetSha256`),
  });
}

/**
 * Build the binding for a validated manifest/profile/inventory/artifact set.
 *
 * @param {{ manifest: any, manifestSha256: string, profile: any, profileSha256: string, inventory: unknown, artifacts: unknown, observers: unknown }} input
 * @returns {Readonly<object>}
 */
export function createBinding(input) {
  const manifest = /** @type {any} */ (input.manifest);
  const profile = /** @type {any} */ (input.profile);
  return Object.freeze({
    manifestVersion: assertIdentifier(manifest.manifestVersion, 'manifest.manifestVersion'),
    manifestSha256: assertDigest(input.manifestSha256, 'manifest.manifestSha256'),
    capabilityProfileSha256: assertDigest(input.profileSha256, 'profile.capabilityProfileSha256'),
    inventorySha256: computeInventoryDigest(input.inventory),
    artifactSetSha256: computeArtifactSetDigest({
      artifacts: input.artifacts,
      observers: input.observers,
      inventory: input.inventory,
    }),
  });
}

/**
 * Closed field list of the v2 joint binding (architecture v1.1 §7.1).
 *
 * The five v1 fields are retained as manifest/profile lineage so an old reader
 * can still distinguish an artifact set; the four v2 fields commit the model
 * registry, the skill registry, the prepared execution plan and the effective
 * runtime policy.
 */
export const BINDING_V2_FIELDS = Object.freeze([
  'schemaVersion',
  'manifestVersion',
  'manifestSha256',
  'capabilityProfileSha256',
  'inventorySha256',
  'artifactSetSha256',
  'modelRegistrySha256',
  'skillRegistrySha256',
  'executionPlanSha256',
  'runtimePolicySha256',
  'bindingSha256',
]);

/** The binding body excludes its own digest. */
export const BINDING_V2_BODY_FIELDS = Object.freeze(BINDING_V2_FIELDS.filter((field) => field !== 'bindingSha256'));

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<object>} the validated body without `bindingSha256`
 */
export function validateBindingV2Body(raw, label = 'binding') {
  const input = assertClosedObject(raw, BINDING_V2_BODY_FIELDS, BINDING_V2_BODY_FIELDS, label);
  if (input.schemaVersion !== 2) {
    throw new ConfigError(`${label} schemaVersion must be exactly 2`, { field: `${label}.schemaVersion` });
  }
  return Object.freeze({
    schemaVersion: 2,
    manifestVersion: assertIdentifier(input.manifestVersion, `${label}.manifestVersion`),
    manifestSha256: assertDigest(input.manifestSha256, `${label}.manifestSha256`),
    capabilityProfileSha256: assertDigest(input.capabilityProfileSha256, `${label}.capabilityProfileSha256`),
    inventorySha256: assertDigest(input.inventorySha256, `${label}.inventorySha256`),
    artifactSetSha256: assertDigest(input.artifactSetSha256, `${label}.artifactSetSha256`),
    modelRegistrySha256: assertDigest(input.modelRegistrySha256, `${label}.modelRegistrySha256`),
    skillRegistrySha256: assertDigest(input.skillRegistrySha256, `${label}.skillRegistrySha256`),
    executionPlanSha256: assertDigest(input.executionPlanSha256, `${label}.executionPlanSha256`),
    runtimePolicySha256: assertDigest(input.runtimePolicySha256, `${label}.runtimePolicySha256`),
  });
}

/**
 * @param {unknown} body
 * @returns {string}
 */
export function computeBindingV2Sha256(body) {
  return digestJson(validateBindingV2Body(body), { label: 'binding v2 body' });
}

/**
 * Validate a v2 binding and recompute its digest. A binding whose digest does
 * not cover its own body is rejected, so "append a skill name" style shortcuts
 * cannot pass release review.
 *
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<object>}
 */
export function validateBindingV2(raw, label = 'binding') {
  const input = assertClosedObject(raw, BINDING_V2_FIELDS, BINDING_V2_FIELDS, label);
  const body = validateBindingV2Body(
    Object.fromEntries(BINDING_V2_BODY_FIELDS.map((field) => [field, input[field]])),
    label,
  );
  const digest = assertDigest(input.bindingSha256, `${label}.bindingSha256`);
  if (computeBindingV2Sha256(body) !== digest) {
    throw new ConfigError(`${label}.bindingSha256 does not hash its own body`, { field: `${label}.bindingSha256` });
  }
  return Object.freeze({ ...body, bindingSha256: digest });
}

/**
 * Build a v2 binding from verified components.
 *
 * @param {{
 *   manifest: any, manifestSha256: string, profileSha256: string,
 *   inventory: unknown, artifacts: unknown, observers: unknown,
 *   modelRegistrySha256: string, skillRegistrySha256: string,
 *   executionPlanSha256: string, runtimePolicySha256: string,
 * }} input
 * @returns {Readonly<object>}
 */
export function createBindingV2(input) {
  const manifest = /** @type {any} */ (input.manifest);
  const body = validateBindingV2Body({
    schemaVersion: 2,
    manifestVersion: assertIdentifier(manifest.manifestVersion, 'manifest.manifestVersion'),
    manifestSha256: assertDigest(input.manifestSha256, 'manifest.manifestSha256'),
    capabilityProfileSha256: assertDigest(input.profileSha256, 'profile.capabilityProfileSha256'),
    inventorySha256: computeInventoryDigest(input.inventory),
    artifactSetSha256: computeArtifactSetDigest({
      artifacts: input.artifacts,
      observers: input.observers,
      inventory: input.inventory,
    }),
    modelRegistrySha256: assertDigest(input.modelRegistrySha256, 'modelRegistrySha256'),
    skillRegistrySha256: assertDigest(input.skillRegistrySha256, 'skillRegistrySha256'),
    executionPlanSha256: assertDigest(input.executionPlanSha256, 'executionPlanSha256'),
    runtimePolicySha256: assertDigest(input.runtimePolicySha256, 'runtimePolicySha256'),
  });
  return Object.freeze({ ...body, bindingSha256: computeBindingV2Sha256(body) });
}

/**
 * Fields two bindings must agree on to be the same identity. v1 and v2 bindings
 * are never equal: mixing them across a generation is exactly the bug this
 * prevents.
 *
 * @param {unknown} binding
 * @returns {readonly string[]}
 */
export function bindingComparisonFields(binding) {
  const value = /** @type {any} */ (binding);
  if (value !== null && typeof value === 'object' && value.schemaVersion === 2) {
    return BINDING_V2_FIELDS;
  }
  return Object.freeze(['manifestVersion', 'manifestSha256', 'capabilityProfileSha256', 'inventorySha256', 'artifactSetSha256']);
}

/**
 * @param {unknown} binding
 * @returns {2 | 1}
 */
export function bindingSchemaVersion(binding) {
  const value = /** @type {any} */ (binding);
  return value !== null && typeof value === 'object' && value.schemaVersion === 2 ? 2 : 1;
}

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<{ slot: string, instanceId: string, artifactSha256: string }>}
 */
export function validateMember(raw, label = 'member') {
  const input = assertClosedObject(raw, ['slot', 'instanceId', 'artifactSha256'], ['slot', 'instanceId', 'artifactSha256'], label);
  return Object.freeze({
    slot: assertIdentifier(input.slot, `${label}.slot`),
    instanceId: assertIdentifier(input.instanceId, `${label}.instanceId`),
    artifactSha256: assertDigest(input.artifactSha256, `${label}.artifactSha256`),
  });
}

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {readonly Readonly<{ slot: string, instanceId: string, artifactSha256: string }>[]}
 */
export function validateMembers(raw, label = 'members') {
  const input = assertArray(raw, label);
  /** @type {Readonly<{ slot: string, instanceId: string, artifactSha256: string }>[]} */
  const members = [];
  const slots = new Set();
  for (let index = 0; index < input.length; index += 1) {
    const member = validateMember(input[index], `${label}[${index}]`);
    if (slots.has(member.slot)) {
      throw new ConfigError(`${label} contains duplicate slot ${JSON.stringify(member.slot)}`, { field: label });
    }
    slots.add(member.slot);
    members.push(member);
  }
  members.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  return Object.freeze(members);
}

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<{ slot: string, instanceId: string, kind: 'QUIESCED' | 'FENCED', evidenceSha256: string }>}
 */
export function validateRetirementEvidence(raw, label = 'retirementEvidence') {
  const input = assertClosedObject(
    raw,
    ['slot', 'instanceId', 'kind', 'evidenceSha256'],
    ['slot', 'instanceId', 'kind', 'evidenceSha256'],
    label,
  );
  return Object.freeze({
    slot: assertIdentifier(input.slot, `${label}.slot`),
    instanceId: assertIdentifier(input.instanceId, `${label}.instanceId`),
    kind: /** @type {'QUIESCED' | 'FENCED'} */ (assertEnum(input.kind, Object.values(RETIREMENT_KIND), `${label}.kind`)),
    evidenceSha256: assertDigest(input.evidenceSha256, `${label}.evidenceSha256`),
  });
}

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<{ slot: string, instanceId: string, evidenceSha256: string }>}
 */
export function validatePrepareEvidence(raw, label = 'prepareEvidence') {
  const input = assertClosedObject(raw, ['slot', 'instanceId', 'evidenceSha256'], ['slot', 'instanceId', 'evidenceSha256'], label);
  return Object.freeze({
    slot: assertIdentifier(input.slot, `${label}.slot`),
    instanceId: assertIdentifier(input.instanceId, `${label}.instanceId`),
    evidenceSha256: assertDigest(input.evidenceSha256, `${label}.evidenceSha256`),
  });
}

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<{ observerId: string, evidenceSha256: string }>}
 */
export function validateObserverEvidence(raw, label = 'observerEvidence') {
  const input = assertClosedObject(raw, ['observerId', 'evidenceSha256'], ['observerId', 'evidenceSha256'], label);
  return Object.freeze({
    observerId: assertIdentifier(input.observerId, `${label}.observerId`),
    evidenceSha256: assertDigest(input.evidenceSha256, `${label}.evidenceSha256`),
  });
}

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<{ slot: string, instanceId: string, descriptorSha256: string, approvalId: string }>}
 */
export function validateStageGrant(raw, label = 'stageGrant') {
  const input = assertClosedObject(
    raw,
    ['slot', 'instanceId', 'descriptorSha256', 'approvalId'],
    ['slot', 'instanceId', 'descriptorSha256', 'approvalId'],
    label,
  );
  return Object.freeze({
    slot: assertIdentifier(input.slot, `${label}.slot`),
    instanceId: assertIdentifier(input.instanceId, `${label}.instanceId`),
    descriptorSha256: assertDigest(input.descriptorSha256, `${label}.descriptorSha256`),
    approvalId: assertIdentifier(input.approvalId, `${label}.approvalId`),
  });
}

const TRANSITION_FIELDS = Object.freeze([
  'descriptorSha256',
  'oldMembers',
  'targetMembers',
  'retirementEvidence',
  'prepareEvidence',
  'observerEvidence',
  'stageGrants',
  'abandonedTransitionId',
]);

/**
 * Validate the non-null `transition` object (architecture §9.1) and its internal
 * cross-references.
 *
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<object>}
 */
export function validateTransition(raw, label = 'transition') {
  const input = assertClosedObject(raw, TRANSITION_FIELDS, TRANSITION_FIELDS, label);
  const oldMembers = validateMembers(input.oldMembers, `${label}.oldMembers`);
  const targetMembers = validateMembers(input.targetMembers, `${label}.targetMembers`);
  const oldKeys = new Set(oldMembers.map((member) => `${member.slot}\u0000${member.instanceId}`));
  const targetKeys = new Set(targetMembers.map((member) => `${member.slot}\u0000${member.instanceId}`));

  /** @type {Readonly<object>[]} */
  const retirementEvidence = [];
  const retirementKeys = new Set();
  const retirementInput = assertArray(input.retirementEvidence, `${label}.retirementEvidence`);
  for (let index = 0; index < retirementInput.length; index += 1) {
    const evidence = validateRetirementEvidence(retirementInput[index], `${label}.retirementEvidence[${index}]`);
    const key = `${evidence.slot}\u0000${evidence.instanceId}\u0000${evidence.kind}`;
    if (retirementKeys.has(key)) {
      throw new ConfigError(`${label}.retirementEvidence duplicates ${evidence.slot}/${evidence.instanceId}/${evidence.kind}`, {
        field: `${label}.retirementEvidence`,
      });
    }
    retirementKeys.add(key);
    if (!oldKeys.has(`${evidence.slot}\u0000${evidence.instanceId}`)) {
      throw new ConfigError(
        `${label}.retirementEvidence references ${evidence.slot}/${evidence.instanceId} which is not an old member`,
        { field: `${label}.retirementEvidence` },
      );
    }
    retirementEvidence.push(evidence);
  }

  /** @type {Readonly<object>[]} */
  const stageGrants = [];
  const grantKeys = new Set();
  const grantInput = assertArray(input.stageGrants, `${label}.stageGrants`);
  for (let index = 0; index < grantInput.length; index += 1) {
    const grant = validateStageGrant(grantInput[index], `${label}.stageGrants[${index}]`);
    const key = `${grant.slot}\u0000${grant.instanceId}`;
    if (grantKeys.has(key)) {
      throw new ConfigError(`${label}.stageGrants duplicates ${grant.slot}/${grant.instanceId}`, {
        field: `${label}.stageGrants`,
      });
    }
    grantKeys.add(key);
    if (!oldKeys.has(key)) {
      throw new ConfigError(`${label}.stageGrants references ${grant.slot}/${grant.instanceId} which is not an old member`, {
        field: `${label}.stageGrants`,
      });
    }
    stageGrants.push(grant);
  }

  /** @type {Readonly<object>[]} */
  const prepareEvidence = [];
  const prepareKeys = new Set();
  const prepareInput = assertArray(input.prepareEvidence, `${label}.prepareEvidence`);
  for (let index = 0; index < prepareInput.length; index += 1) {
    const evidence = validatePrepareEvidence(prepareInput[index], `${label}.prepareEvidence[${index}]`);
    const key = `${evidence.slot}\u0000${evidence.instanceId}`;
    if (prepareKeys.has(key)) {
      throw new ConfigError(`${label}.prepareEvidence duplicates ${evidence.slot}/${evidence.instanceId}`, {
        field: `${label}.prepareEvidence`,
      });
    }
    prepareKeys.add(key);
    // A preparing participant is either a target-only registration or a retained
    // instance holding a trusted stage grant.
    if (!targetKeys.has(key) && !grantKeys.has(key)) {
      throw new ConfigError(
        `${label}.prepareEvidence references ${evidence.slot}/${evidence.instanceId} which is neither a target member nor a granted retained instance`,
        { field: `${label}.prepareEvidence` },
      );
    }
    prepareEvidence.push(evidence);
  }

  /** @type {Readonly<object>[]} */
  const observerEvidence = [];
  const observerIds = new Set();
  const observerInput = assertArray(input.observerEvidence, `${label}.observerEvidence`);
  for (let index = 0; index < observerInput.length; index += 1) {
    const evidence = validateObserverEvidence(observerInput[index], `${label}.observerEvidence[${index}]`);
    if (observerIds.has(evidence.observerId)) {
      throw new ConfigError(`${label}.observerEvidence duplicates ${evidence.observerId}`, {
        field: `${label}.observerEvidence`,
      });
    }
    observerIds.add(evidence.observerId);
    observerEvidence.push(evidence);
  }

  const abandonedTransitionId = input.abandonedTransitionId === null
    ? null
    : assertUuid(input.abandonedTransitionId, `${label}.abandonedTransitionId`);

  return Object.freeze({
    descriptorSha256: assertDigest(input.descriptorSha256, `${label}.descriptorSha256`),
    oldMembers,
    targetMembers,
    retirementEvidence: Object.freeze(retirementEvidence),
    prepareEvidence: Object.freeze(prepareEvidence),
    observerEvidence: Object.freeze(observerEvidence),
    stageGrants: Object.freeze(stageGrants),
    abandonedTransitionId,
  });
}

/** Closed field list for `ControlRecord`. */
export const CONTROL_RECORD_FIELDS = Object.freeze([
  'schemaVersion',
  'deploymentId',
  'revision',
  'generation',
  'nextGeneration',
  'phase',
  'active',
  'target',
  'transitionId',
  'inventory',
  'members',
  'highWaterGeneration',
  'approvalId',
  'releaseDescriptorSha256',
  'transition',
]);

/**
 * Validate a `ControlRecord` and all cross-field invariants that are provable
 * without reading referenced files.
 *
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateControlRecord(raw, options = {}) {
  const label = options.label ?? 'control record';
  const input = assertClosedObject(raw, CONTROL_RECORD_FIELDS, CONTROL_RECORD_FIELDS, label);
  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new ConfigError(`${label} schemaVersion must be 1 or 2`, { field: `${label}.schemaVersion` });
  }
  // Dual readers discriminate the version explicitly and never drop unknown
  // fields: a v2 record carries the joint skill/model binding.
  const validateBindingFor = schemaVersion === 2 ? validateBindingV2 : validateBinding;
  const deploymentId = assertUuid(input.deploymentId, `${label}.deploymentId`);
  const revision = assertNonNegativeInteger(input.revision, `${label}.revision`);
  const generation = assertNonNegativeInteger(input.generation, `${label}.generation`);
  const highWaterGeneration = assertNonNegativeInteger(input.highWaterGeneration, `${label}.highWaterGeneration`);
  if (highWaterGeneration < generation) {
    throw new ConfigError(`${label} highWaterGeneration must not be lower than generation`, {
      field: `${label}.highWaterGeneration`,
    });
  }
  const nextGeneration = input.nextGeneration === null
    ? null
    : assertPositiveInteger(input.nextGeneration, `${label}.nextGeneration`);
  const phase = assertEnum(input.phase, PHASES, `${label}.phase`);
  const active = input.active === null ? null : validateBindingFor(input.active, `${label}.active`);
  const target = input.target === null ? null : validateBindingFor(input.target, `${label}.target`);
  const transitionId = input.transitionId === null ? null : assertUuid(input.transitionId, `${label}.transitionId`);
  const inventory = validateInventory(input.inventory);
  const members = validateMembers(input.members, `${label}.members`);
  const approvalId = input.approvalId === null ? null : assertIdentifier(input.approvalId, `${label}.approvalId`);
  const releaseDescriptorSha256 = input.releaseDescriptorSha256 === null
    ? null
    : assertDigest(input.releaseDescriptorSha256, `${label}.releaseDescriptorSha256`);
  const transition = input.transition === null ? null : validateTransition(input.transition, `${label}.transition`);

  const enabledOperations = new Set();
  for (const entry of inventory) {
    if (entry.enabled) for (const operation of entry.operations) enabledOperations.add(operation);
  }

  if (phase === PHASE.ACTIVE) {
    if (active === null) throw new ConfigError(`${label} ACTIVE requires a committed binding`, { field: `${label}.active` });
    if (target !== null || transition !== null || transitionId !== null || nextGeneration !== null) {
      throw new ConfigError(`${label} ACTIVE must not carry transition fields`, { field: `${label}.phase` });
    }
    if (releaseDescriptorSha256 === null) {
      throw new ConfigError(`${label} ACTIVE requires the active release descriptor digest`, {
        field: `${label}.releaseDescriptorSha256`,
      });
    }
    if (enabledOperations.size === 0) {
      throw new ConfigError(`${label} ACTIVE inference release requires at least one enabled slot`, {
        field: `${label}.inventory`,
      });
    }
  }
  if (TRANSITION_PHASES.includes(phase)) {
    if (target === null || transition === null || transitionId === null || nextGeneration === null) {
      throw new ConfigError(`${label} ${phase} requires target binding, transition, transitionId and reservation`, {
        field: `${label}.phase`,
      });
    }
    if (nextGeneration !== highWaterGeneration) {
      throw new ConfigError(`${label} ${phase} reservation must equal highWaterGeneration`, {
        field: `${label}.nextGeneration`,
      });
    }
  }
  if (phase === PHASE.PAUSED) {
    // A paused *retained transition* keeps the target roster, reservation and
    // evidence for recovery; a paused bootstrap has no transition at all.
    const carriesTransition = transition !== null || target !== null || transitionId !== null || nextGeneration !== null;
    if (carriesTransition) {
      if (transition === null || target === null || transitionId === null || nextGeneration === null) {
        throw new ConfigError(
          `${label} PAUSED must retain the complete transition (target, transitionId, transition, reservation) or none of it`,
          { field: `${label}.phase` },
        );
      }
      if (nextGeneration !== highWaterGeneration) {
        throw new ConfigError(`${label} PAUSED reservation must equal highWaterGeneration`, {
          field: `${label}.nextGeneration`,
        });
      }
    }
  }

  /** @type {Map<string, Readonly<{ slot: string, enabled: boolean, operations: readonly string[] }>>} */
  const inventoryBySlot = new Map(inventory.map((entry) => [entry.slot, entry]));
  for (const member of members) {
    const entry = inventoryBySlot.get(member.slot);
    if (!entry) {
      throw new ConfigError(`${label} member ${member.slot} is not in the inventory`, { field: `${label}.members` });
    }
    if (!entry.enabled) {
      throw new ConfigError(`${label} member ${member.slot} belongs to a disabled slot`, { field: `${label}.members` });
    }
  }
  // Target membership is validated against the *target* inventory by the release
  // descriptor (registration and arm both do this); the committed inventory in
  // this record is the last ACTIVE roster, which may legitimately not contain a
  // newly added or differently named target slot.

  return Object.freeze({
    schemaVersion: schemaVersion === 2 ? 2 : 1,
    deploymentId,
    revision,
    generation,
    nextGeneration,
    phase,
    active,
    target,
    transitionId,
    inventory,
    members,
    highWaterGeneration,
    approvalId,
    releaseDescriptorSha256,
    transition,
  });
}

/**
 * Validate a control record and require the v2 schema. Used by the offline
 * migration path so a v1 record can never be silently treated as converted.
 *
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateControlRecordV2(raw, options = {}) {
  const label = options.label ?? 'control record';
  const record = validateControlRecord(raw, { label });
  if (record.schemaVersion !== 2) {
    throw new ConfigError(`${label} must use schemaVersion 2 after migration`, { field: `${label}.schemaVersion` });
  }
  return record;
}

/** Closed field list for an acknowledgement. */
export const ACK_FIELDS = Object.freeze([
  'schemaVersion',
  'deploymentId',
  'transitionId',
  'targetGeneration',
  'slot',
  'instanceId',
  'artifactSha256',
  'status',
  'manifestVersion',
  'manifestSha256',
  'capabilityProfileSha256',
  'inventorySha256',
  'outstandingWork',
  'pendingAIApprovals',
  'errorCode',
]);

/**
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateAck(raw, options = {}) {
  const label = options.label ?? 'ack';
  const input = assertClosedObject(raw, ACK_FIELDS, ACK_FIELDS, label);
  if (input.schemaVersion !== 1) {
    throw new ConfigError(`${label} schemaVersion must be exactly 1`, { field: `${label}.schemaVersion` });
  }
  const status = assertEnum(input.status, ACK_STATUSES, `${label}.status`);
  const outstandingWork = assertNonNegativeInteger(input.outstandingWork, `${label}.outstandingWork`);
  const pendingAIApprovals = assertNonNegativeInteger(input.pendingAIApprovals, `${label}.pendingAIApprovals`);
  const errorCode = input.errorCode === null
    ? null
    : assertEnum(input.errorCode, COORDINATION_ERROR_CODES, `${label}.errorCode`);
  if (status === ACK_STATUS.ERROR) {
    if (errorCode === null) throw new ConfigError(`${label} ERROR requires an errorCode`, { field: `${label}.errorCode` });
  } else {
    if (errorCode !== null) {
      throw new ConfigError(`${label} ${status} must not carry an errorCode`, { field: `${label}.errorCode` });
    }
    if (outstandingWork !== 0) {
      throw new ConfigError(`${label} ${status} requires outstandingWork 0`, { field: `${label}.outstandingWork` });
    }
    if (pendingAIApprovals !== 0) {
      throw new ConfigError(`${label} ${status} requires pendingAIApprovals 0`, { field: `${label}.pendingAIApprovals` });
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    deploymentId: assertUuid(input.deploymentId, `${label}.deploymentId`),
    transitionId: assertUuid(input.transitionId, `${label}.transitionId`),
    targetGeneration: assertPositiveInteger(input.targetGeneration, `${label}.targetGeneration`),
    slot: assertIdentifier(input.slot, `${label}.slot`),
    instanceId: assertIdentifier(input.instanceId, `${label}.instanceId`),
    artifactSha256: assertDigest(input.artifactSha256, `${label}.artifactSha256`),
    status,
    manifestVersion: assertIdentifier(input.manifestVersion, `${label}.manifestVersion`),
    manifestSha256: assertDigest(input.manifestSha256, `${label}.manifestSha256`),
    capabilityProfileSha256: assertDigest(input.capabilityProfileSha256, `${label}.capabilityProfileSha256`),
    inventorySha256: assertDigest(input.inventorySha256, `${label}.inventorySha256`),
    outstandingWork,
    pendingAIApprovals,
    errorCode,
  });
}

/** Closed field list for an observer validation receipt (architecture §9.1). */
export const OBSERVER_RECEIPT_FIELDS = Object.freeze([
  'schemaVersion',
  'deploymentId',
  'transitionId',
  'observerId',
  'artifactSha256',
  'manifestVersion',
  'manifestSha256',
  'capabilityProfileSha256',
  'status',
  'errorCode',
]);

/**
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateObserverReceipt(raw, options = {}) {
  const label = options.label ?? 'observer receipt';
  const input = assertClosedObject(raw, OBSERVER_RECEIPT_FIELDS, OBSERVER_RECEIPT_FIELDS, label);
  if (input.schemaVersion !== 1) {
    throw new ConfigError(`${label} schemaVersion must be exactly 1`, { field: `${label}.schemaVersion` });
  }
  const status = assertEnum(input.status, Object.values(OBSERVER_STATUS), `${label}.status`);
  const errorCode = input.errorCode === null
    ? null
    : assertEnum(input.errorCode, COORDINATION_ERROR_CODES, `${label}.errorCode`);
  if (status === OBSERVER_STATUS.ERROR && errorCode === null) {
    throw new ConfigError(`${label} ERROR requires an errorCode`, { field: `${label}.errorCode` });
  }
  if (status === OBSERVER_STATUS.VALIDATED && errorCode !== null) {
    throw new ConfigError(`${label} VALIDATED must not carry an errorCode`, { field: `${label}.errorCode` });
  }
  return Object.freeze({
    schemaVersion: 1,
    deploymentId: assertUuid(input.deploymentId, `${label}.deploymentId`),
    transitionId: assertUuid(input.transitionId, `${label}.transitionId`),
    observerId: assertIdentifier(input.observerId, `${label}.observerId`),
    artifactSha256: assertDigest(input.artifactSha256, `${label}.artifactSha256`),
    manifestVersion: assertIdentifier(input.manifestVersion, `${label}.manifestVersion`),
    manifestSha256: assertDigest(input.manifestSha256, `${label}.manifestSha256`),
    capabilityProfileSha256: assertDigest(input.capabilityProfileSha256, `${label}.capabilityProfileSha256`),
    status,
    errorCode,
  });
}

/** Closed field list for the immutable release descriptor (architecture §9.1). */
export const RELEASE_DESCRIPTOR_FIELDS = Object.freeze([
  'schemaVersion',
  'binding',
  'inventory',
  'artifacts',
  'observers',
  'approvalId',
]);

/**
 * Additional closed fields of a v2 release descriptor: the six package approval
 * references and the plan approval. They are part of the descriptor digest, so
 * an approval cannot be swapped after the fact.
 */
export const RELEASE_DESCRIPTOR_FIELDS_V2 = Object.freeze([
  ...RELEASE_DESCRIPTOR_FIELDS,
  'skillApprovalRefs',
  'planApprovalRef',
]);

const SKILL_APPROVAL_REF_FIELDS = Object.freeze(['packageDigestSha256', 'attestationSha256']);

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {Readonly<Record<string, Readonly<{ packageDigestSha256: string, attestationSha256: string }>>>}
 */
export function validateSkillApprovalRefs(raw, label = 'skillApprovalRefs') {
  const input = assertClosedObject(raw, [...AI_OPERATIONS], [...AI_OPERATIONS], label);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const operation of AI_OPERATIONS) {
    const at = `${label}.${operation}`;
    const entry = assertClosedObject(input[operation], SKILL_APPROVAL_REF_FIELDS, SKILL_APPROVAL_REF_FIELDS, at);
    out[operation] = Object.freeze({
      packageDigestSha256: assertDigest(entry.packageDigestSha256, `${at}.packageDigestSha256`),
      attestationSha256: assertDigest(entry.attestationSha256, `${at}.attestationSha256`),
    });
  }
  return Object.freeze(out);
}

/**
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateReleaseDescriptor(raw, options = {}) {
  const label = options.label ?? 'release descriptor';
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${label} must be an object`, { field: label });
  }
  const schemaVersion = /** @type {any} */ (raw).schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new ConfigError(`${label} schemaVersion must be 1 or 2`, { field: `${label}.schemaVersion` });
  }
  const fields = schemaVersion === 2 ? RELEASE_DESCRIPTOR_FIELDS_V2 : RELEASE_DESCRIPTOR_FIELDS;
  const input = assertClosedObject(raw, fields, fields, label);
  const inventory = validateInventory(input.inventory);
  const artifactSet = validateArtifactSet(input.artifacts, input.observers, inventory);
  const binding = schemaVersion === 2
    ? validateBindingV2(input.binding, `${label}.binding`)
    : validateBinding(input.binding, `${label}.binding`);
  if (binding.inventorySha256 !== computeInventoryDigest(inventory)) {
    throw new ConfigError(`${label} binding inventory digest does not match its inventory`, {
      field: `${label}.binding.inventorySha256`,
    });
  }
  const artifactSetSha256 = digestJson({ artifacts: artifactSet.artifacts, observers: artifactSet.observers }, {
    label: `${label} artifact set`,
  });
  if (binding.artifactSetSha256 !== artifactSetSha256) {
    throw new ConfigError(`${label} binding artifact-set digest does not match its artifacts`, {
      field: `${label}.binding.artifactSetSha256`,
    });
  }
  return Object.freeze({
    schemaVersion: schemaVersion === 2 ? 2 : 1,
    binding,
    inventory,
    artifacts: artifactSet.artifacts,
    observers: artifactSet.observers,
    approvalId: assertIdentifier(input.approvalId, `${label}.approvalId`),
    ...(schemaVersion === 2
      ? {
          skillApprovalRefs: validateSkillApprovalRefs(input.skillApprovalRefs, `${label}.skillApprovalRefs`),
          planApprovalRef: assertDigest(input.planApprovalRef, `${label}.planApprovalRef`),
        }
      : {}),
  });
}

/**
 * Digest of a validated descriptor (JCS, digest not part of the object).
 *
 * @param {unknown} descriptor
 * @returns {string}
 */
export function computeReleaseDescriptorDigest(descriptor) {
  return digestJson(validateReleaseDescriptor(descriptor), { label: 'release descriptor' });
}

/** Closed field list for FENCED operator evidence. */
export const FENCE_EVIDENCE_FIELDS = Object.freeze([
  'schemaVersion',
  'deploymentId',
  'transitionId',
  'slot',
  'instanceId',
  'operatorApprovalId',
  'processFenceEvidenceRef',
  'outcomeReconciliationRef',
]);

/**
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateFenceEvidence(raw, options = {}) {
  const label = options.label ?? 'fence evidence';
  const input = assertClosedObject(raw, FENCE_EVIDENCE_FIELDS, FENCE_EVIDENCE_FIELDS, label);
  if (input.schemaVersion !== 1) {
    throw new ConfigError(`${label} schemaVersion must be exactly 1`, { field: `${label}.schemaVersion` });
  }
  return Object.freeze({
    schemaVersion: 1,
    deploymentId: assertUuid(input.deploymentId, `${label}.deploymentId`),
    transitionId: assertUuid(input.transitionId, `${label}.transitionId`),
    slot: assertIdentifier(input.slot, `${label}.slot`),
    instanceId: assertIdentifier(input.instanceId, `${label}.instanceId`),
    operatorApprovalId: assertIdentifier(input.operatorApprovalId, `${label}.operatorApprovalId`),
    processFenceEvidenceRef: assertNonEmptyString(input.processFenceEvidenceRef, `${label}.processFenceEvidenceRef`),
    outcomeReconciliationRef: assertNonEmptyString(input.outcomeReconciliationRef, `${label}.outcomeReconciliationRef`),
  });
}

/**
 * True only for a lowercase 64-char digest.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDigest(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

/**
 * True only for a contract identifier.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}
