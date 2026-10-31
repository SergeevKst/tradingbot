/**
 * Pure validators for the v2 Skill release artifacts (architecture v1.1 §6–§7).
 *
 * Every artifact here is a closed, immutable JSON document addressed by a
 * canonical JCS digest:
 *
 *   - SkillRegistryV1    one exact package digest per operation (all six)
 *   - ExecutionPlanV1    six prepared operation plans (skill + model + policy)
 *   - RuntimePolicyV1    host grants, limits and reviewed capability evidence
 *   - trust-roots        Ed25519 public keys and their authorized roles
 *   - publication attestation / revocation records (signed envelopes)
 *
 * No file I/O, no credentials, no environment reads. Digests are computed over
 * validated bodies so a caller cannot smuggle unknown fields into an identity.
 *
 * @module config/skill-release-contracts
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { canonicalizeJson, digestJson, isPlainObject } from './jcs.mjs';
import { AI_OPERATIONS } from '../ai/operation-profiles.mjs';
import { DATA_SOURCE_CATALOGUE, SKILL_PACKAGE_LIMITS } from './skill-package.mjs';
import { structuralError } from '../errors/skill-error.mjs';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CONTRACT_ID_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Roles a trust-root key may carry. */
export const TRUST_ROLES = Object.freeze(['package-reviewer', 'plan-reviewer', 'release-authorizer']);

/** Closed set of control phases a v2 artifact may be activated from. */
export const ATTESTATION_ROLES = Object.freeze(['package-reviewer']);

// ─── Shared assertions ───────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} [cause]
 * @returns {string}
 */
function assertDigest(value, field, cause = 'SKILL_REGISTRY_INVALID') {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw structuralError(cause, `${field} must be a lowercase 64-character SHA-256 digest`, { field });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} [cause]
 * @returns {string}
 */
function assertIdentifier(value, field, cause = 'SKILL_REGISTRY_INVALID') {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw structuralError(cause, `${field} must match ${IDENTIFIER_PATTERN}`, { field });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} [cause]
 * @returns {string}
 */
function assertSemver(value, field, cause = 'SKILL_INCOMPATIBLE') {
  if (typeof value !== 'string' || !SEMVER_PATTERN.test(value)) {
    throw structuralError(cause, `${field} must be exact SemVer 2.0.0`, { field });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {string} field
 * @param {string} [cause]
 * @returns {number}
 */
function assertInt(value, min, max, field, cause = 'SKILL_REGISTRY_INVALID') {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < min || /** @type {number} */ (value) > max) {
    throw structuralError(cause, `${field} must be an integer in [${min}, ${max}]`, { field });
  }
  return /** @type {number} */ (value);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} field
 * @param {string} [cause]
 * @returns {string}
 */
function assertEnum(value, allowed, field, cause = 'SKILL_REGISTRY_INVALID') {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw structuralError(cause, `${field} must be one of ${allowed.join(', ')}`, { field });
  }
  return value;
}

/**
 * @param {unknown} raw
 * @param {string[]} allowed
 * @param {string[]} required
 * @param {string} label
 * @param {string} cause
 * @returns {Record<string, unknown>}
 */
function closedObject(raw, allowed, required, label, cause = 'SKILL_REGISTRY_INVALID') {
  if (!isPlainObject(raw)) {
    throw structuralError(cause, `${label} must be a JSON object`, { field: label });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw structuralError(cause, `${label} has an unknown field ${JSON.stringify(key)}`, { field: `${label}.${key}` });
    }
  }
  for (const key of required) {
    if (!(key in input)) {
      throw structuralError(cause, `${label} is missing required field ${JSON.stringify(key)}`, { field: `${label}.${key}` });
    }
  }
  return input;
}

// ─── Skill references and registry ───────────────────────────────────────────

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<{ packageId: string, version: string, packageDigestSha256: string }>}
 */
export function validateSkillRef(raw, label = 'skillRef') {
  const input = closedObject(
    raw,
    ['packageId', 'version', 'packageDigestSha256'],
    ['packageId', 'version', 'packageDigestSha256'],
    label,
  );
  if (typeof input.packageId !== 'string' || !PACKAGE_ID_PATTERN.test(input.packageId)) {
    throw structuralError('SKILL_REGISTRY_INVALID', `${label}.packageId must match ${PACKAGE_ID_PATTERN}`, {
      field: `${label}.packageId`,
    });
  }
  return Object.freeze({
    packageId: /** @type {string} */ (input.packageId),
    version: assertSemver(input.version, `${label}.version`, 'SKILL_REGISTRY_INVALID'),
    packageDigestSha256: assertDigest(input.packageDigestSha256, `${label}.packageDigestSha256`),
  });
}

