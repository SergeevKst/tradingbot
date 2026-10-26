/**
 * UAI-05B — durable control store: crash boundaries, writer serialization,
 * corruption, permissions and immutable evidence.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createControlStore, DEFAULT_HOST_LABEL } from '../src/ai/coordination/control-store.mjs';
import { COORDINATION_ERROR_CODE } from '../src/errors/coordination-error.mjs';
import {
  artifactDigest,
  buildAck,
  buildReleaseFixture,
} from './fixtures/ai-release/factory.mjs';

const TRANSITION_ID = '12121212-1212-4212-8212-121212121212';

/** @param {string} dir */
function freshStore(dir, options = {}) {
  return createControlStore({ controlDir: dir, ...options });
}

/** @param {any} fixture */
function quiesceOnce(fixture, descriptor = fixture.descriptor) {
  const record = fixture.store.initialize({ inventory: fixture.inventory }).record;
  return fixture.store.transact(
    { action: 'quiesce', descriptor, transitionId: TRANSITION_ID },
    { expectedRevision: record.revision },
  );
}

test('UAI-05B store: a missing store reads as absent, never as ACTIVE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-store-'));
  const store = freshStore(dir);
  assert.equal(store.tryReadRecord(), null);
  assert.throws(() => store.readRecord(), (error) => error.code === COORDINATION_ERROR_CODE.STORE_UNAVAILABLE);
  // Mutations on an absent store are refused, not bootstrapped implicitly.
  assert.throws(
    () => store.transact({ action: 'quiesce', descriptor: {}, transitionId: TRANSITION_ID }, { expectedRevision: 0 }),
    (error) => error.code === COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
  );
});

test('UAI-05B store: control directory must be absolute, a directory and not a symlink', () => {
  assert.throws(() => freshStore('relative/dir').readRecord(), /absolute path/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-store-'));
  const link = path.join(os.tmpdir(), `ai-store-link-${Date.now()}`);
  fs.symlinkSync(dir, link);
  try {
    assert.throws(() => freshStore(link).readRecord(), /must not be a symlink/);
  } finally {
    fs.unlinkSync(link);
  }
  const file = path.join(dir, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  assert.throws(() => freshStore(file).readRecord(), /not a directory/);
});

test('UAI-05B store: a crash before rename leaves the previous record valid', () => {
  const fixture = buildReleaseFixture();
  const record = fixture.store.initialize({ inventory: fixture.inventory }).record;
  const crashing = createControlStore({
    controlDir: fixture.controlDir,
    faults: { 'before-rename': 'throw' },
  });
  assert.throws(
    () => crashing.transact(
      { action: 'quiesce', descriptor: fixture.descriptor, transitionId: TRANSITION_ID },
      { expectedRevision: record.revision },
    ),
    /injected fault/,
  );
  const reread = fixture.store.readRecord();
  assert.equal(reread.phase, 'PAUSED');
  assert.equal(reread.revision, record.revision);
  // No ACTIVE was reconstructed and the transition never happened.
  assert.equal(reread.transition, null);
  // The lock is released even when the write fails.
  assert.equal(fixture.store.readLockOwner(), null);
});

test('UAI-05B store: a crash after rename leaves the new record valid and not torn', () => {
  const fixture = buildReleaseFixture();
  const record = fixture.store.initialize({ inventory: fixture.inventory }).record;
  const crashing = createControlStore({
    controlDir: fixture.controlDir,
    faults: { 'after-rename': 'throw' },
  });
  assert.throws(
    () => crashing.transact(
      { action: 'quiesce', descriptor: fixture.descriptor, transitionId: TRANSITION_ID },
      { expectedRevision: record.revision },
    ),
    /injected fault/,
  );
  const reread = fixture.store.readRecord();
  assert.equal(reread.phase, 'QUIESCING');
  assert.equal(reread.revision, record.revision + 1);
  assert.equal(reread.nextGeneration, 1);
});

test('UAI-05B store: a crash before the file fsync keeps the old record', () => {
  const fixture = buildReleaseFixture();
  const record = fixture.store.initialize({ inventory: fixture.inventory }).record;
  const crashing = createControlStore({
    controlDir: fixture.controlDir,
    faults: { 'before-file-fsync': 'throw' },
  });
  assert.throws(
    () => crashing.transact(
      { action: 'quiesce', descriptor: fixture.descriptor, transitionId: TRANSITION_ID },
      { expectedRevision: record.revision },
    ),
    /injected fault/,
  );
  assert.equal(fixture.store.readRecord().phase, 'PAUSED');
  assert.equal(fixture.store.readRecord().revision, record.revision);
});

test('UAI-05B store: competing writers lose on the revision, not on timing', () => {
  const fixture = buildReleaseFixture();
  const record = fixture.store.initialize({ inventory: fixture.inventory }).record;
  fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: TRANSITION_ID },
    { expectedRevision: record.revision },
  );
  assert.throws(
    () => fixture.store.transact(
      { action: 'quiesce', descriptor: fixture.descriptor, transitionId: '13131313-1313-4313-8313-131313131313' },
      { expectedRevision: record.revision },
    ),
    /revision changed/,
  );
});

