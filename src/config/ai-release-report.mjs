/**
 * Machine-readable release report (UAI-09, architecture §4 "Release gates and
 * report contract").
 *
 * Closed schema, `schemaVersion: 1`. A report is evidence, not authority: every
 * count and hash must derive from an actual trace or file, `NOT_RUN` is never
 * `PASS`, and `ACTIVATION_VERIFIED` cannot be produced offline.
 *
 * @module config/ai-release-report
 */
import { ConfigError } from './config-error.mjs';
import { isPlainObject } from './jcs.mjs';
import {
  COORDINATION_ERROR_CODE,
  validateBinding,
  validateInventory,
  assertClosedObject as assertClosed,
} from './ai-release-schema.mjs';
import { assertDigest, assertIdentifier } from './ai-identity-manifest.mjs';

export const REPORT_SCHEMA_VERSION = 1;

export const GATE = Object.freeze({
  G1: 'G1_BASELINE_COMPATIBILITY',
  G2: 'G2_CROSS_PROCESS',
  G3: 'G3_ARTIFACT_CONFIG',
  G4: 'G4_TOPOLOGY_SAFETY',
  G5: 'G5_REHEARSAL',
  G6: 'G6_HUMAN_AUTHORIZATION',
  G7: 'G7_ACTUAL_RELEASE_VERIFICATION',
});

export const GATES = Object.freeze(Object.values(GATE));

/** The conformance matrix that must be complete in any dossier. */
export const XP_IDS = Object.freeze(Array.from({ length: 18 }, (_, index) => `XP-${String(index + 1).padStart(2, '0')}`));

export const TEST_STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', NOT_RUN: 'NOT_RUN' });

