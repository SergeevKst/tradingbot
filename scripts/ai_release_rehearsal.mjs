#!/usr/bin/env node
/**
 * Release rehearsal with fake effects (UAI-09 G5).
 *
 * Drives a complete forward activation and then a rollback to the same manifest
 * under a higher generation, using synthetic participants and synthetic
 * acknowledgements. No provider, exchange, Telegram or account call is possible:
 * this is a control-plane rehearsal, not a release.
 *
 * The point is to prove the protocol end to end on a real durable store and to
 * leave real evidence files (acks, transition archives, audit) that a reviewer
 * can inspect. It never claims activation approval.
 *
 * G5 also asks for two properties of the financial layer: the financial
 * state/journal is unchanged before and after the transition *except* for
 * fixture-declared normal deterministic actions, and no entry is duplicated.
 * No live financial state is read or written here, so the rehearsal proves both
 * properties on a synthetic fixture journal — the entries the fixture declares
 * as normal deterministic protection actions are added *inside* each barrier's
 * PREPARING phase (deterministic protection is not paused by a transition), the
 * residual journal hashes must be equal, and every entry id must be unique.
 * Whether the live journal behaves the same is an operator/G7 obligation and is
 * disclosed in the report and in `limitations.md`.
 *
 * Usage:
 *   node scripts/ai_release_rehearsal.mjs --control-dir DIR \
 *     --manifest FILE --profile FILE --descriptor FILE \
 *     [--approval-id ID] [--report FILE]
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createControlStore } from '../src/ai/coordination/control-store.mjs';
import { startRollback } from '../src/ai/coordination/rollback-transition.mjs';
import {
  capabilityProfileSha256,
  validateCapabilityProfile,
} from '../src/ai/operation-profiles.mjs';
import {
  computeManifestDigest,
  validateModelIdentityManifest,
} from '../src/config/ai-identity-manifest.mjs';
import {
  ACK_STATUS,
  computeInventoryDigest,
  computeReleaseDescriptorDigest,
  validateReleaseDescriptor,
} from '../src/config/ai-release-schema.mjs';
import { parseStrictJsonBytes, digestJson } from '../src/config/jcs.mjs';
import { buildObserverReceipt, validateObserverIdentity } from '../src/ai/coordination/generation-guard.mjs';

/**
 * The fixture journal that stands in for the financial ledger during the
 * rehearsal. It is a synthetic list of entries, not a copy of any real state:
 * the two base entries represent the pre-existing financial state and the two
 * declared actions are the *only* entries the fixture adds while the release is
 * transitioned.
 */
export const FIXTURE_JOURNAL_BASE = Object.freeze([
  Object.freeze({ entryId: 'fx-journal-open-1', kind: 'open-trade', slot: 'telegram', amount: '0.010' }),
  Object.freeze({ entryId: 'fx-journal-closed-1', kind: 'closed-trade', slot: 'telegram', amount: '0.010' }),
]);

/**
 * Normal deterministic actions the fixture performs while the fleet is
 * transitioned — each one inside a barrier's PREPARING phase, because
 * deterministic protection keeps running during a transition. They are declared
 * here, not inferred: the equality proof below excludes exactly these ids and
 * nothing else.
 */
export const DECLARED_FIXTURE_ACTIONS = Object.freeze([
  Object.freeze({ entryId: 'fx-journal-trailing-1', kind: 'trailing-stop-adjust', slot: 'telegram', amount: '0.000', appliedDuring: 'forward PREPARING (inside the barrier)' }),
  Object.freeze({ entryId: 'fx-journal-harvest-1', kind: 'harvest-close', slot: 'telegram', amount: '0.010', appliedDuring: 'rollback PREPARING (inside the barrier)' }),
]);

/**
 * G5 financial-state proof: the journal hash changes only by the declared
 * deterministic actions, and no entry id appears twice.
 *
 * @param {{ before: readonly object[], after: readonly object[], declaredActions: readonly { entryId: string }[] }} input
 */