/**
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateSkillRegistry(raw, options = {}) {
  const label = options.label ?? 'skill registry';
  const input = closedObject(raw, ['schemaVersion', 'registryId', 'operations'], ['schemaVersion', 'registryId', 'operations'], label);
  if (input.schemaVersion !== 1) {
    throw structuralError('SKILL_REGISTRY_INVALID', `${label}.schemaVersion must be exactly 1`, {
      field: `${label}.schemaVersion`,
    });
  }
  const registryId = assertIdentifier(input.registryId, `${label}.registryId`);
  if (!isPlainObject(input.operations)) {
    throw structuralError('SKILL_REGISTRY_INVALID', `${label}.operations must be an object`, { field: `${label}.operations` });
  }
  const operations = /** @type {Record<string, unknown>} */ (input.operations);
  for (const key of Object.keys(operations)) {
    if (!AI_OPERATIONS.includes(key)) {
      throw structuralError('SKILL_REGISTRY_INVALID', `${label}.operations has an unknown operation ${JSON.stringify(key)}`, {
        field: `${label}.operations.${key}`,
      });
    }
  }
  /** @type {Record<string, Readonly<object>>} */
  const validated = {};
  const seenDigests = new Map();
  for (const operation of AI_OPERATIONS) {
    if (!(operation in operations)) {
      throw structuralError('SKILL_MISSING', `${label} has no package mapping for ${operation}`, {
        field: `${label}.operations.${operation}`,
      });
    }
    const ref = validateSkillRef(operations[operation], `${label}.operations.${operation}`);
    if (seenDigests.has(ref.packageDigestSha256)) {
      throw structuralError(
        'SKILL_REGISTRY_INVALID',
        `${label} maps two operations to the same package digest (${seenDigests.get(ref.packageDigestSha256)} and ${operation})`,
        { field: `${label}.operations.${operation}` },
      );
    }
    seenDigests.set(ref.packageDigestSha256, operation);
    validated[operation] = ref;
  }
  return Object.freeze({ schemaVersion: 1, registryId, operations: Object.freeze(validated) });
}

/**
 * @param {unknown} registry validated registry
 * @returns {string}
 */
export function computeSkillRegistryDigest(registry) {
  return digestJson(validateSkillRegistry(registry), { label: 'skill registry' });
}

// ─── Trust roots and signed envelopes ────────────────────────────────────────

/**
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateTrustRoots(raw, options = {}) {
  const label = options.label ?? 'trust roots';
  const input = closedObject(raw, ['schemaVersion', 'keys'], ['schemaVersion', 'keys'], label);
  if (input.schemaVersion !== 1) {
    throw structuralError('SKILL_NOT_APPROVED', `${label}.schemaVersion must be exactly 1`, {
      field: `${label}.schemaVersion`,
    });
  }
  if (!Array.isArray(input.keys) || input.keys.length === 0 || input.keys.length > 32) {
    throw structuralError('SKILL_NOT_APPROVED', `${label}.keys must contain 1..32 keys`, { field: `${label}.keys` });
  }
  const keyIds = new Set();
  const keys = input.keys.map((rawKey, index) => {
    const at = `${label}.keys[${index}]`;
    const entry = closedObject(rawKey, ['keyId', 'algorithm', 'publicKeySpkiBase64', 'roles'], ['keyId', 'algorithm', 'publicKeySpkiBase64', 'roles'], at, 'SKILL_NOT_APPROVED');
    if (typeof entry.keyId !== 'string' || !KEY_ID_PATTERN.test(entry.keyId)) {
      throw structuralError('SKILL_NOT_APPROVED', `${at}.keyId must match ${KEY_ID_PATTERN}`, { field: `${at}.keyId` });
    }
    if (keyIds.has(entry.keyId)) {
      throw structuralError('SKILL_NOT_APPROVED', `${label} contains a duplicate keyId`, { field: `${at}.keyId` });
    }
    keyIds.add(entry.keyId);
    if (entry.algorithm !== 'Ed25519') {
      throw structuralError('SKILL_NOT_APPROVED', `${at}.algorithm must be Ed25519`, { field: `${at}.algorithm` });
    }
    if (typeof entry.publicKeySpkiBase64 !== 'string' || !BASE64_PATTERN.test(entry.publicKeySpkiBase64)) {
      throw structuralError('SKILL_NOT_APPROVED', `${at}.publicKeySpkiBase64 must be base64`, { field: `${at}.publicKeySpkiBase64` });
    }
    let der;
    try {
      der = Buffer.from(entry.publicKeySpkiBase64, 'base64');
    } catch {
      throw structuralError('SKILL_NOT_APPROVED', `${at}.publicKeySpkiBase64 is not decodable`, { field: `${at}.publicKeySpkiBase64` });
    }
    try {
      const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519') {
        throw new Error('not ed25519');
      }
    } catch {
      throw structuralError('SKILL_NOT_APPROVED', `${at}.publicKeySpkiBase64 is not an Ed25519 SPKI key`, {
        field: `${at}.publicKeySpkiBase64`,
      });
    }
    if (!Array.isArray(entry.roles) || entry.roles.length === 0) {
      throw structuralError('SKILL_NOT_APPROVED', `${at}.roles must be a non-empty array`, { field: `${at}.roles` });
    }
    const roles = entry.roles.map((role) => assertEnum(role, TRUST_ROLES, `${at}.roles`, 'SKILL_NOT_APPROVED'));
    if (new Set(roles).size !== roles.length) {
      throw structuralError('SKILL_NOT_APPROVED', `${at}.roles must be unique`, { field: `${at}.roles` });
    }
    return Object.freeze({
      keyId: entry.keyId,
      algorithm: /** @type {'Ed25519'} */ ('Ed25519'),
      publicKeySpkiBase64: entry.publicKeySpkiBase64,
      roles: Object.freeze(roles),
    });
  });
  keys.sort((a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0));
  return Object.freeze({ schemaVersion: 1, keys: Object.freeze(keys) });
}

