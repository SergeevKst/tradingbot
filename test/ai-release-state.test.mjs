/**
 * UAI-05B — release state machine (`release-state.mjs`) and durable store
 * transitions. These tests exercise the legal-edge table and the invariants that
 * make the barrier safe: no quorum, no timeout, monotonic generations, retained
 * evidence, and recovery that keeps every old and target obligation.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  applyReleaseCommand,
  describeBarrierBlockers,
  retirementState,
} from '../src/ai/coordination/release-state.mjs';
import {
  computeReleaseDescriptorDigest,
} from '../src/config/ai-release-schema.mjs';
import { COORDINATION_ERROR_CODE } from '../src/errors/coordination-error.mjs';
import {
  activateFixture,
  advanceBarrier,
  artifactDigest,
  buildAck,
  buildAlternateDescriptor,
  buildReleaseFixture,
  buildTestGuard,
} from './fixtures/ai-release/factory.mjs';

const TRANSITION_ID = '11111111-1111-4111-8111-111111111111';

/** @param {any} fixture */
function initialized(fixture) {
  return fixture.store.initialize({ inventory: fixture.inventory }).record;
}

/** @param {any} fixture @param {any} record */
function quiesced(fixture, record, descriptor = fixture.descriptor) {
  return fixture.store.transact(
    { action: 'quiesce', descriptor, transitionId: TRANSITION_ID },
    { expectedRevision: record.revision },
  ).record;
}

/** @param {any} error @param {string} code */
function hasCode(error, code) {
  return error?.code === code;
}

test('UAI-05B: bootstrap is PAUSED with generation 0 and no inferred ACTIVE', () => {
  const fixture = buildReleaseFixture();
  const record = initialized(fixture);
  assert.equal(record.phase, 'PAUSED');
  assert.equal(record.generation, 0);
  assert.equal(record.highWaterGeneration, 0);
  assert.equal(record.active, null);
  assert.equal(record.transition, null);
  assert.throws(() => fixture.store.initialize({ inventory: fixture.inventory }), /already initialized/);
  // A missing store is not an ACTIVE one.
  const empty = buildReleaseFixture();
  assert.equal(empty.store.tryReadRecord(), null);
});

test('UAI-05B: quiesce reserves generation 1, snapshots the empty roster and publishes QUIESCING', () => {
  const fixture = buildReleaseFixture();
  const record = initialized(fixture);
  const next = quiesced(fixture, record);
  assert.equal(next.phase, 'QUIESCING');
  assert.equal(next.nextGeneration, 1);
  assert.equal(next.highWaterGeneration, 1);
  assert.equal(next.generation, 0);
  assert.equal(next.target.manifestSha256, fixture.manifestSha256);
  assert.equal(next.transition.oldMembers.length, 0, 'the initial empty barrier is valid');
  assert.equal(next.transitionId, TRANSITION_ID);
});

test('UAI-05B: prepare refuses until every old member is quiesced or fenced', () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const record = fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: '33333333-3333-4333-8333-333333333333' },
    { expectedRevision: active.record.revision },
  ).record;
  assert.equal(record.transition.oldMembers.length, 2);
  assert.throws(
    () => fixture.store.transact({ action: 'prepare' }, { expectedRevision: record.revision }),
    (error) => hasCode(error, COORDINATION_ERROR_CODE.INVALID_EVIDENCE),
  );

  // One ack is not a quorum.
  const coreAck = buildAck({
    record,
    slot: 'core-analysis',
    instanceId: 'inst-core-1',
    status: 'QUIESCED',
    artifactSha256: fixture.artifactMap['core-analysis'],
    binding: fixture.binding,
  });
  const written = fixture.store.writeAck(record.transitionId, 'core-analysis', 'inst-core-1', 'QUIESCED', coreAck);
  fixture.store.transact({
    action: 'retire',
    slot: 'core-analysis',
    instanceId: 'inst-core-1',
    kind: 'QUIESCED',
    evidenceSha256: written.sha256,
  }, { expectedRevision: record.revision });
  assert.throws(
    () => fixture.store.transact({ action: 'prepare' }, { expectedRevision: record.revision + 1 }),
    /barrier incomplete/,
  );
});

