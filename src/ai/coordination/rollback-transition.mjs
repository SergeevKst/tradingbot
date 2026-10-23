/**
 * Composite `rollback` orchestration (UAI-05B, handoff §1 "rollback orchestrates
 * a new transition, never copies control files").
 *
 * The approved CLI contract names a `rollback` verb, so a rollback must be
 * *startable* with one explicit command instead of relying on an operator to
 * remember that the first column of a forward release is also the first column
 * of a rollback. The verb is deliberately thin: it does not add a state edge, it
 * does not weaken the barrier, and it cannot commit a binding. It only opens the
 * ordinary `quiesce` transition for a descriptor that the deployment has already
 * staged, at a strictly higher generation, and leaves every subsequent obligation
 * (quiescence, prepare, observer receipts, arm, activate) exactly where it was.
 *
 * What it refuses, on purpose:
 *   - any phase other than ACTIVE (a retained transition is continued with
 *     `recover`, not restarted as a rollback);
 *   - a descriptor that is not an immutable file under `releases/`, so a
 *     rollback can only target a binding this deployment already approved;
 *   - a stale `expectedRevision` (compare-and-swap, exactly like every other
 *     verb).
 *
 * @module ai/coordination/rollback-transition
 */
import {
  PHASE,
  computeReleaseDescriptorDigest,
  validateReleaseDescriptor,
} from '../../config/ai-release-schema.mjs';
import { COORDINATION_ERROR_CODE, CoordinationError } from '../../errors/coordination-error.mjs';

/**
 * Open a rollback barrier: a fresh `QUIESCING` transition, at
 * `highWaterGeneration + 1`, targeting a previously staged descriptor.
 *
 * @param {{
 *   readRecord: () => any,
 *   readReleaseDescriptor: (sha256: string) => any,
 *   transact: (command: object, options: { expectedRevision: number, purpose?: string }) => any,
 * }} store
 * @param {{
 *   descriptor: unknown,
 *   transitionId: string,
 *   expectedRevision?: number,
 * }} input
 * @returns {{
 *   record: any,
 *   event: object,
 *   fromGeneration: number,
 *   reservedGeneration: number,
 *   previousDescriptorSha256: string | null,
 *   descriptorSha256: string,
 *   controlFilesCopied: false,
 *   revision: number,
 * }}
 */
export function startRollback(store, input) {
  const transitionId = input?.transitionId;
  if (typeof transitionId !== 'string' || transitionId === '') {
    throw new CoordinationError('a rollback requires an explicit transition id', {
      code: COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
      details: { argument: 'transition-id' },
    });
  }
  const descriptor = validateReleaseDescriptor(input.descriptor);
  const descriptorSha256 = computeReleaseDescriptorDigest(descriptor);

  const record = store.readRecord();
  if (record.phase !== PHASE.ACTIVE) {
    throw new CoordinationError(
      `rollback starts a new barrier from a committed ACTIVE generation; the record is ${record.phase} (continue a retained transition with recover)`,
      {
        code: COORDINATION_ERROR_CODE.INVALID_TRANSITION,
        details: { phase: record.phase, action: 'rollback' },
      },
    );
  }

  // A rollback targets a binding this deployment already approved. Requiring the
  // immutable descriptor to exist under `releases/` is the strongest offline
  // provenance check available, and it keeps the verb from ever writing a
  // control record out of a file that was passed on the command line.
  try {
    store.readReleaseDescriptor(descriptorSha256);
  } catch (error) {
    throw new CoordinationError(
      'rollback target is not a previously staged release descriptor; run stage with this descriptor first',
      {
        code: COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
        details: { descriptorSha256 },
        cause: error,
      },
    );
  }

  const expectedRevision = input.expectedRevision ?? record.revision;
  if (expectedRevision !== record.revision) {
    throw new CoordinationError('expected revision does not match the durable control record', {
      code: COORDINATION_ERROR_CODE.INVALID_TRANSITION,
      details: { expectedRevision, actualRevision: record.revision },
    });
  }

  // The same durable compare-and-swap transition a forward release uses. No file
  // is copied: the record is produced by the store from the current one.
  const result = store.transact(
    { action: 'quiesce', descriptor, transitionId },
    { expectedRevision, purpose: 'rollback' },
  );
  const next = result.record;
  const reservedGeneration = next.nextGeneration;
  const fromGeneration = record.generation;

  const consistent = next.phase === PHASE.QUIESCING
    && next.transitionId === transitionId
    && next.transition?.descriptorSha256 === descriptorSha256
    && next.revision === record.revision + 1
    && Number.isSafeInteger(reservedGeneration)
    && reservedGeneration > fromGeneration
    && reservedGeneration === record.highWaterGeneration + 1
    && next.highWaterGeneration === reservedGeneration;
  if (!consistent) {
    throw new CoordinationError('rollback did not produce a monotonic, single-record barrier', {
      code: COORDINATION_ERROR_CODE.INVALID_TRANSITION,
      details: {
        fromGeneration,
        reservedGeneration,
        phase: next.phase,
        revision: next.revision,
        expectedRevision: record.revision + 1,
      },
    });
  }

  return {
    record: next,
    event: result.event,
    fromGeneration,
    reservedGeneration,
    previousDescriptorSha256: record.releaseDescriptorSha256 ?? null,
    descriptorSha256,
    controlFilesCopied: false,
    revision: next.revision,
  };
}