export function buildJournalProof(input) {
  const declaredIds = new Set(input.declaredActions.map((action) => action.entryId));
  const residualOf = (entries) => entries.filter((entry) => !declaredIds.has(entry.entryId));
  const ids = input.after.map((entry) => entry.entryId);
  const duplicateEntryIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const residualBefore = residualOf(input.before);
  const residualAfter = residualOf(input.after);
  const residualBeforeSha256 = digestJson(residualBefore, { label: 'fixture journal residual' });
  const residualAfterSha256 = digestJson(residualAfter, { label: 'fixture journal residual' });
  const declaredApplied = input.declaredActions.every(
    (action) => input.after.filter((entry) => entry.entryId === action.entryId).length === 1,
  );
  return {
    fixture: 'synthetic fixture journal: no live financial state, ledger, exchange account or order was read or written',
    declaredActions: input.declaredActions.map((action) => ({ ...action })),
    journalBefore: input.before.map((entry) => ({ ...entry })),
    journalAfter: input.after.map((entry) => ({ ...entry })),
    entryCountBefore: input.before.length,
    entryCountAfter: input.after.length,
    journalBeforeSha256: digestJson(input.before, { label: 'fixture journal' }),
    journalAfterSha256: digestJson(input.after, { label: 'fixture journal' }),
    residualBeforeSha256,
    residualAfterSha256,
    residualEqual: residualBeforeSha256 === residualAfterSha256,
    declaredActionsApplied: declaredApplied,
    duplicateEntryIds,
    noDuplicateEntry: duplicateEntryIds.length === 0,
  };
}

/**
 * Options are parsed only when the script itself runs, so the module can be
 * imported by tests without consuming the test runner's argv.
 */
function parseOptions() {
  const { values } = parseArgs({
    options: {
      'control-dir': { type: 'string' },
      manifest: { type: 'string' },
      profile: { type: 'string' },
      descriptor: { type: 'string' },
      'approval-id': { type: 'string' },
      report: { type: 'string' },
    },
  });
  return values;
}

/** @param {string | undefined} file @param {string} name */
function requireFile(file, name) {
  if (!file) throw new Error(`missing --${name}`);
  return parseStrictJsonBytes(fs.readFileSync(path.resolve(file)), { label: name, maxBytes: 512 * 1024 });
}

/**
 * @param {any} record
 * @param {any} binding
 * @param {string} slot
 * @param {string} instanceId
 * @param {string} artifactSha256
 * @param {string} status
 */
function ackFor(record, binding, slot, instanceId, artifactSha256, status) {
  return {
    schemaVersion: 1,
    deploymentId: record.deploymentId,
    transitionId: record.transitionId,
    targetGeneration: record.nextGeneration ?? record.generation,
    slot,
    instanceId,
    artifactSha256,
    status,
    manifestVersion: binding.manifestVersion,
    manifestSha256: binding.manifestSha256,
    capabilityProfileSha256: binding.capabilityProfileSha256,
    inventorySha256: binding.inventorySha256,
    outstandingWork: 0,
    pendingAIApprovals: 0,
    errorCode: null,
  };
}

