/**
 * Phased migration and rollback rules for the v2 Skill protocol
 * (architecture v1.1 §10).
 *
 * Guardrails implemented here:
 *
 *   - Conversion is offline and administrative. Only a PAUSED or QUIESCING v1
 *     record may be converted, and the result is a validated v2 **PAUSED**
 *     record: no inference is possible during or immediately after conversion.
 *   - Deployment, the generation high-water mark, the inventory and the prior
 *     release-descriptor reference are preserved; the revision advances.
 *   - Rollback is to a previously approved complete v2 pair at a strictly higher
 *     generation. A revoked or missing package cannot be restored, and no
 *     online rollback to a v1-only binary is offered.
 *
 * The migration never writes the control store: the caller applies the returned
 * record through the existing authorized writer with CAS.
 *
 * @module ai/skills/migration
 */
import { digestJson } from '../../config/jcs.mjs';
import { validateControlRecordV2 } from '../../config/ai-release-schema.mjs';
import { structuralError } from '../../errors/skill-error.mjs';

const PHASE_PAUSED = 'PAUSED';
const PHASE_QUIESCING = 'QUIESCING';
const PHASE_PREPARING = 'PREPARING';
const PHASE_ARMED = 'ARMED';

/**
 * Decide whether a control record may be converted to the v2 schema.
 *
 * @param {unknown} record
 * @returns {{ eligible: boolean, reason: string | null }}
 */
export function assessMigration(record) {
  if (record === null || typeof record !== 'object') {
    return { eligible: false, reason: 'NO_CONTROL_RECORD' };
  }
  const value = /** @type {any} */ (record);
  if (value.schemaVersion === 2) {
    return { eligible: false, reason: 'ALREADY_V2' };
  }
  if (value.schemaVersion !== 1) {
    return { eligible: false, reason: 'UNSUPPORTED_SCHEMA_VERSION' };
  }
  if (value.phase === PHASE_PAUSED || value.phase === PHASE_QUIESCING) {
    return { eligible: true, reason: null };
  }
  if (value.phase === PHASE_PREPARING || value.phase === PHASE_ARMED) {
    return { eligible: false, reason: 'TRANSITION_IN_PROGRESS' };
  }
  return { eligible: false, reason: 'ACTIVE_REQUIRES_QUIESCE' };
}

/**
 * Build the validated v2 PAUSED record produced by an offline migration.
 *
 * @param {unknown} record a v1 control record
 * @param {{ operatorApprovalId: string }} input
 * @returns {Readonly<object>}
 */
export function buildMigratedRecord(record, input) {
  if (typeof input?.operatorApprovalId !== 'string' || input.operatorApprovalId === '') {
    throw new TypeError('buildMigratedRecord requires { operatorApprovalId }');
  }
  const assessment = assessMigration(record);
  if (!assessment.eligible) {
    throw structuralError('SKILL_INCOMPATIBLE', `control record is not migratable: ${assessment.reason}`, {
      field: 'controlRecord.phase',
    });
  }
  const previous = /** @type {any} */ (record);
  return validateControlRecordV2({
    schemaVersion: 2,
    deploymentId: previous.deploymentId,
    revision: previous.revision + 1,
    generation: previous.generation,
    nextGeneration: null,
    phase: PHASE_PAUSED,
    active: null,
    target: null,
    transitionId: null,
    inventory: previous.inventory,
    members: [],
    highWaterGeneration: previous.highWaterGeneration,
    approvalId: null,
    // Prior descriptor stays referenced as immutable audit evidence; it is never
    // loaded as the v2 dispatch plan.
    releaseDescriptorSha256: previous.releaseDescriptorSha256,
    transition: null,
  });
}

/**
 * A v2 rollback must target a strictly higher generation than the one running.
 *
 * @param {{ currentGeneration: number, targetGeneration: number }} input
 */
export function assertRollbackIsHigherGeneration(input) {
  if (!Number.isSafeInteger(input.currentGeneration) || !Number.isSafeInteger(input.targetGeneration)) {
    throw new TypeError('assertRollbackIsHigherGeneration requires integer generations');
  }
  if (input.targetGeneration <= input.currentGeneration) {
    throw structuralError('SKILL_INCOMPATIBLE', 'rollback must activate a strictly higher generation', {
      field: 'generation',
    });
  }
}

/**
 * Every package in the rollback registry must still be published, approved and
 * unrevoked. A revoked or missing package cannot be restored.
 *
 * @param {{
 *   store: any,
 *   skillRegistry: Readonly<object>,
 *   trustRoots: Readonly<object>,
 * }} input
 */
export function assertRollbackPackagesAvailable(input) {
  const operations = /** @type {any} */ (input.skillRegistry).operations;
  for (const [operation, ref] of Object.entries(operations)) {
    try {
      if (input.store.readRevocation(/** @type {any} */ (ref).packageDigestSha256) !== null) {
        throw structuralError('SKILL_REVOKED', `rollback package for ${operation} is revoked`, { operation });
      }
      if (input.store.readAttestation(/** @type {any} */ (ref).packageDigestSha256) === null) {
        throw structuralError('SKILL_NOT_APPROVED', `rollback package for ${operation} has no approval`, { operation });
      }
      input.store.readPackage(ref, {});
    } catch (error) {
      if (error instanceof Error && /** @type {any} */ (error).code === 'SKILL_REVOKED') throw error;
      throw structuralError('SKILL_MISSING', `rollback package for ${operation} cannot be reconstructed`, { operation });
    }
  }
}

/**
 * Compare two complete v2 pairs and report what a rollback would change.
 *
 * @param {{ current: { skillRegistrySha256: string, modelRegistrySha256: string }, target: { skillRegistrySha256: string, modelRegistrySha256: string } }} input
 * @returns {Readonly<{ skillChanged: boolean, modelChanged: boolean }>}
 */
export function describeRollbackDelta(input) {
  return Object.freeze({
    skillChanged: input.current.skillRegistrySha256 !== input.target.skillRegistrySha256,
    modelChanged: input.current.modelRegistrySha256 !== input.target.modelRegistrySha256,
  });
}

/**
 * Digest helper exposed for migration dossiers.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function migrationEvidenceDigest(value) {
  return digestJson(value, { label: 'migration evidence' });
}