/**
 * @param {unknown} trustRoots
 * @returns {string}
 */
export function computeTrustRootsDigest(trustRoots) {
  return digestJson(validateTrustRoots(trustRoots), { label: 'trust roots' });
}

/**
 * Verify a signed envelope against a trust-root document and required role.
 * The signature covers the JCS bytes of `payload` only, so the envelope can
 * never authorize itself.
 *
 * @param {unknown} raw
 * @param {{ trustRoots: unknown, roles: readonly string[], label?: string }} input
 * @returns {Readonly<{ keyId: string, payload: Readonly<object> }>}
 */
export function verifySignedEnvelope(raw, input) {
  const label = input.label ?? 'signed envelope';
  const envelope = closedObject(raw, ['payload', 'keyId', 'algorithm', 'signatureBase64'], ['payload', 'keyId', 'algorithm', 'signatureBase64'], label, 'SKILL_NOT_APPROVED');
  if (envelope.algorithm !== 'Ed25519') {
    throw structuralError('SKILL_NOT_APPROVED', `${label}.algorithm must be Ed25519`, { field: `${label}.algorithm` });
  }
  if (typeof envelope.keyId !== 'string' || !KEY_ID_PATTERN.test(envelope.keyId)) {
    throw structuralError('SKILL_NOT_APPROVED', `${label}.keyId must match ${KEY_ID_PATTERN}`, { field: `${label}.keyId` });
  }
  if (typeof envelope.signatureBase64 !== 'string' || !BASE64_PATTERN.test(envelope.signatureBase64)) {
    throw structuralError('SKILL_NOT_APPROVED', `${label}.signatureBase64 must be base64`, { field: `${label}.signatureBase64` });
  }
  if (!isPlainObject(envelope.payload)) {
    throw structuralError('SKILL_NOT_APPROVED', `${label}.payload must be an object`, { field: `${label}.payload` });
  }
  const roots = validateTrustRoots(input.trustRoots);
  const key = roots.keys.find((entry) => entry.keyId === envelope.keyId);
  if (!key) {
    throw structuralError('SKILL_NOT_APPROVED', `${label}.keyId is not an authorized trust-root key`, { field: `${label}.keyId` });
  }
  if (!input.roles.some((role) => key.roles.includes(role))) {
    throw structuralError('SKILL_NOT_APPROVED', `${label}.keyId is not authorized for this action`, { field: `${label}.keyId` });
  }
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpkiBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const signed = Buffer.from(canonicalizeJson(envelope.payload, { label: `${label}.payload` }), 'utf8');
  const signature = Buffer.from(envelope.signatureBase64, 'base64');
  let ok = false;
  try {
    ok = cryptoVerify(null, signed, publicKey, signature);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw structuralError('SKILL_NOT_APPROVED', `${label} signature does not verify`, { field: `${label}.signatureBase64` });
  }
  return Object.freeze({ keyId: /** @type {string} */ (envelope.keyId), payload: /** @type {Readonly<object>} */ (envelope.payload) });
}

// ─── Publication attestation and revocation ──────────────────────────────────

const ATTESTATION_PAYLOAD_FIELDS = Object.freeze([
  'schemaVersion',
  'packageRef',
  'packageIndexSha256',
  'authorId',
  'reviewerId',
  'reviewedAt',
  'reviewStatus',
  'testReportSha256',
  'comparisonReportSha256',
  'sourceRevision',
  'approvedBotRange',
]);

