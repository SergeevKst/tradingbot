#!/usr/bin/env node
/**
 * Release CLI for the unified single-mode AI protocol (UAI-05B, UAI-09).
 *
 * The CLI is the only trusted control writer besides participant registration.
 * It never activates implicitly, never picks a "latest" descriptor, never takes
 * over a crashed writer lock and never prints secrets. Every mutating verb:
 *
 *   - requires an explicit absolute control directory and deployment ID;
 *   - reads the durable record, compares the expected revision, applies one
 *     legal transition and prints a redacted machine-readable result;
 *   - returns a nonzero exit code on conflict, invalid evidence or a blocked
 *     transition.
 *
 * Usage:
 *   node scripts/ai_release.mjs inspect --control-dir DIR [--deployment-id UUID]
 *   node scripts/ai_release.mjs initialize --control-dir DIR --inventory FILE
 *   node scripts/ai_release.mjs stage --control-dir DIR --descriptor FILE
 *   node scripts/ai_release.mjs quiesce --control-dir DIR --descriptor FILE --transition-id UUID
 *   node scripts/ai_release.mjs collect-quiescence --control-dir DIR
 *   node scripts/ai_release.mjs prepare --control-dir DIR
 *   node scripts/ai_release.mjs grant --control-dir DIR --slot SLOT --instance ID --descriptor-sha SHA
 *   node scripts/ai_release.mjs collect-prepared --control-dir DIR
 *   node scripts/ai_release.mjs observer --control-dir DIR --transition-id UUID --observer-id ID --artifact-sha SHA
 *   node scripts/ai_release.mjs arm --control-dir DIR
 *   node scripts/ai_release.mjs activate --control-dir DIR
 *   node scripts/ai_release.mjs rollback --control-dir DIR --descriptor FILE --transition-id UUID
 *   node scripts/ai_release.mjs pause --control-dir DIR [--reason TEXT]
 *   node scripts/ai_release.mjs recover --control-dir DIR --descriptor FILE --transition-id UUID
 *   node scripts/ai_release.mjs retire --control-dir DIR --slot SLOT --instance ID --kind QUIESCED|FENCED
 *   node scripts/ai_release.mjs register --control-dir DIR --slot SLOT --instance ID --artifact-sha SHA
 *   node scripts/ai_release.mjs recover-lock --control-dir DIR --approval-id ID --fence-ref REF --reconcile-ref REF
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createControlStore } from '../src/ai/coordination/control-store.mjs';
import {
  describeBarrierBlockers,
  validateFenceEvidenceForTransition,
} from '../src/ai/coordination/release-state.mjs';
import { validateObserverIdentity, buildObserverReceipt } from '../src/ai/coordination/generation-guard.mjs';
import { startRollback } from '../src/ai/coordination/rollback-transition.mjs';
import {
  computeReleaseDescriptorDigest,
  validateInventory,
  validateReleaseDescriptor,
} from '../src/config/ai-release-schema.mjs';
import { parseStrictJsonBytes } from '../src/config/jcs.mjs';
import { COORDINATION_ERROR_CODE, CoordinationError } from '../src/errors/coordination-error.mjs';

const VERBS = Object.freeze([
  'inspect',
  'initialize',
  'stage',
  'quiesce',
  'collect-quiescence',
  'prepare',
  'grant',
  'collect-prepared',
  'observer',
  'arm',
  'activate',
  'rollback',
  'pause',
  'recover',
  'retire',
  'register',
  'recover-lock',
]);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'control-dir': { type: 'string' },
    'deployment-id': { type: 'string' },
    'expected-revision': { type: 'string' },
    inventory: { type: 'string' },
    descriptor: { type: 'string' },
    'descriptor-sha': { type: 'string' },
    'transition-id': { type: 'string' },
    'approval-id': { type: 'string' },
    'observer-id': { type: 'string' },
    'artifact-sha': { type: 'string' },
    'manifest-version': { type: 'string' },
    'manifest-sha': { type: 'string' },
    slot: { type: 'string' },
    instance: { type: 'string' },
    kind: { type: 'string' },
    evidence: { type: 'string' },
    'fence-ref': { type: 'string' },
    'reconcile-ref': { type: 'string' },
    reason: { type: 'string' },
    // Test-only fault injection for crash-boundary conformance (UAI-06C XP-09).
    fault: { type: 'string' },
    json: { type: 'boolean', default: true },
  },
});

/**
 * @param {unknown} error
 * @returns {number}
 */
