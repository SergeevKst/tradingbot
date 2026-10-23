/**
 * UAI-05B / UAI-09 — the `rollback` verb the approved handoff names.
 *
 * The handoff (UAI-05B) defines `rollback` as "orchestrates a new transition,
 * never copies control files". These tests hold the verb to exactly that: it
 * opens the ordinary barrier for a *previously staged* descriptor at a strictly
 * higher generation through one compare-and-swap write, and it refuses every
 * shape that would turn it into a shortcut (no staging, a retained transition, a
 * stale revision, no explicit transition id).
 *
 * The store, the descriptor and the transition evidence are all real; only the
 * participants, the artefacts and the effects are fixtures.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startRollback } from '../src/ai/coordination/rollback-transition.mjs';
import {
  computeInventoryDigest,
  computeReleaseDescriptorDigest,
} from '../src/config/ai-release-schema.mjs';
import { COORDINATION_ERROR_CODE } from '../src/errors/coordination-error.mjs';
import {
  activateFixture,
  buildAck,
  buildReleaseFixture,
} from './fixtures/ai-release/factory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(HERE, '..', 'scripts', 'ai_release.mjs');
const TRANSITION_ID = '9f9d1bb6-4d63-4c31-9f45-0e1d5d2ab7c1';

/** An ACTIVE deployment at generation 1, on a real durable store. */
function activeFixture() {
  const fixture = activateFixture(buildReleaseFixture());
  const record = fixture.store.readRecord();
  assert.equal(record.phase, 'ACTIVE');
  assert.equal(record.generation, 1);
  return { fixture, record };
}

/** @param {ReturnType<typeof buildReleaseFixture>} fixture @param {string} name */
function writeDescriptor(fixture, name, descriptor = fixture.descriptor) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-rollback-'));
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(descriptor));
  return file;
}

/** @param {{ fixture: any }} harness @param {Record<string, string | undefined>} args */
function runCli(harness, args) {
  const argv = [CLI_ENTRY, 'rollback', '--control-dir', harness.fixture.controlDir];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    argv.push(`--${key}`, value);
  }
  const result = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 30000 });
  const line = (result.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '{}';
  let body;
  try {
    body = JSON.parse(line);
  } catch {
    body = { ok: false, error: { code: 'CLI_OUTPUT', message: line || result.stderr } };
  }
  return { status: result.status, body };
}

/**
 * Complete the rollback barrier with synthetic participants, so the test proves
 * the verb opens a transition that can actually be committed — not just that a
 * phase string changed.
 *
 * @param {ReturnType<typeof buildReleaseFixture>} fixture
 * @param {string} suffix
 */
