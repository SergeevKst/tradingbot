/**
 * UAI-05C — runtime identity guard and whole-work fencing.
 *
 * The property under test is the one process-local validation cannot provide:
 * no retired work token, delayed response, pending approval or check-to-effect
 * race can produce an authoritative effect after the generation moved on, and a
 * QUIESCED acknowledgement cannot be issued while any of those can still act.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createGenerationGuard } from '../src/ai/coordination/generation-guard.mjs';
import { COORDINATION_ERROR_CODE } from '../src/errors/coordination-error.mjs';
import {
  advanceBarrier,
  activateFixture,
  artifactDigest,
  buildAck,
  buildAlternateDescriptor,
  buildReleaseFixture,
  buildTestGuard,
  guardConfigFor,
} from './fixtures/ai-release/factory.mjs';

/**
 * Deferred promise helper so a response can be held across a transition.
 */
function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** @param {any} fixture @param {string} slot @param {string} instanceId */
function startGuard(fixture, slot, instanceId, options = {}) {
  const guard = buildTestGuard(fixture, { slot, instanceId, ...options });
  const status = guard.start();
  return { guard, status };
}

test('UAI-05C guard: an ACTIVE deployment admits the committed generation only after a re-read', () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { guard, status } = startGuard(fixture, 'telegram', 'inst-tg-1');
  assert.equal(status.identityReady, true);
  assert.equal(status.inferenceEnabled, true);
  assert.equal(status.generation, 1);
  assert.equal(status.manifestVersion, 'release-1');
  assert.equal(guard.getRuntime().generation, 1);
});

test('UAI-05C guard: stale launch expectations fail before any provider request', () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const config = { ...guardConfigFor(fixture, 'telegram'), expectedManifestSha256: 'c'.repeat(64) };
  const calls = [];
  const guard = createGenerationGuard({
    controlStore: fixture.store,
    config,
    instanceId: 'inst-tg-x',
    runtimeFactory: () => {
      calls.push('runtime-built');
      return { complete: async () => ({}) };
    },
  });
  const status = guard.start();
  assert.equal(status.identityReady, false);
  assert.equal(status.errorCode, COORDINATION_ERROR_CODE.MANIFEST_STALE);
  assert.throws(() => guard.beginWork('SCOUT'), /admission is closed/);
  assert.deepEqual(calls, [], 'no runtime may be constructed for a rejected identity');
});

test('UAI-05C guard: a wrong deployment ID, a disabled slot and a non-member all fail closed', () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);

  const wrongDeployment = createGenerationGuard({
    controlStore: fixture.store,
    config: { ...guardConfigFor(fixture, 'telegram'), deploymentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    instanceId: 'inst-a',
    runtimeFactory: () => ({ complete: async () => ({}) }),
  });
  assert.equal(wrongDeployment.start().errorCode, COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);

  const wrongArtifact = createGenerationGuard({
    controlStore: fixture.store,
    config: { ...guardConfigFor(fixture, 'telegram'), artifactSha256: artifactDigest('other-build') },
    instanceId: 'inst-b',
    runtimeFactory: () => ({ complete: async () => ({}) }),
  });
  assert.equal(wrongArtifact.start().errorCode, COORDINATION_ERROR_CODE.ARTIFACT_MISMATCH);

  const disabled = createGenerationGuard({
    controlStore: fixture.store,
    config: { ...guardConfigFor(fixture, 'legacy-slot') },
    instanceId: 'inst-c',
    runtimeFactory: () => ({ complete: async () => ({}) }),
  });
  assert.equal(disabled.start().errorCode, COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED);
});

test('UAI-05C guard: a participant refuses to start while the store is QUIESCING or PAUSED', () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const record = fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: 'aaaa1111-1111-4111-8111-111111111111' },
    { expectedRevision: active.record.revision },
  ).record;
  assert.equal(record.phase, 'QUIESCING');
  const guard = buildTestGuard(fixture, { slot: 'telegram', instanceId: 'inst-late' });
  const status = guard.start();
  assert.equal(status.identityReady, false);
  assert.ok([COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, COORDINATION_ERROR_CODE.GENERATION_RETIRED].includes(status.errorCode));
  assert.throws(() => guard.beginWork('SCOUT'));
});