test('UAI-05B: arm requires one exact PREPARED participant per enabled slot and a valid observer', () => {
  const fixture = buildReleaseFixture();
  const record = quiesced(fixture, initialized(fixture));
  let current = fixture.store.transact({ action: 'prepare' }, { expectedRevision: record.revision }).record;
  assert.equal(current.phase, 'PREPARING');

  // Nothing registered yet.
  assert.throws(
    () => fixture.store.transact({ action: 'arm' }, { expectedRevision: current.revision }),
    /no registered or granted participant/,
  );

  const instance = 'inst-core-1';
  current = fixture.store.transact({
    action: 'register-target',
    descriptor: fixture.descriptor,
    slot: 'core-analysis',
    instanceId: instance,
    artifactSha256: fixture.artifactMap['core-analysis'],
  }, { expectedRevision: current.revision }).record;
  current = fixture.store.transact({
    action: 'register-target',
    descriptor: fixture.descriptor,
    slot: 'telegram',
    instanceId: 'inst-tg-1',
    artifactSha256: fixture.artifactMap.telegram,
  }, { expectedRevision: current.revision }).record;

  // No PREPARED evidence yet.
  assert.throws(
    () => fixture.store.transact({ action: 'arm' }, { expectedRevision: current.revision }),
    /no PREPARED acknowledgement/,
  );

  for (const [slot, id] of [['core-analysis', instance], ['telegram', 'inst-tg-1']]) {
    const ack = buildAck({
      record: current,
      slot,
      instanceId: id,
      status: 'PREPARED',
      artifactSha256: fixture.artifactMap[slot],
      binding: fixture.binding,
    });
    const written = fixture.store.writeAck(current.transitionId, slot, id, 'PREPARED', ack);
    current = fixture.store.transact({ action: 'prepare-ack', ack, evidenceSha256: written.sha256 }, {
      expectedRevision: current.revision,
    }).record;
  }

  // Observer receipt missing blocks ARMED (required observer).
  assert.throws(
    () => fixture.store.transact({ action: 'arm' }, { expectedRevision: current.revision }),
    /required observer core-bootstrap has no validation receipt/,
  );

  const receipt = {
    schemaVersion: 1,
    deploymentId: current.deploymentId,
    transitionId: current.transitionId,
    observerId: 'core-bootstrap',
    artifactSha256: fixture.artifactMap['core-analysis'],
    manifestVersion: fixture.binding.manifestVersion,
    manifestSha256: fixture.binding.manifestSha256,
    capabilityProfileSha256: fixture.binding.capabilityProfileSha256,
    status: 'VALIDATED',
    errorCode: null,
  };
  const receiptFile = fixture.store.writeObserverReceipt(current.transitionId, 'core-bootstrap', receipt);
  current = fixture.store.transact({
    action: 'observer-evidence',
    descriptor: fixture.descriptor,
    receipt,
    evidenceSha256: receiptFile.sha256,
  }, { expectedRevision: current.revision }).record;

  current = fixture.store.transact({ action: 'arm' }, { expectedRevision: current.revision }).record;
  assert.equal(current.phase, 'ARMED');
  // Registration is frozen once ARMED.
  assert.throws(
    () => fixture.store.transact({
      action: 'register-target',
      descriptor: fixture.descriptor,
      slot: 'telegram',
      instanceId: 'late-1',
      artifactSha256: fixture.artifactMap.telegram,
    }, { expectedRevision: current.revision }),
    /only legal in PREPARING/,
  );

  const activated = fixture.store.transact({ action: 'activate' }, { expectedRevision: current.revision }).record;
  assert.equal(activated.phase, 'ACTIVE');
  assert.equal(activated.generation, 1);
  assert.equal(activated.nextGeneration, null);
  assert.equal(activated.transition, null);
  assert.equal(activated.members.length, 2);
  assert.equal(activated.releaseDescriptorSha256, fixture.descriptorSha256);
});