function completeBarrier(fixture, suffix) {
  const store = fixture.store;
  const descriptor = fixture.descriptor;
  let record = store.readRecord();
  assert.equal(record.phase, 'QUIESCING');
  const activeBinding = record.active;

  for (const member of record.transition.oldMembers) {
    const ack = buildAck({
      record,
      slot: member.slot,
      instanceId: member.instanceId,
      status: 'QUIESCED',
      artifactSha256: member.artifactSha256,
      binding: activeBinding,
    });
    const written = store.writeAck(record.transitionId, member.slot, member.instanceId, 'QUIESCED', ack);
    record = store.transact({
      action: 'retire',
      slot: member.slot,
      instanceId: member.instanceId,
      kind: 'QUIESCED',
      evidenceSha256: written.sha256,
    }, { expectedRevision: record.revision }).record;
  }
  record = store.transact({ action: 'prepare' }, { expectedRevision: record.revision }).record;

  /** @type {Record<string, string>} */
  const instances = {};
  for (const entry of descriptor.inventory) {
    if (!entry.enabled) continue;
    const instanceId = `rollback-${entry.slot}-${suffix}`;
    instances[entry.slot] = instanceId;
    const artifact = descriptor.artifacts.find((candidate) => candidate.slot === entry.slot).artifactSha256;
    record = store.transact({
      action: 'register-target',
      descriptor,
      slot: entry.slot,
      instanceId,
      artifactSha256: artifact,
    }, { expectedRevision: record.revision }).record;
    const ack = buildAck({
      record,
      slot: entry.slot,
      instanceId,
      status: 'PREPARED',
      artifactSha256: artifact,
      binding: descriptor.binding,
    });
    const written = store.writeAck(record.transitionId, entry.slot, instanceId, 'PREPARED', ack);
    record = store.transact({
      action: 'prepare-ack',
      ack,
      evidenceSha256: written.sha256,
    }, { expectedRevision: record.revision }).record;
  }

  for (const observer of descriptor.observers) {
    const receipt = {
      schemaVersion: 1,
      deploymentId: record.deploymentId,
      transitionId: record.transitionId,
      observerId: observer.observerId,
      artifactSha256: observer.artifactSha256,
      manifestVersion: descriptor.binding.manifestVersion,
      manifestSha256: descriptor.binding.manifestSha256,
      capabilityProfileSha256: descriptor.binding.capabilityProfileSha256,
      status: 'VALIDATED',
      errorCode: null,
    };
    const written = store.writeObserverReceipt(record.transitionId, observer.observerId, receipt);
    record = store.transact({
      action: 'observer-evidence',
      descriptor,
      receipt,
      evidenceSha256: written.sha256,
    }, { expectedRevision: record.revision }).record;
  }

  record = store.transact({ action: 'arm', descriptor }, { expectedRevision: record.revision }).record;
  record = store.transact({ action: 'activate', descriptor }, { expectedRevision: record.revision }).record;
  return { record, instances };
}

test('rollback: opens a new barrier at highWater + 1 through one compare-and-swap write', () => {
  const { fixture, record } = activeFixture();
  const before = JSON.stringify(record);
  const result = startRollback(fixture.store, {
    descriptor: fixture.descriptor,
    transitionId: TRANSITION_ID,
    expectedRevision: record.revision,
  });

  assert.equal(result.fromGeneration, 1);
  assert.equal(result.reservedGeneration, 2);
  assert.equal(result.controlFilesCopied, false);
  assert.equal(result.descriptorSha256, computeReleaseDescriptorDigest(fixture.descriptor));
  assert.equal(result.record.phase, 'QUIESCING');
  assert.equal(result.record.generation, 1);
  assert.equal(result.record.nextGeneration, 2);
  assert.equal(result.record.highWaterGeneration, 2);
  assert.equal(result.record.transitionId, TRANSITION_ID);
  assert.equal(result.record.transition.descriptorSha256, result.descriptorSha256);
  assert.equal(result.record.transition.oldMembers.length, record.members.length);
  // Exactly one durable revision was added: the record was produced by the store
  // from the current one, not written from a copy of an older file.
  assert.equal(result.record.revision, record.revision + 1);
  assert.notEqual(JSON.stringify(result.record), before);
  assert.equal(fixture.store.readRecord().transitionId, TRANSITION_ID);
});

test('rollback: a completed barrier commits the higher generation with the same binding', () => {
  const { fixture } = activeFixture();
  const started = startRollback(fixture.store, {
    descriptor: fixture.descriptor,
    transitionId: TRANSITION_ID,
  });
  assert.equal(started.record.phase, 'QUIESCING');

  const { record, instances } = completeBarrier(fixture, 'gen2');
  assert.equal(record.phase, 'ACTIVE');
  assert.equal(record.generation, 2);
  assert.equal(record.highWaterGeneration, 2);
  assert.equal(record.releaseDescriptorSha256, computeReleaseDescriptorDigest(fixture.descriptor));
  assert.deepEqual(
    record.members.map((member) => member.instanceId).sort(),
    Object.values(instances).sort(),
  );
});

test('rollback: a retained transition cannot be restarted as a rollback', () => {
  const { fixture } = activeFixture();
  startRollback(fixture.store, { descriptor: fixture.descriptor, transitionId: TRANSITION_ID });
  assert.throws(
    () => startRollback(fixture.store, {
      descriptor: fixture.descriptor,
      transitionId: '11111111-2222-4333-8444-555555555555',
    }),
    (error) => error.code === COORDINATION_ERROR_CODE.INVALID_TRANSITION
      && /continue a retained transition with recover/.test(error.message),
  );
});