test('UAI-05C guard: an observer validates identity but never claims a slot or admits work', () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const guard = createGenerationGuard({
    controlStore: fixture.store,
    config: { ...guardConfigFor(fixture, 'core-analysis'), slot: null, artifactSha256: null },
    observer: true,
    instanceId: 'observer-1',
    runtimeFactory: () => {
      throw new Error('an observer must not build a runtime');
    },
  });
  const status = guard.start();
  assert.equal(status.identityReady, true);
  assert.equal(status.inferenceEnabled, false);
  assert.equal(status.slot, null);
  assert.throws(() => guard.beginWork('ANALYZE'), /observer cannot perform AI work/);
  // The committed roster is untouched: no slot was claimed.
  assert.equal(fixture.store.readRecord().members.length, 2);
});

test('UAI-05C guard: work is counted synchronously and QUIESCED cannot be acknowledged early', () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const { guard } = startGuard(fixture, 'telegram', 'inst-tg-1');
  const token = guard.beginWork('SCOUT');
  assert.equal(guard.status().outstandingWork, 1);

  fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: 'bbbb2222-2222-4222-8222-222222222222' },
    { expectedRevision: active.record.revision },
  );
  guard.poll();
  assert.equal(guard.status().admissionOpen, false, 'QUIESCING closes admission immediately');
  assert.throws(
    () => guard.acknowledgeQuiesced(),
    (error) => error.code === COORDINATION_ERROR_CODE.WORK_OUTSTANDING,
  );
  assert.throws(() => guard.beginWork('SCOUT'), /admission is closed/);

  // A delayed response is rejected at the post-response checkpoint.
  assert.throws(
    () => guard.check(token),
    (error) => [COORDINATION_ERROR_CODE.GENERATION_RETIRED, COORDINATION_ERROR_CODE.ACTIVATION_PAUSED].includes(error.code),
  );
  guard.endWork(token);
  assert.equal(guard.status().outstandingWork, 0);
  const ack = guard.acknowledgeQuiesced();
  assert.equal(ack.ack.status, 'QUIESCED');
  assert.equal(ack.ack.outstandingWork, 0);
});

test('UAI-05C guard: a delayed response cannot reach an effect after activation', async () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const held = deferred();
  const effects = [];
  const { guard } = startGuard(fixture, 'telegram', 'inst-tg-1', {
    invoke: async () => {
      await held.promise;
      return { ok: true };
    },
  });
  const runtime = guard.getRuntime();

  const inFlight = runtime.complete('SCOUT', { context: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guard.status().outstandingWork, 1);

  // Operator starts a transition while the response is in flight.
  fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: 'cccc3333-3333-4333-8333-333333333333' },
    { expectedRevision: active.record.revision },
  );
  guard.poll();
  assert.throws(() => guard.acknowledgeQuiesced(), /outstanding AI work/);

  held.resolve();
  await assert.rejects(
    inFlight,
    (error) => [COORDINATION_ERROR_CODE.GENERATION_RETIRED, COORDINATION_ERROR_CODE.ACTIVATION_PAUSED].includes(error.code),
  );
  // No effect was dispatched and the workflow counter is back to zero.
  assert.deepEqual(effects, []);
  assert.equal(guard.status().outstandingWork, 0);
  // The token was released, so the participant can now acknowledge quiescence.
  assert.equal(guard.acknowledgeQuiesced().ack.status, 'QUIESCED');
});

test('UAI-05C guard: the check-to-effect race is closed by the counted scope, not by a timer', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const effects = [];
  const { guard } = startGuard(fixture, 'telegram', 'inst-tg-1');
  const token = guard.beginWork('GUARD');
  guard.check(token);
  // Between the check and the dispatch, the generation is retired.
  fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: 'dddd4444-4444-4444-8444-444444444444' },
    { expectedRevision: fixture.store.readRecord().revision },
  );
  assert.throws(() => {
    guard.check(token);
    effects.push('order-dispatched');
  });
  assert.deepEqual(effects, []);
  guard.endWork(token);
  // After the drain the barrier can advance; the effect never happened.
  assert.equal(guard.acknowledgeQuiesced().ack.status, 'QUIESCED');
});

test('UAI-05C guard: pending approvals carry a generation and are consumed exactly once', () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { guard } = startGuard(fixture, 'telegram', 'inst-tg-1');
  guard.registerPendingApproval('batch:0', { operation: 'GUARD' });
  assert.equal(guard.pendingApprovalCount(), 1);

  const scope = guard.beginApprovalConsumption('batch:0');
  assert.equal(scope.token.operation, 'GUARD');
  assert.equal(guard.pendingApprovalCount(), 0);
  assert.equal(guard.status().outstandingWork, 1);
  assert.throws(() => guard.beginApprovalConsumption('batch:0'), /no pending AI approval/);
  scope.settle();
  assert.equal(guard.status().outstandingWork, 0);
});