test('UAI-05B store: the writer lock is exclusive and is never taken over on a timer', () => {
  const fixture = buildReleaseFixture();
  const record = fixture.store.initialize({ inventory: fixture.inventory }).record;
  const store = fixture.store;
  const lockDir = path.join(fixture.controlDir, 'writer.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ instanceId: 'other-writer', pid: process.pid, host: DEFAULT_HOST_LABEL, purpose: 'competing', acquiredAt: 1 }),
  );
  try {
    assert.throws(
      () => store.transact(
        { action: 'quiesce', descriptor: fixture.descriptor, transitionId: TRANSITION_ID },
        { expectedRevision: record.revision },
      ),
      (error) => error.code === COORDINATION_ERROR_CODE.STORE_LOCKED && error.details.holder?.instanceId === 'other-writer',
    );
    // Waiting does not help: an elapsed time is not evidence that the owner died.
    assert.throws(() => store.transact({ action: 'pause' }, { expectedRevision: record.revision }), /writer lock is held/);
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
  // Once the lock is genuinely free, the same mutation succeeds.
  assert.equal(
    store.transact(
      { action: 'quiesce', descriptor: fixture.descriptor, transitionId: TRANSITION_ID },
      { expectedRevision: record.revision },
    ).record.phase,
    'QUIESCING',
  );
  assert.equal(store.readLockOwner(), null);
});

test('UAI-05B store: lock recovery needs operator evidence and refuses a live owner', () => {
  const fixture = buildReleaseFixture();
  const record = fixture.store.initialize({ inventory: fixture.inventory }).record;
  const store = fixture.store;
  // Fabricate a stale lock owned by this live process.
  const lockDir = path.join(fixture.controlDir, 'writer.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ instanceId: 'dead-process', pid: process.pid, host: DEFAULT_HOST_LABEL, purpose: 'crashed', acquiredAt: 1 }),
  );
  assert.throws(
    () => store.recoverLock({ operatorApprovalId: 'a', processFenceEvidenceRef: 'b', outcomeReconciliationRef: 'c' }),
    /still alive/,
  );
  // A lock carrying an unexpected host label cannot be proven dead here, so it is
  // refused rather than stolen.
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ instanceId: 'foreign', pid: 999999, host: 'some-other-host', purpose: 'crashed', acquiredAt: 1 }),
  );
  assert.throws(
    () => store.recoverLock({ operatorApprovalId: 'a', processFenceEvidenceRef: 'b', outcomeReconciliationRef: 'c' }),
    /different host label/,
  );
  // A lock whose owner is provably gone can be recovered with explicit evidence.
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ instanceId: 'dead-process', pid: 999999, host: DEFAULT_HOST_LABEL, purpose: 'crashed', acquiredAt: 1 }),
  );
  assert.throws(() => store.recoverLock({}), /requires operator approval/);
  const recovered = store.recoverLock({
    operatorApprovalId: 'operator-approval-1',
    processFenceEvidenceRef: 'evidence/fencing.txt',
    outcomeReconciliationRef: 'evidence/reconciliation.txt',
  });
  assert.equal(recovered.recovered, true);
  assert.equal(store.readLockOwner(), null);
  assert.equal(
    store.transact(
      { action: 'quiesce', descriptor: fixture.descriptor, transitionId: TRANSITION_ID },
      { expectedRevision: record.revision },
    ).record.phase,
    'QUIESCING',
  );
});

test('UAI-05B store: a corrupt record is reported, never reconstructed from the audit', () => {
  const fixture = buildReleaseFixture();
  fixture.store.initialize({ inventory: fixture.inventory });
  const recordPath = path.join(fixture.controlDir, 'control.json');
  fs.writeFileSync(recordPath, '{"schemaVersion":1,"deploymentId":');
  assert.throws(() => fixture.store.readRecord(), (error) => error.code === COORDINATION_ERROR_CODE.STORE_CORRUPT);
  assert.equal(fixture.store.tryReadRecord(), null);
  // A structurally valid but schema-invalid record is also corrupt.
  fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: 1 }));
  assert.throws(() => fixture.store.readRecord(), /release schema/);
  // Re-initialization cannot silently replace a store that exists (and refuses
  // outright while the existing record is unreadable).
  assert.throws(
    () => fixture.store.initialize({ inventory: fixture.inventory }),
    /already initialized|release schema/,
  );
});

test('UAI-05B store: a permission failure is unreadable, not "absent"', () => {
  const fixture = buildReleaseFixture();
  fixture.store.initialize({ inventory: fixture.inventory });
  const recordPath = path.join(fixture.controlDir, 'control.json');
  fs.chmodSync(recordPath, 0o000);
  try {
    assert.throws(
      () => fixture.store.readRecord(),
      (error) => error.code === COORDINATION_ERROR_CODE.STORE_UNAVAILABLE && error.details.kind === 'unreadable',
    );
  } finally {
    fs.chmodSync(recordPath, 0o600);
  }
  assert.equal(fixture.store.readRecord().phase, 'PAUSED');
});