test('UAI-05B: illegal phase edges fail, including PREPARING -> ACTIVE and PAUSED -> ACTIVE', () => {
  const fixture = buildReleaseFixture();
  const record = quiesced(fixture, initialized(fixture));
  const preparing = fixture.store.transact({ action: 'prepare' }, { expectedRevision: record.revision }).record;
  assert.throws(
    () => fixture.store.transact({ action: 'activate' }, { expectedRevision: preparing.revision }),
    (error) => hasCode(error, COORDINATION_ERROR_CODE.INVALID_TRANSITION),
  );
  assert.throws(
    () => fixture.store.transact({ action: 'quiesce', descriptor: fixture.descriptor, transitionId: '44444444-4444-4444-8444-444444444444' }, { expectedRevision: preparing.revision }),
    /not legal in phase PREPARING/,
  );
  const paused = fixture.store.transact({ action: 'pause' }, { expectedRevision: preparing.revision }).record;
  assert.equal(paused.phase, 'PAUSED');
  assert.throws(
    () => fixture.store.transact({ action: 'activate' }, { expectedRevision: paused.revision }),
    /not legal in phase PAUSED/,
  );
  // Stale revision (competing writer) also fails.
  assert.throws(
    () => fixture.store.transact({ action: 'prepare' }, { expectedRevision: preparing.revision }),
    (error) => error.details?.actualRevision !== undefined,
  );
});

test('UAI-05B: pause retains the transition, target roster and reservation', () => {
  const fixture = buildReleaseFixture();
  const record = quiesced(fixture, initialized(fixture));
  const paused = fixture.store.transact({ action: 'pause', reason: 'operator hold' }, { expectedRevision: record.revision }).record;
  assert.equal(paused.phase, 'PAUSED');
  assert.equal(paused.transitionId, record.transitionId);
  assert.deepEqual(paused.target, record.target);
  assert.equal(paused.nextGeneration, record.nextGeneration);
  assert.equal(paused.highWaterGeneration, record.highWaterGeneration);
});

test('UAI-05B: recovery uses a fresh generation, retains old+target instances and discards grants', () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const record = fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: '55555555-5555-4555-8555-555555555555' },
    { expectedRevision: active.record.revision },
  ).record;
  let current = record;
  // Retire both old members and stage-grant one of them.
  for (const [slot, id] of [['core-analysis', 'inst-core-1'], ['telegram', 'inst-tg-1']]) {
    const ack = buildAck({
      record: current,
      slot,
      instanceId: id,
      status: 'QUIESCED',
      artifactSha256: fixture.artifactMap[slot],
      binding: fixture.binding,
    });
    const written = fixture.store.writeAck(current.transitionId, slot, id, 'QUIESCED', ack);
    current = fixture.store.transact({
      action: 'retire', slot, instanceId: id, kind: 'QUIESCED', evidenceSha256: written.sha256,
    }, { expectedRevision: current.revision }).record;
  }
  current = fixture.store.transact({ action: 'prepare' }, { expectedRevision: current.revision }).record;
  current = fixture.store.transact({
    action: 'stage-grant',
    descriptor: fixture.descriptor,
    slot: 'telegram',
    instanceId: 'inst-tg-1',
  }, { expectedRevision: current.revision }).record;
  assert.equal(current.transition.stageGrants.length, 1);

  const paused = fixture.store.transact({ action: 'pause' }, { expectedRevision: current.revision }).record;
  const recovered = fixture.store.transact({
    action: 'recover',
    descriptor: fixture.descriptor,
    transitionId: '66666666-6666-4666-8666-666666666666',
  }, { expectedRevision: paused.revision }).record;

  assert.equal(recovered.phase, 'QUIESCING');
  assert.equal(recovered.nextGeneration, 3, 'fresh generation above the abandoned reservation');
  assert.equal(recovered.generation, 1, 'the committed generation is unchanged');
  assert.equal(recovered.transition.abandonedTransitionId, paused.transitionId);
  assert.equal(recovered.transition.stageGrants.length, 0, 'old grants are discarded');
  assert.equal(recovered.transition.prepareEvidence.length, 0);
  assert.equal(recovered.transition.retirementEvidence.length, 0, 'acks cannot be reused across transition IDs');
  const slots = recovered.transition.oldMembers.map((member) => member.slot).sort();
  assert.deepEqual(slots, ['core-analysis', 'telegram']);
});