/**
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateAttestationPayload(raw, options = {}) {
  const label = options.label ?? 'publication attestation';
  const input = closedObject(raw, ATTESTATION_PAYLOAD_FIELDS, ATTESTATION_PAYLOAD_FIELDS, label, 'SKILL_NOT_APPROVED');
  if (input.schemaVersion !== 1) {
    throw structuralError('SKILL_NOT_APPROVED', `${label}.schemaVersion must be exactly 1`, { field: `${label}.schemaVersion` });
  }
  const packageRef = validateSkillRef(input.packageRef, `${label}.packageRef`);
  const packageIndexSha256 = assertDigest(input.packageIndexSha256, `${label}.packageIndexSha256`, 'SKILL_NOT_APPROVED');
  if (packageIndexSha256 !== packageRef.packageDigestSha256) {
    throw structuralError('SKILL_INTEGRITY_MISMATCH', `${label}.packageIndexSha256 does not match the referenced package digest`, {
      field: `${label}.packageIndexSha256`,
    });
  }
  const authorId = assertIdentifier(input.authorId, `${label}.authorId`, 'SKILL_NOT_APPROVED');
  const reviewerId = assertIdentifier(input.reviewerId, `${label}.reviewerId`, 'SKILL_NOT_APPROVED');
  if (authorId === reviewerId) {
    throw structuralError('SKILL_NOT_APPROVED', `${label} must be reviewed by someone other than the author`, {
      field: `${label}.reviewerId`,
    });
  }
  if (typeof input.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input.reviewedAt)) {
    throw structuralError('SKILL_NOT_APPROVED', `${label}.reviewedAt must be RFC3339 UTC`, { field: `${label}.reviewedAt` });
  }
  if (input.reviewStatus !== 'APPROVED') {
    throw structuralError('SKILL_NOT_APPROVED', `${label}.reviewStatus must be APPROVED`, { field: `${label}.reviewStatus` });
  }
  if (typeof input.approvedBotRange !== 'string' || !/^>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+$/.test(input.approvedBotRange)) {
    throw structuralError('SKILL_NOT_APPROVED', `${label}.approvedBotRange must use the ">=x.y.z <x.y.z" grammar`, {
      field: `${label}.approvedBotRange`,
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    packageRef,
    packageIndexSha256,
    authorId,
    reviewerId,
    reviewedAt: /** @type {string} */ (input.reviewedAt),
    reviewStatus: /** @type {'APPROVED'} */ ('APPROVED'),
    testReportSha256: assertDigest(input.testReportSha256, `${label}.testReportSha256`, 'SKILL_NOT_APPROVED'),
    comparisonReportSha256: assertDigest(input.comparisonReportSha256, `${label}.comparisonReportSha256`, 'SKILL_NOT_APPROVED'),
    sourceRevision: assertIdentifier(input.sourceRevision, `${label}.sourceRevision`, 'SKILL_NOT_APPROVED'),
    approvedBotRange: /** @type {string} */ (input.approvedBotRange),
  });
}

/**
 * Verify a publication attestation envelope and return its validated payload.
 *
 * @param {unknown} envelope
 * @param {{ trustRoots: unknown, packageRef?: unknown, label?: string }} input
 * @returns {Readonly<object>}
 */
export function verifyPublicationAttestation(envelope, input) {
  const verified = verifySignedEnvelope(envelope, {
    trustRoots: input.trustRoots,
    roles: ATTESTATION_ROLES,
    label: input.label ?? 'publication attestation',
  });
  const payload = validateAttestationPayload(verified.payload, { label: input.label ?? 'publication attestation' });
  if (input.packageRef !== undefined) {
    const expected = validateSkillRef(input.packageRef, 'expected packageRef');
    if (
      payload.packageRef.packageId !== expected.packageId ||
      payload.packageRef.version !== expected.version ||
      payload.packageRef.packageDigestSha256 !== expected.packageDigestSha256
    ) {
      throw structuralError('SKILL_NOT_APPROVED', 'publication attestation references a different package', {
        field: 'packageRef',
      });
    }
  }
  return payload;
}

const REVOCATION_FIELDS = Object.freeze(['schemaVersion', 'packageRef', 'revokedAt', 'operatorApprovalId']);

/**
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateRevocationRecord(raw, options = {}) {
  const label = options.label ?? 'revocation record';
  const input = closedObject(raw, REVOCATION_FIELDS, REVOCATION_FIELDS, label, 'SKILL_REVOKED');
  if (input.schemaVersion !== 1) {
    throw structuralError('SKILL_REVOKED', `${label}.schemaVersion must be exactly 1`, { field: `${label}.schemaVersion` });
  }
  if (typeof input.revokedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input.revokedAt)) {
    throw structuralError('SKILL_REVOKED', `${label}.revokedAt must be RFC3339 UTC`, { field: `${label}.revokedAt` });
  }
  return Object.freeze({
    schemaVersion: 1,
    packageRef: validateSkillRef(input.packageRef, `${label}.packageRef`),
    revokedAt: /** @type {string} */ (input.revokedAt),
    operatorApprovalId: assertIdentifier(input.operatorApprovalId, `${label}.operatorApprovalId`, 'SKILL_REVOKED'),
  });
}

/**
 * @param {unknown} envelope
 * @param {{ trustRoots: unknown, packageRef?: unknown }} input
 * @returns {Readonly<object>}
 */
export function verifyRevocation(envelope, input) {
  const verified = verifySignedEnvelope(envelope, {
    trustRoots: input.trustRoots,
    roles: ['release-authorizer'],
    label: 'revocation record',
  });
  const payload = validateRevocationRecord(verified.payload);
  if (input.packageRef !== undefined) {
    const expected = validateSkillRef(input.packageRef, 'expected packageRef');
    if (payload.packageRef.packageDigestSha256 !== expected.packageDigestSha256) {
      throw structuralError('SKILL_REVOKED', 'revocation references a different package', { field: 'packageRef' });
    }
  }
  return payload;
}

// ─── Artifact identity and capability evidence ───────────────────────────────