export const CONCLUSION = Object.freeze({
  OFFLINE_CONFORMANT: 'OFFLINE_CONFORMANT',
  READY_FOR_OPERATOR_APPROVAL: 'READY_FOR_OPERATOR_APPROVAL',
  ACTIVATION_VERIFIED: 'ACTIVATION_VERIFIED',
  BLOCKED: 'BLOCKED',
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function assertNonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${field} must be a non-empty string`, { field });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string | null}
 */
function nullableRef(value, field) {
  if (value === null) return null;
  return assertNonEmpty(value, field);
}

/**
 * @param {unknown} raw
 * @returns {Readonly<object>}
 */
export function validateArtifactSetEntry(raw, field = 'artifactSet[]') {
  const input = assertClosed(raw, ['slot', 'artifactSha256', 'sourceCommit'], ['slot', 'artifactSha256', 'sourceCommit'], field);
  const sourceCommit = input.sourceCommit === null
    ? null
    : (typeof input.sourceCommit === 'string' && /^[0-9a-f]{40}$/.test(input.sourceCommit)
      ? input.sourceCommit
      : (() => {
        throw new ConfigError(`${field}.sourceCommit must be a 40-character git SHA or null`, { field: `${field}.sourceCommit` });
      })());
  return Object.freeze({
    slot: assertIdentifier(input.slot, `${field}.slot`),
    artifactSha256: assertDigest(input.artifactSha256, `${field}.artifactSha256`),
    sourceCommit,
  });
}

/**
 * @param {unknown} raw
 * @returns {Readonly<object>}
 */
export function validateTestRow(raw, field = 'tests[]') {
  const input = assertClosed(raw, ['id', 'status', 'evidenceRef', 'evidenceSha256'], ['id', 'status', 'evidenceRef', 'evidenceSha256'], field);
  const status = input.status;
  if (!Object.values(TEST_STATUS).includes(/** @type {string} */ (status))) {
    throw new ConfigError(`${field}.status must be PASS, FAIL or NOT_RUN`, { field: `${field}.status` });
  }
  const evidenceRef = nullableRef(input.evidenceRef, `${field}.evidenceRef`);
  const evidenceSha256 = input.evidenceSha256 === null || input.evidenceSha256 === undefined
    ? null
    : assertDigest(input.evidenceSha256, `${field}.evidenceSha256`);
  if ((evidenceRef === null) !== (evidenceSha256 === null)) {
    throw new ConfigError(`${field} must carry both evidenceRef and evidenceSha256, or neither`, { field });
  }
  // C11: absent evidence must prevent readiness. A PASS without a hashable
  // artifact is not evidence, it is an assertion.
  if (status === TEST_STATUS.PASS && evidenceRef === null) {
    throw new ConfigError(`${field}: a PASS row requires an evidence reference`, { field: `${field}.evidenceRef` });
  }
  return Object.freeze({
    id: assertNonEmpty(input.id, `${field}.id`),
    status,
    evidenceRef,
    evidenceSha256,
  });
}

/**
 * @param {unknown} raw
 * @returns {Readonly<object>}
 */
export function validateObservedParticipant(raw, field = 'observedParticipants[]') {
  const input = assertClosed(
    raw,
    ['slot', 'instanceId', 'inferenceEnabled', 'artifactSha256', 'manifestVersion', 'manifestSha256', 'generation', 'identityReady'],
    ['slot', 'instanceId', 'inferenceEnabled', 'artifactSha256', 'manifestVersion', 'manifestSha256', 'generation', 'identityReady'],
    field,
  );
  if (typeof input.inferenceEnabled !== 'boolean' || typeof input.identityReady !== 'boolean') {
    throw new ConfigError(`${field} flags must be booleans`, { field });
  }
  if (!Number.isSafeInteger(input.generation) || /** @type {number} */ (input.generation) < 0) {
    throw new ConfigError(`${field}.generation must be a non-negative safe integer`, { field });
  }
  return Object.freeze({
    slot: assertIdentifier(input.slot, `${field}.slot`),
    instanceId: assertIdentifier(input.instanceId, `${field}.instanceId`),
    inferenceEnabled: input.inferenceEnabled,
    artifactSha256: assertDigest(input.artifactSha256, `${field}.artifactSha256`),
    manifestVersion: assertIdentifier(input.manifestVersion, `${field}.manifestVersion`),
    manifestSha256: assertDigest(input.manifestSha256, `${field}.manifestSha256`),
    generation: /** @type {number} */ (input.generation),
    identityReady: input.identityReady,
  });
}

/**
 * @param {unknown} raw
 * @returns {Readonly<object>}
 */
export function validateTransitionRow(raw, field = 'transitions[]') {
  const input = assertClosed(
    raw,
    ['transitionId', 'fromGeneration', 'toGeneration', 'phase', 'evidenceRef'],
    ['transitionId', 'fromGeneration', 'toGeneration', 'phase', 'evidenceRef'],
    field,
  );
  for (const key of ['fromGeneration', 'toGeneration']) {
    if (!Number.isSafeInteger(input[key]) || /** @type {number} */ (input[key]) < 0) {
      throw new ConfigError(`${field}.${key} must be a non-negative safe integer`, { field: `${field}.${key}` });
    }
  }
  if (/** @type {number} */ (input.toGeneration) < /** @type {number} */ (input.fromGeneration)) {
    throw new ConfigError(`${field} generations must be monotonic`, { field });
  }
  return Object.freeze({
    transitionId: typeof input.transitionId === 'string' && UUID_PATTERN.test(input.transitionId)
      ? input.transitionId
      : (() => {
        throw new ConfigError(`${field}.transitionId must be a lowercase UUID`, { field: `${field}.transitionId` });
      })(),
    fromGeneration: /** @type {number} */ (input.fromGeneration),
    toGeneration: /** @type {number} */ (input.toGeneration),
    phase: assertNonEmpty(input.phase, `${field}.phase`),
    evidenceRef: validateEvidenceRef(input.evidenceRef, `${field}.evidenceRef`),
  });
}

/**
 * A dossier-relative evidence path: forward slashes, no traversal, no absolute
 * path, no Windows separator. Refs are resolved against the report's directory.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string | null}
 */
export function validateEvidenceRef(value, field = 'evidenceRef') {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${field} must be a non-empty relative path or null`, { field });
  }
  const ref = value.trim();
  if (ref.startsWith('/') || /^[a-zA-Z]:/.test(ref) || ref.includes('\\')) {
    throw new ConfigError(`${field} must be a dossier-relative POSIX path`, { field });
  }
  const segments = ref.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ConfigError(`${field} must not contain empty, '.' or '..' segments`, { field });
  }
  return ref;
}

/**
 * The dossier's evidence index: every referenced file with the digest the report
 * was built against. The verifier re-hashes each file and refuses a mismatch, so
 * a report cannot point at evidence that is absent or has changed underneath it.
 *
 * @param {unknown} raw
 * @returns {Readonly<Record<string, string>>}
 */