test('UAI-05B: rollback to the same digest still increments the generation', () => {
  const fixture = buildReleaseFixture();
  const first = activateFixture(fixture);
  const record = fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: '77777777-7777-4777-8777-777777777777' },
    { expectedRevision: first.record.revision },
  ).record;
  let current = record;
  for (const [slot, id] of [['core-analysis', 'inst-core-1'], ['telegram', 'inst-tg-1']]) {
    const ack = buildAck({
      record: current, slot, instanceId: id, status: 'QUIESCED',
      artifactSha256: fixture.artifactMap[slot], binding: fixture.binding,
    });
    const written = fixture.store.writeAck(current.transitionId, slot, id, 'QUIESCED', ack);
    current = fixture.store.transact({
      action: 'retire', slot, instanceId: id, kind: 'QUIESCED', evidenceSha256: written.sha256,
    }, { expectedRevision: current.revision }).record;
  }
  current = fixture.store.transact({ action: 'prepare' }, { expectedRevision: current.revision }).record;
  for (const [slot, id] of [['core-analysis', 'inst-core-2'], ['telegram', 'inst-tg-2']]) {
    current = fixture.store.transact({
      action: 'register-target',
      descriptor: fixture.descriptor,
      slot,
      instanceId: id,
      artifactSha256: fixture.artifactMap[slot],
    }, { expectedRevision: current.revision }).record;
    const ack = buildAck({
      record: current, slot, instanceId: id, status: 'PREPARED',
      artifactSha256: fixture.artifactMap[slot], binding: fixture.binding,
    });
    const written = fixture.store.writeAck(current.transitionId, slot, id, 'PREPARED', ack);
    current = fixture.store.transact({ action: 'prepare-ack', ack, evidenceSha256: written.sha256 }, {
      expectedRevision: current.revision,
    }).record;
  }
  const receipt = {
    schemaVersion: 1,
    deploymentId: current.deploymentId,
    transitionId: current.transitionId,
    observerId: 'core-bootstrap',
    artifactSha256: fixture.artifactMap['core-analysis'],
    manifestVersion: fixture.binding.manifestVersion,
    manifestSha256: fixture.binding.manifestSha256,
    capabilityProfileSha256: fixture.binding.capabilityProfileSha256,
    status: 'VALIDATED',
    errorCode: null,
  };
  const receiptFile = fixture.store.writeObserverReceipt(current.transitionId, 'core-bootstrap', receipt);
  current = fixture.store.transact({
    action: 'observer-evidence',
    descriptor: fixture.descriptor,
    receipt,
    evidenceSha256: receiptFile.sha256,
  }, { expectedRevision: current.revision }).record;
  current = fixture.store.transact({ action: 'arm' }, { expectedRevision: current.revision }).record;
  const rolledBack = fixture.store.transact({ action: 'activate' }, { expectedRevision: current.revision }).record;
  assert.equal(rolledBack.phase, 'ACTIVE');
  assert.equal(rolledBack.generation, 2);
  assert.equal(rolledBack.active.manifestSha256, first.record.active.manifestSha256, 'same digest');
  assert.equal(rolledBack.highWaterGeneration, 2);
  assert.ok(rolledBack.members.every((member) => member.instanceId.endsWith('-2')));
});