const ARTIFACT_FIELDS = Object.freeze([
  'artifactSha256',
  'botVersion',
  'skillApiVersion',
  'adapterCatalogueSha256',
  'hostContractCatalogueSha256',
]);

/**
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateArtifactIdentity(raw, options = {}) {
  const label = options.label ?? 'artifact identity';
  const input = closedObject(raw, ARTIFACT_FIELDS, ARTIFACT_FIELDS, label, 'SKILL_INCOMPATIBLE');
  return Object.freeze({
    artifactSha256: assertDigest(input.artifactSha256, `${label}.artifactSha256`, 'SKILL_INCOMPATIBLE'),
    botVersion: assertSemver(input.botVersion, `${label}.botVersion`, 'SKILL_INCOMPATIBLE'),
    skillApiVersion: assertInt(input.skillApiVersion, 1, 1, `${label}.skillApiVersion`, 'SKILL_INCOMPATIBLE'),
    adapterCatalogueSha256: assertDigest(input.adapterCatalogueSha256, `${label}.adapterCatalogueSha256`, 'SKILL_INCOMPATIBLE'),
    hostContractCatalogueSha256: assertDigest(input.hostContractCatalogueSha256, `${label}.hostContractCatalogueSha256`, 'SKILL_INCOMPATIBLE'),
  });
}

const EVIDENCE_FIELDS = Object.freeze([
  'schemaVersion',
  'modelIdentitySha256',
  'adapterId',
  'adapterContractVersion',
  'temperature',
  'responseFormats',
  'reasoningEfforts',
  'maxOutputTokens',
  'contextWindow',
  'endpointSupport',
  'testArtifactSha256',
  'reviewId',
]);

const ENDPOINT_FIELDS = Object.freeze(['host', 'path']);

/**
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateCapabilityEvidence(raw, options = {}) {
  const label = options.label ?? 'capability evidence';
  const input = closedObject(raw, EVIDENCE_FIELDS, EVIDENCE_FIELDS, label, 'SKILL_CAPABILITY_MISMATCH');
  if (input.schemaVersion !== 1) {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `${label}.schemaVersion must be exactly 1`, {
      field: `${label}.schemaVersion`,
    });
  }
  const temperature = closedObject(input.temperature, ['min', 'max'], ['min', 'max'], `${label}.temperature`, 'SKILL_CAPABILITY_MISMATCH');
  const min = temperature.min;
  const max = temperature.max;
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `${label}.temperature must be a finite range`, {
      field: `${label}.temperature`,
    });
  }
  if (!Array.isArray(input.responseFormats) || input.responseFormats.length === 0) {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `${label}.responseFormats must be non-empty`, {
      field: `${label}.responseFormats`,
    });
  }
  const responseFormats = input.responseFormats.map((value) =>
    assertEnum(value, ['json_object', 'text'], `${label}.responseFormats`, 'SKILL_CAPABILITY_MISMATCH'),
  );
  if (!Array.isArray(input.reasoningEfforts) || input.reasoningEfforts.length === 0) {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `${label}.reasoningEfforts must be non-empty`, {
      field: `${label}.reasoningEfforts`,
    });
  }
  const reasoningEfforts = input.reasoningEfforts.map((value) => {
    if (value === null) return null;
    return assertEnum(value, ['low', 'medium', 'high'], `${label}.reasoningEfforts`, 'SKILL_CAPABILITY_MISMATCH');
  });
  if (!Array.isArray(input.endpointSupport) || input.endpointSupport.length === 0) {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `${label}.endpointSupport must be non-empty`, {
      field: `${label}.endpointSupport`,
    });
  }
  const endpointSupport = input.endpointSupport.map((rawEndpoint, index) => {
    const at = `${label}.endpointSupport[${index}]`;
    const endpoint = closedObject(rawEndpoint, ENDPOINT_FIELDS, ENDPOINT_FIELDS, at, 'SKILL_CAPABILITY_MISMATCH');
    if (typeof endpoint.host !== 'string' || !HOST_PATTERN.test(endpoint.host)) {
      throw structuralError('SKILL_CAPABILITY_MISMATCH', `${at}.host must be a bare hostname`, { field: `${at}.host` });
    }
    if (typeof endpoint.path !== 'string' || !/^\/[A-Za-z0-9/._-]{0,127}$/.test(endpoint.path)) {
      throw structuralError('SKILL_CAPABILITY_MISMATCH', `${at}.path must be an absolute path`, { field: `${at}.path` });
    }
    return Object.freeze({ host: endpoint.host, path: endpoint.path });
  });
  return Object.freeze({
    schemaVersion: 1,
    modelIdentitySha256: assertDigest(input.modelIdentitySha256, `${label}.modelIdentitySha256`, 'SKILL_CAPABILITY_MISMATCH'),
    adapterId: assertIdentifier(input.adapterId, `${label}.adapterId`, 'SKILL_CAPABILITY_MISMATCH'),
    adapterContractVersion: assertInt(input.adapterContractVersion, 1, 1, `${label}.adapterContractVersion`, 'SKILL_CAPABILITY_MISMATCH'),
    temperature: Object.freeze({ min, max }),
    responseFormats: Object.freeze(responseFormats),
    reasoningEfforts: Object.freeze(reasoningEfforts),
    maxOutputTokens: assertInt(input.maxOutputTokens, 1, 1_000_000, `${label}.maxOutputTokens`, 'SKILL_CAPABILITY_MISMATCH'),
    contextWindow: assertInt(input.contextWindow, 1, 100_000_000, `${label}.contextWindow`, 'SKILL_CAPABILITY_MISMATCH'),
    endpointSupport: Object.freeze(endpointSupport),
    testArtifactSha256: assertDigest(input.testArtifactSha256, `${label}.testArtifactSha256`, 'SKILL_CAPABILITY_MISMATCH'),
    reviewId: assertIdentifier(input.reviewId, `${label}.reviewId`, 'SKILL_CAPABILITY_MISMATCH'),
  });
}

/**
 * @param {unknown} evidence
 * @returns {string}
 */