test('rollback: a descriptor this deployment never staged is refused', () => {
  const { fixture } = activeFixture();
  // A schema-valid descriptor whose approval id is not the staged one: the
  // binding is unchanged, so only the "was it staged?" rule can reject it.
  const unstaged = { ...fixture.descriptor, approvalId: 'approval-never-staged' };
  assert.notEqual(
    computeReleaseDescriptorDigest(unstaged),
    computeReleaseDescriptorDigest(fixture.descriptor),
  );
  assert.throws(
    () => startRollback(fixture.store, { descriptor: unstaged, transitionId: TRANSITION_ID }),
    (error) => error.code === COORDINATION_ERROR_CODE.INVALID_EVIDENCE
      && /previously staged release descriptor/.test(error.message)
      && error.details.descriptorSha256 === computeReleaseDescriptorDigest(unstaged),
  );
});

test('rollback: a stale expected revision is refused (no writer takeover)', () => {
  const { fixture, record } = activeFixture();
  assert.throws(
    () => startRollback(fixture.store, {
      descriptor: fixture.descriptor,
      transitionId: TRANSITION_ID,
      expectedRevision: record.revision - 1,
    }),
    (error) => error.code === COORDINATION_ERROR_CODE.INVALID_TRANSITION
      && error.details.actualRevision === record.revision,
  );
  assert.equal(fixture.store.readRecord().phase, 'ACTIVE');
});

test('rollback: an empty transition id is refused', () => {
  const { fixture } = activeFixture();
  assert.throws(
    () => startRollback(fixture.store, { descriptor: fixture.descriptor, transitionId: '' }),
    (error) => error.code === COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
  );
});

test('rollback CLI: the verb exists, starts the barrier and reports no file copy', () => {
  const { fixture, record } = activeFixture();
  const descriptorPath = writeDescriptor(fixture, 'rollback-target');
  const result = runCli({ fixture }, { descriptor: descriptorPath, 'transition-id': TRANSITION_ID });

  assert.equal(result.status, 0, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(result.body.rollback, true);
  assert.equal(result.body.controlFilesCopied, false);
  assert.equal(result.body.phase, 'QUIESCING');
  assert.equal(result.body.previousGeneration, 1);
  assert.equal(result.body.reservedGeneration, 2);
  assert.equal(result.body.rollbackDescriptorSha256, computeReleaseDescriptorDigest(fixture.descriptor));
  assert.deepEqual(result.body.nextSteps, [
    'collect-quiescence',
    'prepare',
    'grant|register + collect-prepared',
    'observer (required observers)',
    'arm',
    'activate',
  ]);
  const stored = fixture.store.readRecord();
  assert.equal(stored.revision, record.revision + 1);
  assert.equal(stored.transitionId, TRANSITION_ID);
  assert.equal(stored.inventory.length, fixture.inventory.length);
  assert.equal(computeInventoryDigest(stored.inventory), computeInventoryDigest(fixture.inventory));
});

test('rollback CLI: a missing transition id is refused with a nonzero exit', () => {
  const { fixture } = activeFixture();
  const descriptorPath = writeDescriptor(fixture, 'rollback-target');
  const result = runCli({ fixture }, { descriptor: descriptorPath });
  assert.equal(result.status, 1);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error.message, /transition-id/);
  assert.equal(fixture.store.readRecord().phase, 'ACTIVE');
});

test('rollback CLI: a never-staged descriptor is refused with a nonzero exit', () => {
  const { fixture } = activeFixture();
  const descriptorPath = writeDescriptor(fixture, 'unstaged', { ...fixture.descriptor, approvalId: 'approval-never-staged' });
  const result = runCli({ fixture }, { descriptor: descriptorPath, 'transition-id': TRANSITION_ID });
  assert.equal(result.status, 1);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error.code, COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  assert.match(result.body.error.message, /previously staged/);
  assert.equal(fixture.store.readRecord().phase, 'ACTIVE');
});