export function validateEvidenceHashes(raw) {
  if (!isPlainObject(raw)) {
    throw new ConfigError('evidenceHashes must be an object', { field: 'evidenceHashes' });
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const ref = validateEvidenceRef(key, `evidenceHashes[${JSON.stringify(key)}]`);
    out[/** @type {string} */ (ref)] = assertDigest(value, `evidenceHashes[${JSON.stringify(key)}]`);
  }
  return Object.freeze(out);
}

const REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'releaseId',
  'deploymentId',
  'sourceTask',
  'candidateBinding',
  'previousBinding',
  'artifactSet',
  'inventory',
  'topologyEvidenceRef',
  'tests',
  'observedParticipants',
  'transitions',
  'parityReportRef',
  'modelEvaluationRef',
  'rollbackReportRef',
  'financialRiskDispositionRef',
  'operatorApprovalRef',
  'evidenceHashes',
  'notes',
  'blockers',
  'conclusion',
]);

/**
 * Validate a release report and its conclusion invariants.
 *
 * @param {unknown} raw
 * @returns {Readonly<object>}
 */
export function validateReleaseReport(raw) {
  const input = assertClosed(raw, REPORT_FIELDS, REPORT_FIELDS, 'release report');
  if (input.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new ConfigError(`release report schemaVersion must be ${REPORT_SCHEMA_VERSION}`, { field: 'schemaVersion' });
  }
  if (typeof input.deploymentId !== 'string' || !UUID_PATTERN.test(input.deploymentId)) {
    throw new ConfigError('release report deploymentId must be a lowercase UUID', { field: 'deploymentId' });
  }
  if (!Array.isArray(input.artifactSet)) throw new ConfigError('artifactSet must be an array', { field: 'artifactSet' });
  const artifactSet = input.artifactSet.map((entry, index) => validateArtifactSetEntry(entry, `artifactSet[${index}]`));
  if (!Array.isArray(input.tests)) throw new ConfigError('tests must be an array', { field: 'tests' });
  const tests = input.tests.map((entry, index) => validateTestRow(entry, `tests[${index}]`));
  const testIds = new Set();
  for (const row of tests) {
    if (testIds.has(row.id)) throw new ConfigError(`duplicate test row ${row.id}`, { field: 'tests' });
    testIds.add(row.id);
  }
  for (const gate of GATES) {
    if (!testIds.has(gate)) throw new ConfigError(`release report is missing gate ${gate}`, { field: 'tests' });
  }
  for (const xp of XP_IDS) {
    if (!testIds.has(xp)) throw new ConfigError(`release report is missing ${xp}`, { field: 'tests' });
  }
  if (!Array.isArray(input.transitions)) throw new ConfigError('transitions must be an array', { field: 'transitions' });
  const transitions = input.transitions.map((entry, index) => validateTransitionRow(entry, `transitions[${index}]`));
  if (!Array.isArray(input.observedParticipants)) {
    throw new ConfigError('observedParticipants must be an array', { field: 'observedParticipants' });
  }
  const observedParticipants = input.observedParticipants.map((entry, index) =>
    validateObservedParticipant(entry, `observedParticipants[${index}]`));
  if (!Array.isArray(input.blockers) || input.blockers.some((blocker) => typeof blocker !== 'string')) {
    throw new ConfigError('blockers must be an array of strings', { field: 'blockers' });
  }
  const conclusion = input.conclusion;
  if (!Object.values(CONCLUSION).includes(/** @type {string} */ (conclusion))) {
    throw new ConfigError(`unsupported conclusion ${JSON.stringify(conclusion)}`, { field: 'conclusion' });
  }
  const evidenceHashes = validateEvidenceHashes(input.evidenceHashes);

  const refs = {
    topologyEvidenceRef: validateEvidenceRef(input.topologyEvidenceRef, 'topologyEvidenceRef'),
    parityReportRef: validateEvidenceRef(input.parityReportRef, 'parityReportRef'),
    modelEvaluationRef: validateEvidenceRef(input.modelEvaluationRef, 'modelEvaluationRef'),
    rollbackReportRef: validateEvidenceRef(input.rollbackReportRef, 'rollbackReportRef'),
    financialRiskDispositionRef: validateEvidenceRef(input.financialRiskDispositionRef, 'financialRiskDispositionRef'),
    operatorApprovalRef: validateEvidenceRef(input.operatorApprovalRef, 'operatorApprovalRef'),
  };
  /** @type {string[]} */
  const referenced = Object.values(refs).filter((ref) => ref !== null);
  for (const row of tests) {
    if (row.evidenceRef !== null) referenced.push(row.evidenceRef);
  }
  for (const row of transitions) {
    if (row.evidenceRef !== null) referenced.push(validateEvidenceRef(row.evidenceRef, 'transitions[].evidenceRef'));
  }
  // Every reference must be indexed. A report whose refs are not all in the
  // evidence index cannot be checked against the filesystem, so it is refused.
  for (const ref of referenced) {
    if (!Object.prototype.hasOwnProperty.call(evidenceHashes, ref)) {
      throw new ConfigError(`evidence ref ${JSON.stringify(ref)} is missing from evidenceHashes`, {
        field: 'evidenceHashes',
      });
    }
  }
  for (const row of tests) {
    if (row.evidenceRef === null) continue;
    if (evidenceHashes[row.evidenceRef] !== row.evidenceSha256) {
      throw new ConfigError(`tests[${row.id}].evidenceSha256 does not match evidenceHashes`, {
        field: `tests[${row.id}].evidenceSha256`,
      });
    }
  }
  const notes = input.notes === null || input.notes === undefined ? {} : input.notes;
  if (!isPlainObject(notes) || Object.values(notes).some((value) => typeof value !== 'string')) {
    throw new ConfigError('notes must be an object of strings', { field: 'notes' });
  }
  const byId = new Map(tests.map((row) => [row.id, row.status]));
  const allXpPass = XP_IDS.every((id) => byId.get(id) === TEST_STATUS.PASS);
  const gatesPass = (ids) => ids.every((id) => byId.get(id) === TEST_STATUS.PASS);
  if (conclusion === CONCLUSION.READY_FOR_OPERATOR_APPROVAL) {
    if (!allXpPass) throw new ConfigError('READY_FOR_OPERATOR_APPROVAL requires every XP to PASS', { field: 'conclusion' });
    if (!gatesPass([GATE.G1, GATE.G2, GATE.G3, GATE.G4, GATE.G5])) {
      throw new ConfigError('READY_FOR_OPERATOR_APPROVAL requires G1–G5 to PASS', { field: 'conclusion' });
    }
  }
  if (conclusion === CONCLUSION.ACTIVATION_VERIFIED) {
    if (!allXpPass || !gatesPass(GATES)) {
      throw new ConfigError('ACTIVATION_VERIFIED requires every XP and every gate, including G6 and G7, to PASS', {
        field: 'conclusion',
      });
    }
  }
  return Object.freeze({
    schemaVersion: REPORT_SCHEMA_VERSION,
    releaseId: assertIdentifier(input.releaseId, 'releaseId'),
    deploymentId: input.deploymentId,
    sourceTask: assertIdentifier(input.sourceTask, 'sourceTask'),
    candidateBinding: validateBinding(input.candidateBinding, 'candidateBinding'),
    previousBinding: input.previousBinding === null ? null : validateBinding(input.previousBinding, 'previousBinding'),
    artifactSet: Object.freeze(artifactSet),
    inventory: validateInventory(input.inventory),
    topologyEvidenceRef: refs.topologyEvidenceRef,
    tests: Object.freeze(tests),
    observedParticipants: Object.freeze(observedParticipants),
    transitions: Object.freeze(transitions),
    parityReportRef: refs.parityReportRef,
    modelEvaluationRef: refs.modelEvaluationRef,
    rollbackReportRef: refs.rollbackReportRef,
    financialRiskDispositionRef: refs.financialRiskDispositionRef,
    operatorApprovalRef: refs.operatorApprovalRef,
    evidenceHashes,
    notes: Object.freeze({ ...notes }),
    blockers: Object.freeze([...input.blockers]),
    conclusion,
  });
}

/**
 * Re-export so the CLI and tests share one code value.
 * @type {string}
 */
export const REPORT_SCHEMA_ERROR_CODE = COORDINATION_ERROR_CODE.INVALID_EVIDENCE;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isReportObject(value) {
  return isPlainObject(value);
}