test('UAI-05B: slot add/remove/enable transitions require the full barrier', () => {
  const fixture = buildReleaseFixture();
  const first = activateFixture(fixture);
  // Disable the core slot and add a replica slot for the Scout operation.
  const target = buildAlternateDescriptor({
    fixture,
    manifestVersion: 'release-2',
    inventory: [
      { slot: 'core-analysis', operations: ['ANALYZE'], enabled: false },
      { slot: 'telegram', operations: ['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT'], enabled: true },
      { slot: 'telegram-b', operations: ['SCOUT'], enabled: true },
    ],
    artifactMap: { 'telegram-b': artifactDigest('telegram-b-v1') },
  });
  let record = fixture.store.transact(
    { action: 'quiesce', descriptor: target.descriptor, transitionId: '88888888-8888-4888-8888-888888888888' },
    { expectedRevision: first.record.revision },
  ).record;
  assert.equal(record.transition.oldMembers.length, 2, 'the disabled slot still owes retirement evidence');

  for (const member of record.transition.oldMembers) {
    const fence = {
      schemaVersion: 1,
      deploymentId: record.deploymentId,
      transitionId: record.transitionId,
      slot: member.slot,
      instanceId: member.instanceId,
      operatorApprovalId: 'approval-fence-1',
      processFenceEvidenceRef: 'evidence/fencing/process-exit.txt',
      outcomeReconciliationRef: 'evidence/reconciliation/orders.txt',
    };
    const written = fixture.store.writeFenceEvidence(record.transitionId, member.slot, member.instanceId, fence);
    record = fixture.store.transact({
      action: 'retire',
      slot: member.slot,
      instanceId: member.instanceId,
      kind: 'FENCED',
      evidenceSha256: written.sha256,
    }, { expectedRevision: record.revision }).record;
  }
  record = fixture.store.transact({ action: 'prepare' }, { expectedRevision: record.revision }).record;

  // A removed/disabled slot cannot be registered as a target.
  assert.throws(
    () => fixture.store.transact({
      action: 'register-target',
      descriptor: target.descriptor,
      slot: 'core-analysis',
      instanceId: 'inst-core-9',
      artifactSha256: fixture.artifactMap['core-analysis'],
    }, { expectedRevision: record.revision }),
    /disabled in the target inventory/,
  );
  // A slot absent from the target inventory cannot be admitted either.
  assert.throws(
    () => fixture.store.transact({
      action: 'register-target',
      descriptor: target.descriptor,
      slot: 'ghost-slot',
      instanceId: 'inst-ghost',
      artifactSha256: artifactDigest('ghost'),
    }, { expectedRevision: record.revision }),
    /not in the target inventory/,
  );
  // The newly added replica slot is admitted under the same barrier.
  record = fixture.store.transact({
    action: 'register-target',
    descriptor: target.descriptor,
    slot: 'telegram-b',
    instanceId: 'inst-tg-b',
    artifactSha256: artifactDigest('telegram-b-v1'),
  }, { expectedRevision: record.revision }).record;
  assert.ok(record.transition.targetMembers.some((member) => member.slot === 'telegram-b'));
});

test('UAI-05B: duplicate slot ownership fails closed and a stale ack is not evidence', () => {
  const fixture = buildReleaseFixture();
  const record = quiesced(fixture, initialized(fixture));
  let current = fixture.store.transact({ action: 'prepare' }, { expectedRevision: record.revision }).record;
  current = fixture.store.transact({
    action: 'register-target',
    descriptor: fixture.descriptor,
    slot: 'telegram',
    instanceId: 'inst-a',
    artifactSha256: fixture.artifactMap.telegram,
  }, { expectedRevision: current.revision }).record;
  assert.throws(
    () => fixture.store.transact({
      action: 'register-target',
      descriptor: fixture.descriptor,
      slot: 'telegram',
      instanceId: 'inst-b',
      artifactSha256: fixture.artifactMap.telegram,
    }, { expectedRevision: current.revision }),
    (error) => hasCode(error, COORDINATION_ERROR_CODE.SLOT_CONFLICT),
  );

  // An ack for another transition is refused as evidence.
  const staleAck = {
    ...buildAck({
      record: current,
      slot: 'telegram',
      instanceId: 'inst-a',
      status: 'PREPARED',
      artifactSha256: fixture.artifactMap.telegram,
      binding: fixture.binding,
    }),
    transitionId: '99999999-9999-4999-8999-999999999999',
  };
  assert.throws(
    () => fixture.store.transact({ action: 'prepare-ack', ack: staleAck, evidenceSha256: 'a'.repeat(64) }, {
      expectedRevision: current.revision,
    }),
    /another transition/,
  );
});