export function computeCapabilityEvidenceDigest(evidence) {
  return digestJson(validateCapabilityEvidence(evidence), { label: 'capability evidence' });
}

// ─── Runtime policy ──────────────────────────────────────────────────────────

const POLICY_FIELDS = Object.freeze(['schemaVersion', 'operationGrants', 'limits', 'capabilityEvidence', 'trustRootsSha256']);
const GRANT_FIELDS = Object.freeze(['dataSources', 'allowedTools']);
const HOST_LIMIT_FIELDS = Object.freeze([
  'maxInputBytes',
  'maxOutputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'maxModelCalls',
  'maxToolCalls',
  'maxConcurrentByOperation',
]);

/**
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateRuntimePolicy(raw, options = {}) {
  const label = options.label ?? 'runtime policy';
  const input = closedObject(raw, POLICY_FIELDS, POLICY_FIELDS, label, 'SKILL_POLICY_DENIED');
  if (input.schemaVersion !== 1) {
    throw structuralError('SKILL_POLICY_DENIED', `${label}.schemaVersion must be exactly 1`, {
      field: `${label}.schemaVersion`,
    });
  }
  if (!isPlainObject(input.operationGrants)) {
    throw structuralError('SKILL_POLICY_DENIED', `${label}.operationGrants must be an object`, {
      field: `${label}.operationGrants`,
    });
  }
  const grantsInput = /** @type {Record<string, unknown>} */ (input.operationGrants);
  for (const key of Object.keys(grantsInput)) {
    if (!AI_OPERATIONS.includes(key)) {
      throw structuralError('SKILL_POLICY_DENIED', `${label}.operationGrants has an unknown operation`, {
        field: `${label}.operationGrants.${key}`,
      });
    }
  }
  /** @type {Record<string, Readonly<object>>} */
  const operationGrants = {};
  for (const operation of AI_OPERATIONS) {
    if (!(operation in grantsInput)) {
      throw structuralError('SKILL_POLICY_DENIED', `${label}.operationGrants is missing ${operation}`, {
        field: `${label}.operationGrants.${operation}`,
      });
    }
    const at = `${label}.operationGrants.${operation}`;
    const grant = closedObject(grantsInput[operation], GRANT_FIELDS, GRANT_FIELDS, at, 'SKILL_POLICY_DENIED');
    if (!Array.isArray(grant.dataSources)) {
      throw structuralError('SKILL_POLICY_DENIED', `${at}.dataSources must be an array`, { field: `${at}.dataSources` });
    }
    const allowed = DATA_SOURCE_CATALOGUE[operation];
    const dataSources = grant.dataSources.map((source, index) => {
      if (typeof source !== 'string' || !allowed.includes(source)) {
        throw structuralError('SKILL_POLICY_DENIED', `${at}.dataSources grants an unknown capability`, {
          field: `${at}.dataSources[${index}]`,
        });
      }
      return source;
    });
    if (new Set(dataSources).size !== dataSources.length) {
      throw structuralError('SKILL_POLICY_DENIED', `${at}.dataSources must be unique`, { field: `${at}.dataSources` });
    }
    if (!Array.isArray(grant.allowedTools) || grant.allowedTools.length !== 0) {
      throw structuralError('SKILL_POLICY_DENIED', `${at}.allowedTools must be empty in v2.0`, {
        field: `${at}.allowedTools`,
      });
    }
    operationGrants[operation] = Object.freeze({ dataSources: Object.freeze(dataSources), allowedTools: Object.freeze([]) });
  }

  const limits = closedObject(input.limits, HOST_LIMIT_FIELDS, HOST_LIMIT_FIELDS, `${label}.limits`, 'SKILL_POLICY_DENIED');
  const concurrencyInput = limits.maxConcurrentByOperation;
  if (!isPlainObject(concurrencyInput)) {
    throw structuralError('SKILL_POLICY_DENIED', `${label}.limits.maxConcurrentByOperation must be an object`, {
      field: `${label}.limits.maxConcurrentByOperation`,
    });
  }
  /** @type {Record<string, number>} */
  const maxConcurrentByOperation = {};
  for (const operation of AI_OPERATIONS) {
    if (!(operation in /** @type {any} */ (concurrencyInput))) {
      throw structuralError('SKILL_POLICY_DENIED', `${label}.limits.maxConcurrentByOperation is missing ${operation}`, {
        field: `${label}.limits.maxConcurrentByOperation.${operation}`,
      });
    }
    maxConcurrentByOperation[operation] = assertInt(
      /** @type {any} */ (concurrencyInput)[operation],
      1,
      64,
      `${label}.limits.maxConcurrentByOperation.${operation}`,
      'SKILL_POLICY_DENIED',
    );
  }
  for (const key of Object.keys(/** @type {any} */ (concurrencyInput))) {
    if (!AI_OPERATIONS.includes(key)) {
      throw structuralError('SKILL_POLICY_DENIED', `${label}.limits.maxConcurrentByOperation has an unknown operation`, {
        field: `${label}.limits.maxConcurrentByOperation.${key}`,
      });
    }
  }
  const validatedLimits = Object.freeze({
    maxInputBytes: assertInt(limits.maxInputBytes, 1, SKILL_PACKAGE_LIMITS.maxFileBytes, `${label}.limits.maxInputBytes`, 'SKILL_POLICY_DENIED'),
    maxOutputBytes: assertInt(limits.maxOutputBytes, 1, SKILL_PACKAGE_LIMITS.maxFileBytes, `${label}.limits.maxOutputBytes`, 'SKILL_POLICY_DENIED'),
    maxOutputTokens: assertInt(limits.maxOutputTokens, 1, 1_000_000, `${label}.limits.maxOutputTokens`, 'SKILL_POLICY_DENIED'),
    timeoutMs: assertInt(limits.timeoutMs, 1, 600_000, `${label}.limits.timeoutMs`, 'SKILL_POLICY_DENIED'),
    maxModelCalls: assertInt(limits.maxModelCalls, 1, 1, `${label}.limits.maxModelCalls`, 'SKILL_POLICY_DENIED'),
    maxToolCalls: assertInt(limits.maxToolCalls, 0, 0, `${label}.limits.maxToolCalls`, 'SKILL_POLICY_DENIED'),
    maxConcurrentByOperation: Object.freeze(maxConcurrentByOperation),
  });

  if (!isPlainObject(input.capabilityEvidence)) {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `${label}.capabilityEvidence must be an object`, {
      field: `${label}.capabilityEvidence`,
    });
  }
  /** @type {Record<string, Readonly<object>>} */
  const capabilityEvidence = {};
  for (const [identity, rawEntry] of Object.entries(/** @type {Record<string, unknown>} */ (input.capabilityEvidence))) {
    const at = `${label}.capabilityEvidence.${identity}`;
    assertDigest(identity, at, 'SKILL_CAPABILITY_MISMATCH');
    const entry = closedObject(rawEntry, ['evidenceSha256', 'adapterId', 'adapterContractVersion'], ['evidenceSha256', 'adapterId', 'adapterContractVersion'], at, 'SKILL_CAPABILITY_MISMATCH');
    capabilityEvidence[identity] = Object.freeze({
      evidenceSha256: assertDigest(entry.evidenceSha256, `${at}.evidenceSha256`, 'SKILL_CAPABILITY_MISMATCH'),
      adapterId: assertIdentifier(entry.adapterId, `${at}.adapterId`, 'SKILL_CAPABILITY_MISMATCH'),
      adapterContractVersion: assertInt(entry.adapterContractVersion, 1, 1, `${at}.adapterContractVersion`, 'SKILL_CAPABILITY_MISMATCH'),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    operationGrants: Object.freeze(operationGrants),
    limits: validatedLimits,
    capabilityEvidence: Object.freeze(capabilityEvidence),
    trustRootsSha256: assertDigest(input.trustRootsSha256, `${label}.trustRootsSha256`, 'SKILL_POLICY_DENIED'),
  });
}