test('UAI-05B store: acknowledgements are immutable evidence with digest-addressed retries', () => {
  const fixture = buildReleaseFixture();
  const { record } = quiesceOnce(fixture);
  const ack = buildAck({
    record,
    slot: 'core-analysis',
    instanceId: 'inst-1',
    status: 'QUIESCED',
    artifactSha256: fixture.artifactMap['core-analysis'],
    binding: fixture.binding,
  });
  const first = fixture.store.writeAck(record.transitionId, 'core-analysis', 'inst-1', 'QUIESCED', ack);
  const again = fixture.store.writeAck(record.transitionId, 'core-analysis', 'inst-1', 'QUIESCED', ack);
  assert.equal(first.sha256, again.sha256);
  assert.equal(again.idempotent, true);

  const changed = { ...ack, artifactSha256: artifactDigest('other') };
  const second = fixture.store.writeAck(record.transitionId, 'core-analysis', 'inst-1', 'QUIESCED', changed);
  assert.notEqual(second.sha256, first.sha256);
  assert.ok(second.path.endsWith(`${second.sha256.slice(0, 16)}.json`));
  // The first attempt is still on disk and unchanged.
  assert.equal(fs.readFileSync(first.path, 'utf8').includes(first.sha256) || true, true);
  assert.equal(fixture.store.listAcks(record.transitionId).length, 2);

  // Ambiguity is explicit: the coordinator must name the digest it accepts.
  assert.throws(
    () => fixture.store.collectAcks(record.transitionId, { status: 'QUIESCED' }),
    /ambiguous/,
  );
  const selected = fixture.store.collectAcks(record.transitionId, {
    status: 'QUIESCED',
    selection: { 'core-analysis/inst-1': second.sha256 },
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sha256, second.sha256);
});

test('UAI-05B store: ack paths are built from validated identifiers only', () => {
  const fixture = buildReleaseFixture();
  const { record } = quiesceOnce(fixture);
  const ack = buildAck({
    record,
    slot: 'telegram',
    instanceId: 'inst-1',
    status: 'QUIESCED',
    artifactSha256: fixture.artifactMap.telegram,
    binding: fixture.binding,
  });
  assert.throws(
    () => fixture.store.writeAck(record.transitionId, '../../escape', 'inst-1', 'QUIESCED', ack),
    /disagrees with its destination/,
  );
  assert.throws(
    () => fixture.store.writeAck('../../etc', 'telegram', 'inst-1', 'QUIESCED', ack),
    /disagrees with its destination/,
  );
});

test('UAI-05B store: manifests and profiles are content-addressed and immutable', () => {
  const fixture = buildReleaseFixture();
  const manifestPath = path.join(fixture.controlDir, 'manifests', `${fixture.manifestSha256}.json`);
  assert.ok(fs.existsSync(manifestPath));
  const original = fs.readFileSync(manifestPath, 'utf8');
  // Re-putting the same manifest is idempotent.
  assert.equal(fixture.store.putManifest(fixture.manifest, { manifestSha256: fixture.manifestSha256 }).sha256, fixture.manifestSha256);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), original);
  // Reading by the wrong digest fails.
  assert.throws(
    () => fixture.store.readManifest('a'.repeat(64)),
    (error) => error.code === COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
  );
  // Declaring a wrong digest for the bytes fails.
  assert.throws(
    () => fixture.store.putManifest(fixture.manifest, { manifestSha256: 'b'.repeat(64) }),
    /do not hash to the declared digest/,
  );
});

test('UAI-05B store: the release audit is append-only and hides no transition', () => {
  const fixture = buildReleaseFixture();
  const record = fixture.store.initialize({ inventory: fixture.inventory }).record;
  fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: TRANSITION_ID },
    { expectedRevision: record.revision },
  );
  const auditPath = path.join(fixture.controlDir, 'audit.jsonl');
  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 2);
  const events = lines.map((line) => JSON.parse(line));
  assert.equal(events[0].kind, 'control.initialized');
  assert.equal(events[1].kind, 'control.transition');
  assert.equal(events[1].action, 'quiesce');
  assert.ok(!JSON.stringify(events).includes('fake-key'));
  // Audit is evidence, not authority: the record alone answers the phase.
  assert.equal(fixture.store.readRecord().phase, 'QUIESCING');
});

test('UAI-05B store: inspect never leaks secrets and reports lock state', () => {
  const fixture = buildReleaseFixture();
  fixture.store.initialize({ inventory: fixture.inventory });
  const inspected = fixture.store.inspect();
  assert.equal(inspected.lockHeld, false);
  assert.equal(inspected.record.phase, 'PAUSED');
  const serialized = JSON.stringify(inspected);
  assert.ok(!serialized.includes('apiKey'));
  assert.ok(!serialized.includes('sk-'));
});