test('UAI-05B: a foreign deployment ID and a counter overflow are rejected', () => {
  const fixture = buildReleaseFixture();
  const record = quiesced(fixture, initialized(fixture));
  const preparing = fixture.store.transact({ action: 'prepare' }, { expectedRevision: record.revision }).record;
  const wrongDeployment = {
    ...buildAck({
      record: preparing,
      slot: 'telegram',
      instanceId: 'inst-a',
      status: 'PREPARED',
      artifactSha256: fixture.artifactMap.telegram,
      binding: fixture.binding,
    }),
    deploymentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
  assert.throws(
    () => fixture.store.transact({ action: 'prepare-ack', ack: wrongDeployment, evidenceSha256: 'a'.repeat(64) }, {
      expectedRevision: preparing.revision,
    }),
    /another deployment/,
  );

  const paused = fixture.store.transact({ action: 'pause' }, { expectedRevision: preparing.revision }).record;
  const saturated = {
    ...paused,
    highWaterGeneration: Number.MAX_SAFE_INTEGER,
    nextGeneration: Number.MAX_SAFE_INTEGER,
  };
  assert.throws(
    () => applyReleaseCommand(saturated, {
      action: 'recover',
      descriptor: fixture.descriptor,
      transitionId: TRANSITION_ID,
    }),
    /overflow/,
  );
});

test('UAI-05B: barrier blockers are reported, not guessed', () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const record = fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: 'abababab-abab-4bab-8bab-abababababab' },
    { expectedRevision: active.record.revision },
  ).record;
  const report = describeBarrierBlockers(record, fixture.descriptor, {});
  assert.equal(report.missingRetirement.length, 2);
  assert.ok(report.blockers.some((line) => line.includes('old members not retired')));
  assert.equal(retirementState(record.transition, 'telegram', 'inst-tg-1').quiesced, false);
});

test('UAI-05B: the full advanceBarrier helper reaches ACTIVE with retained participants', () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const coreCalls = [];
  const tgCalls = [];
  const coreGuard = buildTestGuard(fixture, { slot: 'core-analysis', instanceId: 'inst-core-1', calls: coreCalls });
  const tgGuard = buildTestGuard(fixture, { slot: 'telegram', instanceId: 'inst-tg-1', calls: tgCalls });
  assert.equal(coreGuard.start().identityReady, true);
  assert.equal(tgGuard.start().identityReady, true);

  const target = buildAlternateDescriptor({ fixture, manifestVersion: 'release-2' });
  const result = advanceBarrier(fixture, {
    descriptor: target.descriptor,
    participants: [
      { guard: coreGuard, slot: 'core-analysis', instanceId: 'inst-core-1' },
      { guard: tgGuard, slot: 'telegram', instanceId: 'inst-tg-1' },
    ],
  });
  assert.equal(result.record.phase, 'ACTIVE');
  assert.equal(result.record.generation, 2);
  assert.equal(result.record.active.manifestVersion, 'release-2');
  assert.equal(result.record.transition, null);
  assert.equal(coreGuard.status().generation, 2, 'the retained instance promoted in place');
  assert.equal(tgGuard.status().generation, 2);
  assert.equal(coreGuard.status().manifestVersion, 'release-2');
  assert.ok(computeReleaseDescriptorDigest(target.descriptor) === result.record.releaseDescriptorSha256);
  const token = tgGuard.beginWork('SCOUT');
  assert.equal(token.generation, 2);
  tgGuard.endWork(token);
});