/**
 * @param {unknown} policy
 * @returns {string}
 */
export function computeRuntimePolicyDigest(policy) {
  return digestJson(validateRuntimePolicy(policy), { label: 'runtime policy' });
}

// ─── Execution plan ──────────────────────────────────────────────────────────

const PLAN_FIELDS = Object.freeze([
  'schemaVersion',
  'skillRegistrySha256',
  'modelRegistrySha256',
  'runtimePolicySha256',
  'operations',
]);

const OPERATION_PLAN_FIELDS = Object.freeze([
  'operation',
  'skill',
  'modelKey',
  'modelIdentitySha256',
  'profileSha256',
  'adapterId',
  'adapterContractVersion',
  'settingsSha256',
  'capabilityEvidenceSha256',
  'effectivePolicySha256',
  'inputContract',
  'outputContract',
]);

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {Readonly<{ id: string, version: string }>}
 */
function validateContractRef(raw, label) {
  const input = closedObject(raw, ['id', 'version'], ['id', 'version'], label, 'SKILL_INCOMPATIBLE');
  if (typeof input.id !== 'string' || !CONTRACT_ID_PATTERN.test(input.id)) {
    throw structuralError('SKILL_INCOMPATIBLE', `${label}.id must match ${CONTRACT_ID_PATTERN}`, { field: `${label}.id` });
  }
  return Object.freeze({
    id: /** @type {string} */ (input.id),
    version: assertSemver(input.version, `${label}.version`, 'SKILL_INCOMPATIBLE'),
  });
}

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<object>}
 */