test('UAI-05C guard: pending approvals are invalidated at quiescence and a late callback is rejected', () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const { guard } = startGuard(fixture, 'telegram', 'inst-tg-1');
  guard.registerPendingApproval('batch:1', { operation: 'GUARD' });
  fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: 'eeee5555-5555-4555-8555-555555555555' },
    { expectedRevision: active.record.revision },
  );
  guard.poll();
  assert.equal(guard.pendingApprovalCount(), 0);
  assert.throws(() => guard.beginApprovalConsumption('batch:1'), /ACTIVATION_PAUSED|not active|no pending/);
  // The process restarts: the sidecar is gone, so the callback is rejected even
  // in the same generation.
  const restarted = startGuard(fixture, 'telegram', 'inst-tg-2');
  assert.equal(restarted.guard.status().inferenceEnabled, false);
  assert.throws(() => restarted.guard.beginApprovalConsumption('batch:1'));
});

test('UAI-05C guard: a staged runtime promotes only after the committed ACTIVE record matches', () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const { guard } = startGuard(fixture, 'telegram', 'inst-tg-1');
  const target = buildAlternateDescriptor({ fixture, manifestVersion: 'release-2' });

  // The coordinator drives the barrier up to ARMED without this guard's ack, so
  // staging has to happen between PREPARING and arm.
  let record = fixture.store.transact(
    { action: 'quiesce', descriptor: target.descriptor, transitionId: 'ffff6666-6666-4666-8666-666666666666' },
    { expectedRevision: active.record.revision },
  ).record;
  guard.poll();
  const quiesced = guard.acknowledgeQuiesced();
  record = fixture.store.transact({
    action: 'retire', slot: 'telegram', instanceId: 'inst-tg-1', kind: 'QUIESCED', evidenceSha256: quiesced.sha256,
  }, { expectedRevision: record.revision }).record;
  const coreFence = {
    schemaVersion: 1,
    deploymentId: record.deploymentId,
    transitionId: record.transitionId,
    slot: 'core-analysis',
    instanceId: 'inst-core-1',
    operatorApprovalId: 'approval-fence-1',
    processFenceEvidenceRef: 'evidence/fencing.txt',
    outcomeReconciliationRef: 'evidence/reconciliation.txt',
  };
  const fence = fixture.store.writeFenceEvidence(record.transitionId, 'core-analysis', 'inst-core-1', coreFence);
  record = fixture.store.transact({
    action: 'retire', slot: 'core-analysis', instanceId: 'inst-core-1', kind: 'FENCED', evidenceSha256: fence.sha256,
  }, { expectedRevision: record.revision }).record;
  record = fixture.store.transact({ action: 'prepare' }, { expectedRevision: record.revision }).record;
  record = fixture.store.transact({
    action: 'stage-grant', descriptor: target.descriptor, slot: 'telegram', instanceId: 'inst-tg-1',
  }, { expectedRevision: record.revision }).record;

  // A grant that does not match the record is refused.
  assert.throws(
    () => guard.prepareTarget({ descriptorSha256: target.descriptorSha256, approvalId: 'wrong-approval' }),
    /stage grant does not match/,
  );
  const staged = guard.prepareTarget({ descriptorSha256: record.transition.descriptorSha256, approvalId: record.approvalId });
  assert.equal(staged.generation, 2);
  assert.equal(guard.status().inferenceEnabled, false, 'staging never admits inference');
  assert.throws(() => guard.beginWork('SCOUT'), /admission is closed/);

  record = fixture.store.transact({ action: 'prepare-ack', ack: staged.ack, evidenceSha256: staged.sha256 }, {
    expectedRevision: record.revision,
  }).record;
  record = fixture.store.transact({
    action: 'register-target', descriptor: target.descriptor, slot: 'core-analysis', instanceId: 'inst-core-2',
    artifactSha256: target.artifacts.find((entry) => entry.slot === 'core-analysis').artifactSha256,
  }, { expectedRevision: record.revision }).record;
  const coreAck = buildAck({
    record, slot: 'core-analysis', instanceId: 'inst-core-2', status: 'PREPARED',
    artifactSha256: target.artifacts.find((entry) => entry.slot === 'core-analysis').artifactSha256,
    binding: target.binding,
  });
  const coreWritten = fixture.store.writeAck(record.transitionId, 'core-analysis', 'inst-core-2', 'PREPARED', coreAck);
  record = fixture.store.transact({ action: 'prepare-ack', ack: coreAck, evidenceSha256: coreWritten.sha256 }, {
    expectedRevision: record.revision,
  }).record;
  const receipt = {
    schemaVersion: 1,
    deploymentId: record.deploymentId,
    transitionId: record.transitionId,
    observerId: 'core-bootstrap',
    artifactSha256: target.artifacts.find((entry) => entry.slot === 'core-analysis').artifactSha256,
    manifestVersion: target.binding.manifestVersion,
    manifestSha256: target.binding.manifestSha256,
    capabilityProfileSha256: target.binding.capabilityProfileSha256,
    status: 'VALIDATED',
    errorCode: null,
  };
  const receiptFile = fixture.store.writeObserverReceipt(record.transitionId, 'core-bootstrap', receipt);
  record = fixture.store.transact({ action: 'observer-evidence', descriptor: target.descriptor, receipt, evidenceSha256: receiptFile.sha256 }, {
    expectedRevision: record.revision,
  }).record;
  record = fixture.store.transact({ action: 'arm' }, { expectedRevision: record.revision }).record;
  assert.equal(record.phase, 'ARMED');

  // Still gated while ARMED.
  guard.poll();
  assert.equal(guard.status().inferenceEnabled, false);

  record = fixture.store.transact({ action: 'activate' }, { expectedRevision: record.revision }).record;
  assert.equal(record.phase, 'ACTIVE');
  guard.poll();
  assert.equal(guard.status().generation, 2);
  assert.equal(guard.status().inferenceEnabled, true);
  assert.equal(guard.getRuntime().generation, 2);
  assert.equal(guard.status().manifestVersion, 'release-2');
});