function exitFor(error) {
  return error instanceof CoordinationError ? 1 : 2;
}

/**
 * @param {Record<string, unknown>} payload
 */
function print(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * @param {string | undefined} value
 * @param {string} name
 * @returns {string}
 */
function required(value, name) {
  if (typeof value !== 'string' || value === '') {
    throw new CoordinationError(`missing required argument --${name}`, {
      code: COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
      details: { argument: name },
    });
  }
  return value;
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJsonFile(file) {
  const resolved = path.resolve(file);
  const bytes = fs.readFileSync(resolved);
  return parseStrictJsonBytes(bytes, { label: path.basename(resolved), maxBytes: 1024 * 1024 });
}

/**
 * @param {any} store
 * @param {any} command
 * @param {{ expectedRevision?: number }} [options]
 */
function transact(store, command, options = {}) {
  const record = store.readRecord();
  const expectedRevision = options.expectedRevision ?? record.revision;
  if (expectedRevision !== record.revision) {
    throw new CoordinationError('expected revision does not match the durable control record', {
      code: COORDINATION_ERROR_CODE.INVALID_TRANSITION,
      details: { expectedRevision, actualRevision: record.revision },
    });
  }
  const result = store.transact(command, { expectedRevision, purpose: `cli:${command.action}` });
  return result;
}

/**
 * @param {any} record
 * @param {any} extra
 */
function summarize(record, extra = {}) {
  return {
    ok: true,
    deploymentId: record.deploymentId,
    phase: record.phase,
    revision: record.revision,
    generation: record.generation,
    highWaterGeneration: record.highWaterGeneration,
    nextGeneration: record.nextGeneration,
    transitionId: record.transitionId,
    manifestVersion: record.active?.manifestVersion ?? record.target?.manifestVersion ?? null,
    manifestSha256: record.active?.manifestSha256 ?? record.target?.manifestSha256 ?? null,
    releaseDescriptorSha256: record.releaseDescriptorSha256,
    approvalId: record.approvalId,
    inventory: record.inventory,
    members: record.members,
    oldMembers: record.transition?.oldMembers ?? [],
    targetMembers: record.transition?.targetMembers ?? [],
    stageGrants: record.transition?.stageGrants ?? [],
    retirementEvidence: record.transition?.retirementEvidence ?? [],
    prepareEvidence: record.transition?.prepareEvidence ?? [],
    observerEvidence: record.transition?.observerEvidence ?? [],
    ...extra,
  };
}

async function main() {
  const verb = positionals[0];
  if (!verb || !VERBS.includes(verb)) {
    print({ ok: false, error: { code: 'USAGE', message: `verb must be one of: ${VERBS.join(', ')}` } });
    process.exitCode = 2;
    return;
  }
  const controlDir = required(values['control-dir'] ?? process.env.AI_CONTROL_DIR, 'control-dir');
  if (!path.isAbsolute(controlDir)) {
    throw new CoordinationError('--control-dir must be an absolute path', {
      code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
    });
  }
  const store = createControlStore({
    controlDir,
    faults: values.fault ? { [values.fault]: 'throw' } : {},
  });
  const expectedRevision = values['expected-revision'] === undefined
    ? undefined
    : Number(values['expected-revision']);

  switch (verb) {
    case 'inspect': {
      const inspection = store.inspect();
      if (inspection.record === null) {
        print({ ok: false, error: { code: inspection.errorCode ?? 'STORE_UNAVAILABLE', message: 'no readable control record' } });
        process.exitCode = 1;
        return;
      }
      if (values['deployment-id'] && inspection.record.deploymentId !== values['deployment-id']) {
        throw new CoordinationError('control record belongs to another deployment', {
          code: COORDINATION_ERROR_CODE.IDENTITY_MISMATCH,
        });
      }
      /** @type {any} */
      let blockerReport = null;
      if (inspection.record.transition) {
        const resolved = store.readReleaseDescriptor(inspection.record.transition.descriptorSha256);
        blockerReport = describeBarrierBlockers(inspection.record, resolved.descriptor, {
          observerReceipts: store.listObserverReceipts(inspection.record.transitionId).map((entry) => entry.receipt),
        });
      }
      print(summarize(inspection.record, {
        lockHeld: inspection.lockHeld,
        lockOwner: inspection.lockOwner,
        acks: inspection.acks,
        blockers: blockerReport,
      }));
      return;
    }
    case 'initialize': {
      const inventory = validateInventory(readJsonFile(required(values.inventory, 'inventory')));
      const result = store.initialize({
        deploymentId: values['deployment-id'],
        inventory,
        approvalId: values['approval-id'] ?? null,
      });
      print(summarize(result.record, { initialized: true }));
      return;
    }
    case 'stage': {
      const descriptor = validateReleaseDescriptor(readJsonFile(required(values.descriptor, 'descriptor')));
      const resolved = store.readReleaseDescriptor(store.putReleaseDescriptor(descriptor).sha256);
      print({
        ok: true,
        staged: true,
        descriptorSha256: computeReleaseDescriptorDigest(descriptor),
        binding: descriptor.binding,
        inventory: descriptor.inventory,
        artifacts: descriptor.artifacts,
        observers: descriptor.observers,
        approvalId: descriptor.approvalId,
        manifestVersion: resolved.manifest.manifestVersion,
      });
      return;
    }
    case 'quiesce': {
      const descriptor = validateReleaseDescriptor(readJsonFile(required(values.descriptor, 'descriptor')));
      store.readReleaseDescriptor(store.putReleaseDescriptor(descriptor).sha256);
      const result = transact(store, {
        action: 'quiesce',
        descriptor,
        transitionId: values['transition-id'] ?? randomUUID(),
      }, { expectedRevision });
      print(summarize(result.record, { event: result.event }));
      return;
    }
    case 'collect-quiescence': {
      const record = store.readRecord();
      if (record.transition === null) {
        throw new CoordinationError('no transition is in progress', { code: COORDINATION_ERROR_CODE.INVALID_TRANSITION });
      }
      const acks = store.collectAcks(record.transitionId, { status: 'QUIESCED' });
      let current = record;
      /** @type {string[]} */
      const collected = [];
      for (const entry of acks) {
        const already = current.transition.retirementEvidence.some(
          (evidence) => evidence.slot === entry.slot && evidence.instanceId === entry.instanceId && evidence.kind === 'QUIESCED',
        );
        if (already) continue;
        const isOld = current.transition.oldMembers.some(
          (member) => member.slot === entry.slot && member.instanceId === entry.instanceId,
        );
        if (!isOld) continue;
        current = store.transact({
          action: 'retire',
          slot: entry.slot,
          instanceId: entry.instanceId,
          kind: 'QUIESCED',
          evidenceSha256: entry.sha256,
        }, { expectedRevision: current.revision }).record;
        collected.push(`${entry.slot}/${entry.instanceId}`);
      }
      print(summarize(current, { collected }));
      return;
    }
    case 'prepare': {
      const result = transact(store, { action: 'prepare' }, { expectedRevision });
      print(summarize(result.record, { event: result.event }));
      return;
    }
    case 'grant': {
      const record = store.readRecord();
      const descriptorSha256 = required(values['descriptor-sha'], 'descriptor-sha');
      if (record.transition === null || record.transition.descriptorSha256 !== descriptorSha256) {
        throw new CoordinationError('descriptor digest is not the reserved target', {
          code: COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
        });
      }
      const { descriptor } = store.readReleaseDescriptor(descriptorSha256);
      const result = transact(store, {
        action: 'stage-grant',
        descriptor,
        slot: required(values.slot, 'slot'),
        instanceId: required(values.instance, 'instance'),
      }, { expectedRevision });
      print(summarize(result.record, { event: result.event }));
      return;
    }
    case 'register': {
      const record = store.readRecord();
      if (record.transition === null) {
        throw new CoordinationError('no transition is in progress', { code: COORDINATION_ERROR_CODE.INVALID_TRANSITION });
      }
      const { descriptor } = store.readReleaseDescriptor(record.transition.descriptorSha256);
      const result = transact(store, {
        action: 'register-target',
        descriptor,
        slot: required(values.slot, 'slot'),
        instanceId: required(values.instance, 'instance'),
        artifactSha256: required(values['artifact-sha'], 'artifact-sha'),
      }, { expectedRevision });
      print(summarize(result.record, { event: result.event }));
      return;
    }
    case 'collect-prepared': {
      const record = store.readRecord();
      if (record.transition === null) {
        throw new CoordinationError('no transition is in progress', { code: COORDINATION_ERROR_CODE.INVALID_TRANSITION });
      }
      const acks = store.collectAcks(record.transitionId, { status: 'PREPARED' });
      let current = record;
      /** @type {string[]} */
      const collected = [];
      for (const entry of acks) {
        if (entry.ack.targetGeneration !== current.nextGeneration) continue;
        current = store.transact({
          action: 'prepare-ack',
          ack: entry.ack,
          evidenceSha256: entry.sha256,
        }, { expectedRevision: current.revision }).record;
        collected.push(`${entry.slot}/${entry.instanceId}`);
      }
      print(summarize(current, { collected }));
      return;
    }
    case 'observer': {
      const record = store.readRecord();
      if (record.transition === null) {
        throw new CoordinationError('no transition is in progress', { code: COORDINATION_ERROR_CODE.INVALID_TRANSITION });
      }
      if (record.transitionId !== required(values['transition-id'], 'transition-id')) {
        throw new CoordinationError('observer run must name the current transition', {
          code: COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
        });
      }
      const observerId = required(values['observer-id'], 'observer-id');
      const artifactSha256 = required(values['artifact-sha'], 'artifact-sha');
      const validation = validateObserverIdentity({
        controlStore: store,
        deploymentId: record.deploymentId,
        expectedManifestVersion: required(values['manifest-version'], 'manifest-version'),
        expectedManifestSha256: required(values['manifest-sha'], 'manifest-sha'),
        artifactSha256,
        transitionId: record.transitionId,
        observerId,
      });
      const receipt = buildObserverReceipt(validation, {
        deploymentId: record.deploymentId,
        transitionId: record.transitionId,
        observerId,
        artifactSha256,
      });
      const written = store.writeObserverReceipt(record.transitionId, observerId, receipt);
      const { descriptor } = store.readReleaseDescriptor(record.transition.descriptorSha256);
      const result = store.transact({
        action: 'observer-evidence',
        descriptor,
        receipt,
        evidenceSha256: written.sha256,
      }, { expectedRevision: record.revision });
      print({
        ok: receipt.status === 'VALIDATED',
        observerId,
        status: receipt.status,
        errorCode: receipt.errorCode,
        evidenceSha256: written.sha256,
        phase: result.record.phase,
        revision: result.record.revision,
      });
      if (receipt.status !== 'VALIDATED') process.exitCode = 1;
      return;
    }
    case 'arm': {
      const result = transact(store, { action: 'arm' }, { expectedRevision });
      print(summarize(result.record, { event: result.event }));
      return;
    }
    case 'activate': {
      const result = transact(store, { action: 'activate' }, { expectedRevision });
      print(summarize(result.record, { event: result.event, archive: result.archive?.transitionId ?? null }));
      return;
    }
    case 'rollback': {
      // Thin composite: opens the ordinary barrier for an already staged
      // descriptor at a strictly higher generation. It cannot copy a control
      // file, cannot commit a binding and cannot skip any later obligation.
      const descriptor = validateReleaseDescriptor(readJsonFile(required(values.descriptor, 'descriptor')));
      const result = startRollback(store, {
        descriptor,
        transitionId: required(values['transition-id'], 'transition-id'),
        expectedRevision,
      });
      print(summarize(result.record, {
        rollback: true,
        controlFilesCopied: result.controlFilesCopied,
        previousGeneration: result.fromGeneration,
        reservedGeneration: result.reservedGeneration,
        previousDescriptorSha256: result.previousDescriptorSha256,
        rollbackDescriptorSha256: result.descriptorSha256,
        event: result.event,
        nextSteps: [
          'collect-quiescence',
          'prepare',
          'grant|register + collect-prepared',
          'observer (required observers)',
          'arm',
          'activate',
        ],
      }));
      return;
    }
    case 'pause': {
      const result = transact(store, { action: 'pause', reason: values.reason ?? null }, { expectedRevision });
      print(summarize(result.record, { event: result.event }));
      return;
    }
    case 'recover': {
      const descriptor = validateReleaseDescriptor(readJsonFile(required(values.descriptor, 'descriptor')));
      store.putReleaseDescriptor(descriptor);
      const result = transact(store, {
        action: 'recover',
        descriptor,
        transitionId: values['transition-id'] ?? randomUUID(),
      }, { expectedRevision });
      print(summarize(result.record, { event: result.event }));
      return;
    }
    case 'retire': {
      const record = store.readRecord();
      if (record.transition === null) {
        throw new CoordinationError('no transition is in progress', { code: COORDINATION_ERROR_CODE.INVALID_TRANSITION });
      }
      const kind = required(values.kind, 'kind');
      if (kind !== 'QUIESCED' && kind !== 'FENCED') {
        throw new CoordinationError('--kind must be QUIESCED or FENCED', {
          code: COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
        });
      }
      const slot = required(values.slot, 'slot');
      const instanceId = required(values.instance, 'instance');
      let evidenceSha256 = values.evidence;
      if (kind === 'FENCED') {
        const raw = readJsonFile(required(values.evidence, 'evidence'));
        const fence = validateFenceEvidenceForTransition(raw, { record, slot, instanceId });
        evidenceSha256 = store.writeFenceEvidence(record.transitionId, slot, instanceId, fence).sha256;
      } else {
        if (evidenceSha256 === undefined) {
          const ack = store.collectAcks(record.transitionId, { status: 'QUIESCED' }).find(
            (entry) => entry.slot === slot && entry.instanceId === instanceId,
          );
          if (!ack) {
            throw new CoordinationError('no QUIESCED acknowledgement exists for this instance', {
              code: COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
            });
          }
          evidenceSha256 = ack.sha256;
        }
        if (!store.findEvidence(record.transitionId, evidenceSha256)) {
          throw new CoordinationError('the referenced retirement evidence does not exist', {
            code: COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
          });
        }
      }
      const result = transact(store, {
        action: 'retire',
        slot,
        instanceId,
        kind,
        evidenceSha256,
      }, { expectedRevision });
      print(summarize(result.record, { event: result.event }));
      return;
    }
    case 'recover-lock': {
      const result = store.recoverLock({
        operatorApprovalId: required(values['approval-id'], 'approval-id'),
        processFenceEvidenceRef: required(values['fence-ref'], 'fence-ref'),
        outcomeReconciliationRef: required(values['reconcile-ref'], 'reconcile-ref'),
      });
      print({ ok: true, recovered: result.recovered, previous: result.previous });
      return;
    }
    default:
      throw new CoordinationError(`unhandled verb ${verb}`, { code: COORDINATION_ERROR_CODE.INTERNAL_ERROR });
  }
}

try {
  await main();
} catch (error) {
  const code = error instanceof CoordinationError ? error.code : 'UNEXPECTED_ERROR';
  print({
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      ...(error instanceof CoordinationError && Object.keys(error.details).length > 0 ? { details: error.details } : {}),
    },
  });
  process.exitCode = exitFor(error);
}