export function validateOperationPlan(raw, label = 'operation plan') {
  const input = closedObject(raw, OPERATION_PLAN_FIELDS, OPERATION_PLAN_FIELDS, label, 'SKILL_REGISTRY_INVALID');
  return Object.freeze({
    operation: assertEnum(input.operation, AI_OPERATIONS, `${label}.operation`),
    skill: validateSkillRef(input.skill, `${label}.skill`),
    modelKey: assertIdentifier(input.modelKey, `${label}.modelKey`),
    modelIdentitySha256: assertDigest(input.modelIdentitySha256, `${label}.modelIdentitySha256`),
    profileSha256: assertDigest(input.profileSha256, `${label}.profileSha256`),
    adapterId: assertIdentifier(input.adapterId, `${label}.adapterId`),
    adapterContractVersion: assertInt(input.adapterContractVersion, 1, 1, `${label}.adapterContractVersion`),
    settingsSha256: assertDigest(input.settingsSha256, `${label}.settingsSha256`),
    capabilityEvidenceSha256: assertDigest(input.capabilityEvidenceSha256, `${label}.capabilityEvidenceSha256`),
    effectivePolicySha256: assertDigest(input.effectivePolicySha256, `${label}.effectivePolicySha256`),
    inputContract: validateContractRef(input.inputContract, `${label}.inputContract`),
    outputContract: validateContractRef(input.outputContract, `${label}.outputContract`),
  });
}

/**
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validateExecutionPlan(raw, options = {}) {
  const label = options.label ?? 'execution plan';
  const input = closedObject(raw, PLAN_FIELDS, PLAN_FIELDS, label, 'SKILL_REGISTRY_INVALID');
  if (input.schemaVersion !== 1) {
    throw structuralError('SKILL_REGISTRY_INVALID', `${label}.schemaVersion must be exactly 1`, {
      field: `${label}.schemaVersion`,
    });
  }
  if (!isPlainObject(input.operations)) {
    throw structuralError('SKILL_REGISTRY_INVALID', `${label}.operations must be an object`, {
      field: `${label}.operations`,
    });
  }
  const operationsInput = /** @type {Record<string, unknown>} */ (input.operations);
  for (const key of Object.keys(operationsInput)) {
    if (!AI_OPERATIONS.includes(key)) {
      throw structuralError('SKILL_REGISTRY_INVALID', `${label}.operations has an unknown operation`, {
        field: `${label}.operations.${key}`,
      });
    }
  }
  /** @type {Record<string, Readonly<object>>} */
  const operations = {};
  for (const operation of AI_OPERATIONS) {
    if (!(operation in operationsInput)) {
      throw structuralError('SKILL_MISSING', `${label} has no plan entry for ${operation}`, {
        field: `${label}.operations.${operation}`,
      });
    }
    const entry = validateOperationPlan(operationsInput[operation], `${label}.operations.${operation}`);
    if (entry.operation !== operation) {
      throw structuralError('SKILL_REGISTRY_INVALID', `${label}.operations.${operation} declares operation ${entry.operation}`, {
        field: `${label}.operations.${operation}.operation`,
      });
    }
    operations[operation] = entry;
  }
  return Object.freeze({
    schemaVersion: 1,
    skillRegistrySha256: assertDigest(input.skillRegistrySha256, `${label}.skillRegistrySha256`),
    modelRegistrySha256: assertDigest(input.modelRegistrySha256, `${label}.modelRegistrySha256`),
    runtimePolicySha256: assertDigest(input.runtimePolicySha256, `${label}.runtimePolicySha256`),
    operations: Object.freeze(operations),
  });
}

/**
 * @param {unknown} plan
 * @returns {string}
 */
export function computeExecutionPlanDigest(plan) {
  return digestJson(validateExecutionPlan(plan), { label: 'execution plan' });
}

/**
 * New canonical model identity (architecture §6.1). This deliberately does not
 * reuse the v1 `JSON.stringify` triple hash.
 *
 * @param {{ providerId: string, modelId: string, canonicalBaseUrl: string, trustTier: string, capabilityProfileSha256: string }} identity
 * @returns {string}
 */
export function computeModelIdentitySha256(identity) {
  return digestJson(
    {
      providerId: identity.providerId,
      modelId: identity.modelId,
      canonicalBaseUrl: identity.canonicalBaseUrl,
      trustTier: identity.trustTier,
      capabilityProfileSha256: identity.capabilityProfileSha256,
    },
    { label: 'model identity' },
  );
}

/** Exported for admin tooling that must discriminate plain objects. */
export { isPlainObject as isPlainReleaseObject };