test('UAI-05C guard: an unreadable store gates AI without changing the active binding', () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { guard } = startGuard(fixture, 'telegram', 'inst-tg-1');
  const recordPath = path.join(fixture.controlDir, 'control.json');
  fs.chmodSync(recordPath, 0o000);
  try {
    assert.throws(
      () => guard.beginWork('SCOUT'),
      (error) => error.code === COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE,
    );
  } finally {
    fs.chmodSync(recordPath, 0o600);
  }
  assert.equal(guard.status().admissionOpen, false);
  // The committed binding on disk is untouched.
  assert.equal(fixture.store.readRecord().generation, 1);
});

test('UAI-05C guard: drift while ACTIVE closes admission and names no alternate model', () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { guard } = startGuard(fixture, 'telegram', 'inst-tg-1');
  const token = guard.beginWork('SCOUT');
  guard.endWork(token);

  // A checksum-valid record with a different binding for the same generation is
  // outside the trusted-writer boundary; the guard must notice and gate.
  const record = fixture.store.readRecord();
  const tampered = {
    ...record,
    revision: record.revision + 1,
    active: {
      ...record.active,
      manifestSha256: 'd'.repeat(64),
    },
  };
  fs.writeFileSync(path.join(fixture.controlDir, 'control.json'), JSON.stringify(tampered));
  assert.throws(
    () => guard.beginWork('SCOUT'),
    (error) => error.code === COORDINATION_ERROR_CODE.GENERATION_RETIRED,
  );
  assert.equal(guard.status().admissionOpen, false);
  assert.equal(guard.status().manifestVersion, 'release-1', 'the guard keeps its own identity, it never rebinds');
});

test('UAI-05C guard: a rollback to the same digest does not revive an old token', () => {
  const fixture = buildReleaseFixture();
  const first = activateFixture(fixture);
  const { guard } = startGuard(fixture, 'telegram', 'inst-tg-1');
  const core = startGuard(fixture, 'core-analysis', 'inst-core-1').guard;
  const oldToken = guard.beginWork('SCOUT');
  guard.endWork(oldToken);

  // Same manifest digest, higher generation (a real rollback is a new barrier).
  const result = advanceBarrier(fixture, {
    descriptor: fixture.descriptor,
    participants: [
      { guard: core, slot: 'core-analysis', instanceId: 'inst-core-1' },
      { guard, slot: 'telegram', instanceId: 'inst-tg-1' },
    ],
    transitionId: 'abababab-2222-4222-8222-abababababab',
  });
  guard.poll();
  assert.equal(guard.status().generation, 2);
  assert.equal(guard.status().inferenceEnabled, true);
  assert.throws(() => guard.check(oldToken), /not active/);
  const newToken = guard.beginWork('SCOUT');
  assert.equal(newToken.generation, 2);
  guard.endWork(newToken);
  assert.equal(result.record.generation, 2);
  assert.ok(first.record.generation === 1);
});