function main() {
  const values = parseOptions();
  if (!values['control-dir']) throw new Error('missing --control-dir');
  const controlDir = path.resolve(values['control-dir']);
  const manifest = validateModelIdentityManifest(requireFile(values.manifest, 'manifest'));
  const profile = validateCapabilityProfile(requireFile(values.profile, 'profile'));
  const manifestSha256 = computeManifestDigest(manifest);
  const profileSha256 = capabilityProfileSha256(profile);
  if (profileSha256 !== manifest.capabilityProfileSha256) {
    throw new Error('the profile file does not match the manifest capability digest');
  }
  const descriptor = validateReleaseDescriptor(requireFile(values.descriptor, 'descriptor'));
  if (
    descriptor.binding.manifestSha256 !== manifestSha256
    || descriptor.binding.capabilityProfileSha256 !== profileSha256
    || descriptor.binding.inventorySha256 !== computeInventoryDigest(descriptor.inventory)
  ) {
    throw new Error('the descriptor does not bind the supplied manifest/profile/inventory');
  }
  const descriptorSha = computeReleaseDescriptorDigest(descriptor);

  const store = createControlStore({ controlDir });
  if (store.tryReadRecord() !== null) throw new Error('refusing to rehearse into an existing control store');
  store.putManifest(manifest, { manifestSha256 });
  store.putProfile(profile, { profileSha256 });
  store.putReleaseDescriptor(descriptor);

  const phases = [];
  let record = store.initialize({ inventory: descriptor.inventory, approvalId: descriptor.approvalId }).record;
  phases.push({ phase: record.phase, generation: record.generation });

  // Fixture journal: the declared normal deterministic actions are the only
  // entries the fixture adds, and each one is added *inside* a barrier (see
  // `applyAction` below), because deterministic protection keeps running while a
  // transition is in progress. Nothing else may touch the journal (G5).
  /**
   * @type {{
   *   entryId: string,
   *   kind: string,
   *   slot: string,
   *   amount: string,
   *   generation?: number,
   *   phase?: string,
   * }[]}
   */
  const journal = FIXTURE_JOURNAL_BASE.map((entry) => ({ ...entry }));

  /**
   * @param {number} index
   * @param {number} generation
   * @param {string} phase
   */
  function applyDeclaredAction(index, generation, phase) {
    const action = DECLARED_FIXTURE_ACTIONS[index];
    journal.push({
      entryId: action.entryId,
      kind: action.kind,
      slot: action.slot,
      amount: action.amount,
      generation,
      phase,
    });
  }

  /**
   * @param {string} suffix
   * @param {{ mode?: 'forward' | 'rollback', applyAction?: number }} [options]
   */
  function runTransition(suffix, options = {}) {
    const transitionId = randomUUID();
    if (options.mode === 'rollback') {
      // Use the real composite verb path: it validates that the target is a
      // previously staged descriptor, refuses a non-ACTIVE record and reserves
      // `highWaterGeneration + 1` through the ordinary compare-and-swap write.
      const started = startRollback(store, {
        descriptor,
        transitionId,
        expectedRevision: record.revision,
      });
      record = started.record;
      phases.push({
        phase: record.phase,
        generation: record.generation,
        reserved: record.nextGeneration,
        via: 'rollback',
        controlFilesCopied: started.controlFilesCopied,
      });
    } else {
      record = store.transact(
        { action: 'quiesce', descriptor, transitionId },
        { expectedRevision: record.revision },
      ).record;
      phases.push({ phase: record.phase, generation: record.generation, reserved: record.nextGeneration, via: 'quiesce' });
    }

    // Retire every old member with a synthetic QUIESCED ack.
    for (const member of record.transition.oldMembers) {
      const ack = ackFor(record, record.active, member.slot, member.instanceId, member.artifactSha256, ACK_STATUS.QUIESCED);
      const written = store.writeAck(record.transitionId, member.slot, member.instanceId, ACK_STATUS.QUIESCED, ack);
      record = store.transact({
        action: 'retire',
        slot: member.slot,
        instanceId: member.instanceId,
        kind: 'QUIESCED',
        evidenceSha256: written.sha256,
      }, { expectedRevision: record.revision }).record;
    }
    record = store.transact({ action: 'prepare' }, { expectedRevision: record.revision }).record;
    phases.push({ phase: record.phase, generation: record.generation });

    if (Number.isSafeInteger(options.applyAction)) {
      // A declared normal deterministic action (a trailing-stop adjustment, a
      // harvest close) lands here, inside the PREPARING barrier, tagged with the
      // generation this transition is about to commit. Deterministic protection
      // is not paused by a transition, which is exactly the case the G5 journal
      // criterion is about.
      applyDeclaredAction(options.applyAction, record.nextGeneration, record.phase);
    }

    // Synthetic target participants (a fresh instance per slot per generation).
    const instances = new Map();
    for (const entry of descriptor.inventory) {
      if (!entry.enabled) continue;
      const instanceId = `rehearsal-${entry.slot}-${suffix}`;
      instances.set(entry.slot, instanceId);
      const artifact = descriptor.artifacts.find((candidate) => candidate.slot === entry.slot).artifactSha256;
      record = store.transact({
        action: 'register-target',
        descriptor,
        slot: entry.slot,
        instanceId,
        artifactSha256: artifact,
      }, { expectedRevision: record.revision }).record;
      const ack = ackFor(record, descriptor.binding, entry.slot, instanceId, artifact, ACK_STATUS.PREPARED);
      const written = store.writeAck(record.transitionId, entry.slot, instanceId, ACK_STATUS.PREPARED, ack);
      record = store.transact({
        action: 'prepare-ack',
        ack,
        evidenceSha256: written.sha256,
      }, { expectedRevision: record.revision }).record;
    }

    for (const observer of descriptor.observers) {
      const validation = validateObserverIdentity({
        controlStore: store,
        deploymentId: record.deploymentId,
        expectedManifestVersion: descriptor.binding.manifestVersion,
        expectedManifestSha256: descriptor.binding.manifestSha256,
        artifactSha256: observer.artifactSha256,
        transitionId: record.transitionId,
        observerId: observer.observerId,
      });
      const receipt = buildObserverReceipt(validation, {
        deploymentId: record.deploymentId,
        transitionId: record.transitionId,
        observerId: observer.observerId,
        artifactSha256: observer.artifactSha256,
      });
      const written = store.writeObserverReceipt(record.transitionId, observer.observerId, receipt);
      record = store.transact({
        action: 'observer-evidence',
        descriptor,
        receipt,
        evidenceSha256: written.sha256,
      }, { expectedRevision: record.revision }).record;
    }

    record = store.transact({ action: 'arm', descriptor }, { expectedRevision: record.revision }).record;
    phases.push({ phase: record.phase, generation: record.generation });
    record = store.transact({ action: 'activate', descriptor }, { expectedRevision: record.revision }).record;
    phases.push({ phase: record.phase, generation: record.generation, members: record.members.length });
    return { transitionId, instances: Object.fromEntries(instances), via: options.mode ?? 'quiesce' };
  }

  const forward = runTransition('fwd', { applyAction: 0 });
  const rollback = runTransition('rb', { mode: 'rollback', applyAction: 1 });
  const financialState = buildJournalProof({
    before: FIXTURE_JOURNAL_BASE,
    after: journal,
    declaredActions: DECLARED_FIXTURE_ACTIONS,
  });
  const financialOk = financialState.residualEqual
    && financialState.noDuplicateEntry
    && financialState.declaredActionsApplied;

  const result = {
    ok: record.phase === 'ACTIVE' && record.generation === 2 && financialOk,
    descriptorSha256: descriptorSha,
    deploymentId: record.deploymentId,
    phases,
    forward,
    rollback,
    final: {
      phase: record.phase,
      generation: record.generation,
      highWaterGeneration: record.highWaterGeneration,
      manifestVersion: record.active.manifestVersion,
      manifestSha256: record.active.manifestSha256,
      members: record.members,
    },
    evidence: {
      ackDirectories: fs.readdirSync(path.join(controlDir, 'acks')),
      transitionArchives: fs.readdirSync(path.join(controlDir, 'transitions')),
      auditLines: fs.readFileSync(path.join(controlDir, 'audit.jsonl'), 'utf8').trim().split('\n').length,
    },
    financialState,
    note: 'fake effects only: no provider, exchange, Telegram or account call was made; the financial-state equality in financialState is proven on the synthetic fixture journal, not on live financial state',
  };
  if (values.report) {
    fs.mkdirSync(path.dirname(path.resolve(values.report)), { recursive: true });
    fs.writeFileSync(path.resolve(values.report), `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const isEntryPoint = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '');
if (isEntryPoint) {
  try {
    main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } })}\n`);
    process.exitCode = 1;
  }
}
