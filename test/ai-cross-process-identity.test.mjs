/**
 * UAI-06C — cross-process conformance and fault injection (XP-01..XP-18).
 *
 * Every participant is a real, separately spawned Node process that imports the
 * production compositions; every control mutation goes through the real release
 * CLI in its own process. The only shared thing is the temporary control
 * directory. Evidence is a machine-readable trace + the durable control record.
 *
 * Assertions are about properties, not exceptions: after a fault, the effect
 * count must be zero and the committed generation must be unchanged.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  completeBarrier,
  createHarness,
  inspect,
  killAllParticipants,
  randomUuid,
  runCli,
  spawnParticipant,
} from './helpers/ai-cluster.mjs';
import { after } from 'node:test';

after(async () => {
  await killAllParticipants();
});

/** @param {any[]} events */
function requests(events) {
  return events.filter((event) => event.event === 'provider-request');
}

/** @param {any[]} events */
function effects(events) {
  return events.filter((event) => event.event === 'effect');
}

/** @param {any} harness */
function descriptorSha(harness) {
  return harness.fixture.descriptorSha256;
}

/**
 * First activation of the default two-slot inventory with live children.
 *
 * @param {any} harness
 * @param {{ spawnTg?: boolean }} [options]
 */
async function firstActivation(harness, options = {}) {
  const core = spawnParticipant(harness, { role: 'core', slot: 'core-analysis', instanceId: 'core-1' });
  const telegram = spawnParticipant(harness, { role: 'telegram', slot: 'telegram', instanceId: 'tg-1' });
  const participants = [
    { child: core, slot: 'core-analysis', instanceId: 'core-1', retained: false },
    { child: telegram, slot: 'telegram', instanceId: 'tg-1', retained: false },
  ];
  const activated = await completeBarrier(harness, {
    descriptorPath: harness.descriptorPath,
    descriptorSha: descriptorSha(harness),
    manifestVersion: harness.fixture.manifest.manifestVersion,
    manifestSha256: harness.fixture.manifestSha256,
    participants,
    observerArtifactSha256: harness.fixture.artifactMap['core-analysis'],
  });
  return { core, telegram, activated };
}

test('XP-01: independent core and Telegram children share one identity and generation', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    const analysis = await core.cmd({ cmd: 'analyze' });
    const scout = await telegram.cmd({ cmd: 'scout' });
    const guard = await telegram.cmd({ cmd: 'guard' });
    await telegram.cmd({ cmd: 'monitor' });
    await telegram.cmd({ cmd: 'stopcheck' });
    const reflection = await telegram.cmd({ cmd: 'reflect' });
    assert.equal(analysis.ok, true);
    assert.equal(scout.ok, true);
    assert.equal(guard.verdict, 'APPROVED');
    assert.equal(reflection.reflected, true);

    const coreEvents = core.events();
    const tgEvents = telegram.events();
    const observed = [...requests(coreEvents), ...requests(tgEvents)];
    const operations = new Set(observed.map((entry) => entry.operation));
    for (const expected of ['ANALYZE', 'SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT']) {
      assert.ok(operations.has(expected), `operation ${expected} was not observed across processes`);
    }
    // Identical endpoint/model/temperature for the same manifest.
    const urls = new Set(observed.map((entry) => entry.url));
    assert.deepEqual([...urls], ['https://api.deepseek.com/v1/chat/completions']);
    assert.deepEqual(new Set(observed.map((entry) => entry.model)), new Set(['deepseek-chat']));
    // Independent prompts: each request carries a different system message.
    const prompts = new Set(observed.map((entry) => `${entry.operation}:${entry.messageCount}`));
    assert.ok(prompts.size >= 5);
    // Same committed generation reported by both processes.
    const coreStatus = await core.cmd({ cmd: 'status' });
    const tgStatus = await telegram.cmd({ cmd: 'status' });
    assert.equal(coreStatus.generation, 1);
    assert.equal(tgStatus.generation, 1);
    assert.equal(coreStatus.manifestSha256, tgStatus.manifestSha256);
    // No secret crosses the process boundary into a trace.
    for (const line of [...coreEvents, ...tgEvents]) {
      assert.ok(!JSON.stringify(line).includes('fake-secret-sentinel'));
    }
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('XP-02: a stale or wrong identity process is non-ready before its first request', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    const stale = spawnParticipant(harness, {
      role: 'telegram',
      slot: 'telegram',
      instanceId: 'tg-stale',
      expectedSha256: 'a'.repeat(64),
    });
    const staleStatus = await stale.start();
    assert.equal(staleStatus.identityReady, false);
    await assert.rejects(stale.cmd({ cmd: 'scout' }));
    assert.equal(requests(stale.events()).length, 0, 'no provider request from a stale process');

    const wrongDeployment = spawnParticipant(harness, {
      role: 'core',
      slot: 'core-analysis',
      instanceId: 'core-wrong',
      deploymentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    assert.equal((await wrongDeployment.start()).errorCode, 'IDENTITY_MISMATCH');
    assert.equal(requests(wrongDeployment.events()).length, 0);

    // The peer cannot promote such a process around a missing member: a barrier
    // snapshot of the empty store cannot commit without their evidence.
    const quiesce = runCli(harness, 'quiesce', { descriptor: harness.alternateDescriptorPath, 'transition-id': randomUuid() });
    assert.equal(quiesce.body.ok, true);
    const prepare = runCli(harness, 'prepare');
    assert.equal(prepare.body.ok, false, 'no quiescence evidence from the live members');

    await stale.stop();
    await wrongDeployment.stop();
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('XP-03: a disabled core bootstrap validates identity, needs no key and rejects ANALYZE', async () => {
  const harness = createHarness({
    alternateInventory: [
      { slot: 'core-analysis', operations: ['ANALYZE'], enabled: false },
      { slot: 'telegram', operations: ['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT'], enabled: true },
    ],
  });
  const observer = spawnParticipant(harness, {
    role: 'observer',
    slot: null,
    instanceId: 'observer-1',
    artifactSha256: harness.fixture.artifactMap['core-analysis'],
    expectedVersion: harness.alternate.manifest.manifestVersion,
    expectedSha256: harness.alternate.manifestSha256,
  });
  // An observer can only validate against ACTIVE, so activate first with the
  // Telegram participant only and the core slot disabled.
  const telegram = spawnParticipant(harness, {
    role: 'telegram',
    slot: 'telegram',
    instanceId: 'tg-1',
    expectedVersion: harness.alternate.manifest.manifestVersion,
    expectedSha256: harness.alternate.manifestSha256,
  });
  try {
    await completeBarrier(harness, {
      descriptorPath: harness.alternateDescriptorPath,
      descriptorSha: harness.alternate.descriptorSha256,
      manifestVersion: harness.alternate.manifest.manifestVersion,
      manifestSha256: harness.alternate.manifestSha256,
      participants: [{ child: telegram, slot: 'telegram', instanceId: 'tg-1', retained: false }],
    });
    const validation = await observer.start();
    assert.equal(validation.identityValidated, true);
    assert.equal(validation.inferenceEnabled, false);
    assert.equal(requests(observer.events()).length, 0);
    // A core participant for the disabled slot cannot even start.
    const disabledCore = spawnParticipant(harness, {
      role: 'core',
      slot: 'core-analysis',
      instanceId: 'core-disabled',
      expectedVersion: harness.alternate.manifest.manifestVersion,
      expectedSha256: harness.alternate.manifestSha256,
    });
    try {
      const status = await disabledCore.start();
      assert.equal(status.identityReady, false);
      assert.equal(status.errorCode, 'SLOT_DISABLED');
      const outcome = await disabledCore.cmd({ cmd: 'analyze' });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.status, 'PROVIDER_ERROR');
      assert.equal(requests(disabledCore.events()).length, 0);
    } finally {
      await disabledCore.stop();
    }
    const record = inspect(harness);
    const enabled = record.raw.inventory.filter((entry) => entry.enabled);
    assert.deepEqual(enabled.map((entry) => entry.slot), ['telegram'], 'the report must not claim six active operations');
  } finally {
    await observer.stop();
    await telegram.stop();
  }
});

test('XP-04: missing, duplicate or stale target participation blocks activation', async () => {
  const harness = createHarness();
  const core = spawnParticipant(harness, { role: 'core', slot: 'core-analysis', instanceId: 'core-1' });
  try {
    const quiesce = runCli(harness, 'quiesce', { descriptor: harness.descriptorPath, 'transition-id': randomUuid() });
    assert.equal(quiesce.body.ok, true);
    assert.equal(runCli(harness, 'prepare').body.ok, true);
    // Only the core slot registers; the Telegram slot is missing.
    await core.start();
    const corePrepared = await core.cmd({ cmd: 'prepare' });
    assert.ok(corePrepared.sha256);
    runCli(harness, 'collect-prepared');
    const armed = runCli(harness, 'arm');
    assert.equal(armed.body.ok, false);
    assert.match(JSON.stringify(armed.body), /telegram/);
    // A duplicate target claim for a slot is refused.
    const duplicate = runCli(harness, 'register', {
      slot: 'core-analysis',
      instance: 'core-duplicate',
      'artifact-sha': harness.fixture.artifactMap['core-analysis'],
    });
    assert.equal(duplicate.body.ok, false);
    assert.match(JSON.stringify(duplicate.body), /already claimed|SLOT_CONFLICT/);
    // A stale acknowledgement cannot be collected.
    const staleRetire = runCli(harness, 'retire', {
      slot: 'core-analysis',
      instance: 'core-1',
      kind: 'QUIESCED',
    });
    assert.equal(staleRetire.body.ok, false, 'not an old member of this transition');
    assert.equal(inspect(harness).phase, 'PREPARING');
  } finally {
    await core.stop();
  }
});

test('XP-05: a held Guard workflow blocks the barrier and its late content has no effect', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    await telegram.cmd({ cmd: 'hold-next' });
    const started = await telegram.cmd({ cmd: 'guarded-effect-async', opId: 'held', label: 'held-effect' });
    assert.equal(started.started, true);

    const quiesce = runCli(harness, 'quiesce', { descriptor: harness.descriptorPath, 'transition-id': randomUuid() });
    assert.equal(quiesce.body.ok, true);
    await telegram.cmd({ cmd: 'poll' });
    // New admission is denied while the old scope is outstanding.
    await assert.rejects(telegram.cmd({ cmd: 'scout' }));
    // The ack is refused, so PREPARING cannot be reached.
    await assert.rejects(telegram.cmd({ cmd: 'ack' }));
    assert.equal(runCli(harness, 'prepare').body.ok, false);

    await telegram.cmd({ cmd: 'release' });
    const outcome = await telegram.cmd({ cmd: 'await-operation', opId: 'held' });
    assert.equal(outcome.ok, false, 'the retired workflow cannot dispatch its effect');
    assert.equal(effects(telegram.events()).length, 0);
    // After the drain the participant can acknowledge.
    const ack = await telegram.cmd({ cmd: 'ack' });
    assert.equal(ack.ack.status, 'QUIESCED');
    assert.equal(core.events().length > 0, true);
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('XP-06: pause after the control check but before dispatch still blocks the commit', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    // Hold the transport so the workflow is between check and effect.
    await telegram.cmd({ cmd: 'hold-next' });
    await telegram.cmd({ cmd: 'guarded-effect-async', opId: 'dispatch', label: 'exchange-order' });
    const quiesce = runCli(harness, 'quiesce', { descriptor: harness.descriptorPath, 'transition-id': randomUuid() });
    assert.equal(quiesce.body.ok, true);
    await telegram.cmd({ cmd: 'poll' });
    assert.equal(runCli(harness, 'prepare').body.ok, false, 'the counted scope prevents QUIESCED');
    await telegram.cmd({ cmd: 'release' });
    const outcome = await telegram.cmd({ cmd: 'await-operation', opId: 'dispatch' });
    assert.equal(outcome.ok, false);
    assert.equal(effects(telegram.events()).length, 0, 'no dispatch after the generation was retired');
    assert.equal(inspect(harness).phase, 'QUIESCING');
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('XP-07: a pending human approval invalidates across a transition and is never replayed', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    await telegram.cmd({ cmd: 'register-approval', approvalId: 'batch:0', operation: 'GUARD' });
    assert.equal((await telegram.cmd({ cmd: 'pending-count' })).pending, 1);
    const quiesce = runCli(harness, 'quiesce', { descriptor: harness.descriptorPath, 'transition-id': randomUuid() });
    assert.equal(quiesce.body.ok, true);
    await telegram.cmd({ cmd: 'poll' });
    assert.equal((await telegram.cmd({ cmd: 'pending-count' })).pending, 0);
    await assert.rejects(telegram.cmd({ cmd: 'consume-approval', approvalId: 'batch:0' }));
    // Reflection is refused while gated: no rule append.
    const reflect = await telegram.cmd({ cmd: 'reflect' });
    assert.equal(reflect.reflected, false);
    const reflectRequests = requests(telegram.events()).filter((entry) => entry.operation === 'REFLECT');
    assert.equal(reflectRequests.length, 0);
    // Deterministic protection keeps ticking while AI is gated.
    const tick = await telegram.cmd({ cmd: 'protection-tick' });
    assert.equal(tick.ticks, 1);
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('BOT-SEAM entry: a delayed exec tap after validation but before dispatch yields zero orders', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    // The analysis is bound to the preview ticket, and the human taps "execute".
    const prepared = await telegram.cmd({ cmd: 'prepare-entry', ticket: 'effect:pv-entry' });
    assert.equal(prepared.pending, 1, 'the preview ticket carries the generation sidecar');
    assert.equal(prepared.outstandingWork, 0, 'the counted scope moved to the ticket, not a gap');

    // The dispatch path is delayed (slow prep / another awaits) after the tap...
    await telegram.cmd({ cmd: 'entry-dispatch', ticket: 'effect:pv-entry', opId: 'entry-1', hold: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // ...and the release starts while it is still in flight: the counted scope
    // must prevent a QUIESCED acknowledgement, so the barrier cannot advance.
    const quiesce = runCli(harness, 'quiesce', { descriptor: harness.descriptorPath, 'transition-id': randomUuid() });
    assert.equal(quiesce.body.ok, true);
    await telegram.cmd({ cmd: 'poll' });
    assert.equal(runCli(harness, 'prepare').body.ok, false, 'an in-flight AI order prevents the barrier from advancing');

    await telegram.cmd({ cmd: 'release-effect' });
    const outcome = await telegram.cmd({ cmd: 'await-operation', opId: 'entry-1' });
    assert.equal(outcome.ok, false, 'the dispatch under a quiescing generation is refused');
    assert.equal(effects(telegram.events()).filter((entry) => entry.lane === 'entry-linear').length, 0, 'zero orders');
    assert.equal(inspect(harness).generation, 1, 'the transition never committed');
    assert.equal(inspect(harness).phase, 'QUIESCING');

    // The barrier retired the sidecars: the same tap is refused outright rather
    // than reinterpreted as a current-generation approval.
    await telegram.cmd({ cmd: 'poll' });
    assert.equal((await telegram.cmd({ cmd: 'pending-count' })).pending, 0);
    await telegram.cmd({ cmd: 'entry-dispatch', ticket: 'effect:pv-entry', opId: 'entry-2' });
    const replay = await telegram.cmd({ cmd: 'await-operation', opId: 'entry-2' });
    assert.equal(replay.ok, false, 'a retired sidecar cannot be replayed');
    assert.equal(effects(telegram.events()).length, 0);
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('BOT-SEAM auto-close: a close held between the verdict and the dispatch is never placed', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    await telegram.cmd({ cmd: 'auto-close', opId: 'close-1', hold: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The verdict is in hand and the counted scope is open: the barrier cannot
    // be satisfied, so the QUIESCED acknowledgement (and any activation) waits.
    const quiesce = runCli(harness, 'quiesce', { descriptor: harness.descriptorPath, 'transition-id': randomUuid() });
    assert.equal(quiesce.body.ok, true);
    await telegram.cmd({ cmd: 'poll' });
    assert.equal(runCli(harness, 'prepare').body.ok, false, 'an in-flight AI close prevents the barrier from advancing');

    await telegram.cmd({ cmd: 'release-effect' });
    const outcome = await telegram.cmd({ cmd: 'await-operation', opId: 'close-1' });
    assert.equal(outcome.ok, false, 'the close dispatch is refused under a quiescing generation');
    assert.equal(effects(telegram.events()).filter((entry) => entry.lane === 'stopcheck-auto-close').length, 0, 'zero close orders');
    assert.equal(inspect(harness).phase, 'QUIESCING');
    assert.equal(inspect(harness).generation, 1);
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('BOT-SEAM entry: the preparation runs inside the counted scope and its result reaches the write', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    const prepared = await telegram.cmd({ cmd: 'prepare-entry', ticket: 'effect:pv-ok' });
    assert.equal(prepared.pending, 1);

    // The happy path through the real gateway in a real child process: the plan
    // prepares (spot quantity / drift), then the control record is read, then the
    // write happens with what the preparation produced.
    await telegram.cmd({ cmd: 'entry-dispatch', ticket: 'effect:pv-ok', opId: 'entry-ok' });
    const outcome = await telegram.cmd({ cmd: 'await-operation', opId: 'entry-ok' });
    assert.equal(outcome.ok, true, 'the entry is dispatched under the current generation');
    assert.equal(outcome.result.qty, '0.001', 'the write uses the prepared quantity');

    const placed = effects(telegram.events());
    assert.equal(placed.length, 1, 'exactly one order');
    assert.equal(placed[0].qty, '0.001', 'a skipped preparation would have shipped qty: null');
    assert.ok(
      telegram.events().some((entry) => entry.event === 'prepare' && entry.lane === 'entry-linear'),
      'the preparation ran in the child process, not only in the parent test',
    );
    assert.equal((await telegram.cmd({ cmd: 'guard-status' })).outstandingWork, 0, 'the counted scope is settled');
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('BOT-SEAM entry: a preparation that aborts the trade places no order at all', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    await telegram.cmd({ cmd: 'prepare-entry', ticket: 'effect:pv-abort' });
    await telegram.cmd({ cmd: 'entry-dispatch', ticket: 'effect:pv-abort', opId: 'entry-abort', abort: true });
    const outcome = await telegram.cmd({ cmd: 'await-operation', opId: 'entry-abort' });
    assert.equal(outcome.ok, true);
    assert.match(outcome.result.aborted, /slippage threshold/, 'the caller receives the abort reason');
    assert.equal(effects(telegram.events()).length, 0, 'an aborted preparation never writes');
    assert.equal((await telegram.cmd({ cmd: 'pending-count' })).pending, 0);
    assert.equal((await telegram.cmd({ cmd: 'guard-status' })).outstandingWork, 0, 'the scope is released, not retained');
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('BOT-SEAM auto-close: the position is resolved by prepare and exactly one close is placed', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    await telegram.cmd({ cmd: 'auto-close', opId: 'close-ok' });
    const outcome = await telegram.cmd({ cmd: 'await-operation', opId: 'close-ok' });
    assert.equal(outcome.ok, true);
    const closes = effects(telegram.events()).filter((entry) => entry.lane === 'stopcheck-auto-close');
    assert.equal(closes.length, 1, 'exactly one close');
    assert.equal(closes[0].qty, '0.25', 'the close uses the position the preparation resolved');
    assert.equal(inspect(harness).generation, 1, 'no transition was started');
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('XP-08: a crashed participant keeps the barrier gated until it is fenced', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  const quiesce = runCli(harness, 'quiesce', { descriptor: harness.descriptorPath, 'transition-id': randomUuid() });
  assert.equal(quiesce.body.ok, true);
  // The Telegram participant dies mid-quiescence.
  await telegram.kill('SIGKILL');
  await core.cmd({ cmd: 'poll' });
  await core.cmd({ cmd: 'ack' });
  runCli(harness, 'collect-quiescence');
  const prepareBlocked = runCli(harness, 'prepare');
  assert.equal(prepareBlocked.body.ok, false, 'no activation without the missing member');

  // An operator fence is required and must reference reconciliation evidence.
  const fence = {
    schemaVersion: 1,
    deploymentId: harness.deploymentId,
    transitionId: quiesce.body.transitionId,
    slot: 'telegram',
    instanceId: 'tg-1',
    operatorApprovalId: 'operator-fence-xp08',
    processFenceEvidenceRef: 'evidence/fencing/tg-1-exit.txt',
    outcomeReconciliationRef: 'evidence/reconciliation/open-orders.txt',
  };
  const fencePath = path.join(harness.workDir, 'fence-xp08.json');
  fs.writeFileSync(fencePath, JSON.stringify(fence));
  const retired = runCli(harness, 'retire', {
    slot: 'telegram', instance: 'tg-1', kind: 'FENCED', evidence: fencePath,
  });
  assert.equal(retired.body.ok, true);
  assert.equal(runCli(harness, 'prepare').body.ok, true);

  // A replacement with a new instance ID can join the target generation.
  const replacement = spawnParticipant(harness, { role: 'telegram', slot: 'telegram', instanceId: 'tg-2' });
  try {
    const joined = await replacement.start();
    assert.equal(joined.identityReady, true);
    assert.equal(joined.inferenceEnabled, false, 'target-only registration cannot infer early');
    await assert.rejects(replacement.cmd({ cmd: 'scout' }));
    // The dead instance cannot rejoin that slot.
    const zombie = runCli(harness, 'register', {
      slot: 'telegram',
      instance: 'tg-1',
      'artifact-sha': harness.fixture.artifactMap.telegram,
    });
    assert.equal(zombie.body.ok, false);
  } finally {
    await replacement.stop();
    await core.stop();
  }
});

test('XP-09: a crash at every control write boundary yields old/new-record-or-paused, never a torn ACTIVE', async () => {
  const harness = createHarness();
  const phases = [];
  for (const point of ['before-write', 'before-file-fsync', 'before-rename', 'after-rename', 'before-dir-fsync']) {
    const probe = createHarness();
    const before = inspect(probe);
    const crashed = runCli(probe, 'quiesce', {
      descriptor: probe.descriptorPath,
      'transition-id': randomUuid(),
    }, { fault: point });
    assert.equal(crashed.body.ok, false, `fault ${point} must fail the command`);
    const after = inspect(probe);
    assert.ok(['PAUSED', 'QUIESCING'].includes(after.phase), `fault ${point} left phase ${after.phase}`);
    if (after.phase === 'QUIESCING') {
      assert.equal(after.generation, 0);
      assert.equal(after.raw.nextGeneration, before.raw.nextGeneration === null ? 1 : before.raw.nextGeneration);
    }
    // The lock never leaks after a crash.
    assert.equal(fs.existsSync(path.join(probe.fixture.controlDir, 'writer.lock')), false);
    // The record remains readable and the high-water mark is never reused.
    assert.ok(['PAUSED', 'QUIESCING'].includes(after.phase), `fault ${point} left phase ${after.phase}`);
    const retry = runCli(probe, 'quiesce', { descriptor: probe.descriptorPath, 'transition-id': randomUuid() });
    if (after.phase === 'PAUSED') {
      assert.equal(retry.body.ok, true, `fault ${point}: a PAUSED record must accept a fresh quiesce`);
      assert.equal(retry.body.highWaterGeneration, 1);
    } else {
      assert.equal(retry.body.ok, false, `fault ${point}: a QUIESCING record must not accept a second quiesce`);
      assert.equal(inspect(probe).raw.nextGeneration, 1);
    }
    phases.push(after.phase);
  }
  assert.ok(phases.length === 5);
});

test('XP-10: rollback to the same digest advances the generation and revives no token', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    const rollback = await completeBarrier(harness, {
      descriptorPath: harness.descriptorPath,
      descriptorSha: descriptorSha(harness),
      manifestVersion: harness.fixture.manifest.manifestVersion,
      manifestSha256: harness.fixture.manifestSha256,
      participants: [
        { child: core, slot: 'core-analysis', instanceId: 'core-1', retained: true },
        { child: telegram, slot: 'telegram', instanceId: 'tg-1', retained: true },
      ],
      observerArtifactSha256: harness.fixture.artifactMap['core-analysis'],
    });
    assert.equal(rollback.generation, 2);
    assert.equal(rollback.manifestSha256, harness.fixture.manifestSha256);
    const coreStatus = await core.cmd({ cmd: 'status' });
    assert.equal(coreStatus.generation, 2);
    // The rolled-back generation still serves work under the same digest.
    assert.equal((await core.cmd({ cmd: 'analyze' })).ok, true);
    const retireAcks = fs.readdirSync(path.join(harness.fixture.controlDir, 'acks'));
    assert.ok(retireAcks.length >= 2, 'per-transition ack directories are retained');
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('XP-11: drift, an unreadable store or profile skew gates AI and recovers without rebinding', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    // A participant-local profile/version skew never affects the healthy peers.
    const skew = spawnParticipant(harness, {
      role: 'telegram',
      slot: 'telegram',
      instanceId: 'tg-skew',
      expectedVersion: 'release-0',
    });
    assert.equal((await skew.start()).errorCode, 'MANIFEST_STALE');
    assert.equal(requests(skew.events()).length, 0);
    await skew.stop();

    assert.equal((await telegram.cmd({ cmd: 'scout' })).ok, true);
    const controlFile = path.join(harness.fixture.controlDir, 'control.json');
    fs.chmodSync(controlFile, 0o000);
    try {
      await assert.rejects(telegram.cmd({ cmd: 'scout' }));
      const tgStatus = await telegram.cmd({ cmd: 'status' });
      assert.equal(tgStatus.admissionOpen, false);
      assert.equal(tgStatus.errorCode, 'COORDINATION_UNAVAILABLE');
      // The core participant is also gated by an unreadable store — a control
      // failure pauses AI everywhere. It does not invent a fallback model.
      const coreOutcome = await core.cmd({ cmd: 'analyze' });
      assert.equal(coreOutcome.ok, false);
      assert.equal((await core.cmd({ cmd: 'status' })).admissionOpen, false);
    } finally {
      fs.chmodSync(controlFile, 0o600);
    }
    // Both recover the same committed generation once the store is readable.
    const recovered = await telegram.cmd({ cmd: 'poll' });
    assert.equal(recovered.inferenceEnabled, true);
    assert.equal(recovered.generation, 1);
    assert.equal((await telegram.cmd({ cmd: 'scout' })).ok, true);
    const coreRecovered = await core.cmd({ cmd: 'poll' });
    assert.equal(coreRecovered.generation, 1);
    assert.equal((await core.cmd({ cmd: 'analyze' })).ok, true);
    // No alternate model was silently selected anywhere.
    for (const entry of [...requests(telegram.events()), ...requests(core.events())]) {
      assert.equal(entry.model, 'deepseek-chat');
    }
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('XP-12: an old-binary restart refuses identity and a competing writer loses', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  const next = await completeBarrier(harness, {
    descriptorPath: harness.alternateDescriptorPath,
    descriptorSha: harness.alternate.descriptorSha256,
    manifestVersion: harness.alternate.manifest.manifestVersion,
    manifestSha256: harness.alternate.manifestSha256,
    participants: [
      { child: core, slot: 'core-analysis', instanceId: 'core-1', retained: true },
      { child: telegram, slot: 'telegram', instanceId: 'tg-1', retained: true },
    ],
    observerArtifactSha256: harness.fixture.artifactMap['core-analysis'],
  });
  assert.equal(next.generation, 2);
  const oldBinary = spawnParticipant(harness, { role: 'core', slot: 'core-analysis', instanceId: 'core-old' });
  try {
    const status = await oldBinary.start();
    assert.equal(status.identityReady, false);
    assert.equal(status.errorCode, 'MANIFEST_STALE');
    assert.equal(requests(oldBinary.events()).length, 0);

    // Two writers with the same expected revision: the second loses on CAS.
    const revision = inspect(harness).revision;
    const first = runCli(harness, 'quiesce', {
      descriptor: harness.alternateDescriptorPath,
      'transition-id': randomUuid(),
      'expected-revision': revision,
    });
    assert.equal(first.body.ok, true);
    const second = runCli(harness, 'quiesce', {
      descriptor: harness.alternateDescriptorPath,
      'transition-id': randomUuid(),
      'expected-revision': revision,
    });
    assert.equal(second.body.ok, false);
    assert.match(JSON.stringify(second.body), /revision/);
  } finally {
    await oldBinary.stop();
    await core.stop();
    await telegram.stop();
  }
});

test('XP-13: a hung participant blocks the transition without an implicit fence; protection continues', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    await telegram.cmd({ cmd: 'hold-next' });
    await telegram.cmd({ cmd: 'guarded-effect-async', opId: 'hung', label: 'hung-order' });
    const quiesce = runCli(harness, 'quiesce', { descriptor: harness.descriptorPath, 'transition-id': randomUuid() });
    assert.equal(quiesce.body.ok, true);
    // The coordinator waits; the phase does not advance and no fence is invented.
    assert.equal(runCli(harness, 'prepare').body.ok, false);
    assert.equal(inspect(harness).phase, 'QUIESCING');
    const tick = await telegram.cmd({ cmd: 'protection-tick' });
    assert.ok(tick.ticks >= 1);
    const blocked = runCli(harness, 'inspect');
    assert.ok(blocked.body.blockers.blockers.length > 0);
    await telegram.cmd({ cmd: 'release' });
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('XP-14: disaster recovery starts a new deployment ID, never a reused generation', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    const fresh = createHarness({ manifestVersion: 'release-9' });
    assert.notEqual(fresh.deploymentId, harness.deploymentId);
    const freshInspect = inspect(fresh);
    assert.equal(freshInspect.phase, 'PAUSED');
    assert.equal(freshInspect.generation, 0);
    // The old expectations are meaningless in the new deployment.
    const stale = spawnParticipant(fresh, {
      role: 'core',
      slot: 'core-analysis',
      instanceId: 'core-stale',
      expectedVersion: harness.fixture.manifest.manifestVersion,
      expectedSha256: harness.fixture.manifestSha256,
    });
    assert.equal((await stale.start()).identityReady, false);
    await stale.stop();
    // The old deployment record is untouched (control-plane recovery only).
    assert.equal(inspect(harness).generation, 1);
    assert.equal((await core.cmd({ cmd: 'analyze' })).ok, true);
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('XP-15: paused AI with adversarial approvals produces no shadow work and no secret leak', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    await telegram.cmd({ cmd: 'register-approval', approvalId: 'batch-adversarial', operation: 'GUARD' });
    const quiesce = runCli(harness, 'quiesce', { descriptor: harness.descriptorPath, 'transition-id': randomUuid() });
    assert.equal(quiesce.body.ok, true);
    await telegram.cmd({ cmd: 'poll' });
    await core.cmd({ cmd: 'poll' });
    await assert.rejects(telegram.cmd({ cmd: 'consume-approval', approvalId: 'batch-adversarial' }));
    await assert.rejects(telegram.cmd({ cmd: 'scout' }));
    // The core composition maps a coordination failure to a provider-error
    // outcome (public schema unchanged), never to a usable analysis.
    const coreOutcome = await core.cmd({ cmd: 'analyze' });
    assert.equal(coreOutcome.ok, false);
    assert.equal(coreOutcome.status, 'PROVIDER_ERROR');
    // Deterministic protection paths keep running.
    assert.equal((await telegram.cmd({ cmd: 'protection-tick' })).ticks, 1);
    assert.equal((await telegram.cmd({ cmd: 'protection-tick' })).ticks, 2);
    // No new provider request after the pause.
    const before = requests(telegram.events()).length + requests(core.events()).length;
    await telegram.cmd({ cmd: 'reflect' });
    const after = requests(telegram.events()).length + requests(core.events()).length;
    assert.equal(after, before);
    for (const event of [...telegram.events(), ...core.events()]) {
      assert.ok(!JSON.stringify(event).includes('fake-secret-sentinel'));
    }
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('XP-16: empty-roster first activation, then a slot add and a disable, all through the barrier', async () => {
  const harness = createHarness({
    alternateInventory: [
      { slot: 'core-analysis', operations: ['ANALYZE'], enabled: false },
      { slot: 'telegram', operations: ['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT'], enabled: true },
      { slot: 'telegram-b', operations: ['SCOUT'], enabled: true },
    ],
    alternateArtifactMap: { 'telegram-b': 'ff'.repeat(32) },
  });
  const core = spawnParticipant(harness, { role: 'core', slot: 'core-analysis', instanceId: 'core-1' });
  const telegram = spawnParticipant(harness, { role: 'telegram', slot: 'telegram', instanceId: 'tg-1' });
  try {
    // First activation: the initial barrier has an empty old roster.
    const activated = await completeBarrier(harness, {
      descriptorPath: harness.descriptorPath,
      descriptorSha: descriptorSha(harness),
      manifestVersion: harness.fixture.manifest.manifestVersion,
      manifestSha256: harness.fixture.manifestSha256,
      participants: [
        { child: core, slot: 'core-analysis', instanceId: 'core-1', retained: false },
        { child: telegram, slot: 'telegram', instanceId: 'tg-1', retained: false },
      ],
      observerArtifactSha256: harness.fixture.artifactMap['core-analysis'],
    });
    assert.equal(activated.generation, 1);

    const replica = spawnParticipant(harness, {
      role: 'telegram',
      slot: 'telegram-b',
      instanceId: 'tg-b-1',
      artifactSha256: 'ff'.repeat(32),
      expectedVersion: harness.alternate.manifest.manifestVersion,
      expectedSha256: harness.alternate.manifestSha256,
    });
    try {
      const target = harness.alternate;
      const quiesce = runCli(harness, 'quiesce', {
        descriptor: harness.alternateDescriptorPath,
        'transition-id': randomUuid(),
      });
      assert.equal(quiesce.body.ok, true);
      await core.cmd({ cmd: 'poll' });
      await core.cmd({ cmd: 'ack' });
      await telegram.cmd({ cmd: 'poll' });
      await telegram.cmd({ cmd: 'ack' });
      runCli(harness, 'collect-quiescence');
      assert.equal(runCli(harness, 'prepare').body.ok, true);
      // The removed slot cannot be registered; the added one can.
      const removed = runCli(harness, 'register', {
        slot: 'core-analysis', instance: 'core-2', 'artifact-sha': harness.fixture.artifactMap['core-analysis'],
      });
      assert.equal(removed.body.ok, false);
      const joined = await replica.start();
      assert.equal(joined.identityReady, true);
      assert.equal(joined.inferenceEnabled, false);
      await assert.rejects(replica.cmd({ cmd: 'scout' }));
      assert.equal(inspect(harness).phase, 'PREPARING');
      assert.equal(target.descriptor.binding.inventorySha256.length, 64);
    } finally {
      await replica.stop();
    }
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('XP-17: stage grants authorize in-process staging, abort cleanly and survive a controller restart', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    const quiesce = runCli(harness, 'quiesce', {
      descriptor: harness.alternateDescriptorPath,
      'transition-id': randomUuid(),
    });
    assert.equal(quiesce.body.ok, true);
    await core.cmd({ cmd: 'poll' });
    await core.cmd({ cmd: 'ack' });
    await telegram.cmd({ cmd: 'poll' });
    await telegram.cmd({ cmd: 'ack' });
    runCli(harness, 'collect-quiescence');
    assert.equal(runCli(harness, 'prepare').body.ok, true);

    const grant = runCli(harness, 'grant', {
      slot: 'telegram',
      instance: 'tg-1',
      'descriptor-sha': harness.alternate.descriptorSha256,
    });
    assert.equal(grant.body.ok, true);
    // A wrong instance cannot use another instance's grant.
    const refused = runCli(harness, 'grant', {
      slot: 'telegram',
      instance: 'tg-ghost',
      'descriptor-sha': harness.alternate.descriptorSha256,
    });
    assert.equal(refused.body.ok, false);
    const staged = await telegram.cmd({
      cmd: 'prepare',
      grant: { descriptorSha256: harness.alternate.descriptorSha256, approvalId: grant.body.approvalId },
    });
    assert.equal(staged.generation, 2);
    // Abort: the operator pauses instead of committing; the staged runtime is
    // discarded and the old generation is not resurrected.
    const paused = runCli(harness, 'pause', { reason: 'abort rehearsal' });
    assert.equal(paused.body.ok, true);
    const afterPause = await telegram.cmd({ cmd: 'poll' });
    assert.equal(afterPause.inferenceEnabled, false);
    await assert.rejects(telegram.cmd({ cmd: 'scout' }));

    // Recovery pins the same descriptor under a fresh generation; the old ack
    // bytes are not reused (the CLI requires fresh evidence).
    const recovered = runCli(harness, 'recover', {
      descriptor: harness.alternateDescriptorPath,
      'transition-id': randomUuid(),
    });
    assert.equal(recovered.body.ok, true);
    assert.equal(recovered.body.nextGeneration, 3);
    assert.equal(recovered.body.stageGrants.length, 0);
    assert.ok(recovered.body.targetMembers.length === 0);
    // Immutable phase evidence is retained on disk across controller restarts.
    const acksDir = path.join(harness.fixture.controlDir, 'acks');
    assert.ok(fs.readdirSync(acksDir).length >= 1);
  } finally {
    await core.stop();
    await telegram.stop();
  }
});

test('XP-18: recovery from QUIESCING/PREPARING/ARMED keeps old and target obligations with fresh acks', async () => {
  const harness = createHarness();
  const { core, telegram } = await firstActivation(harness);
  try {
    for (const stopPhase of ['QUIESCING', 'PREPARING', 'ARMED']) {
      const transitionId = randomUuid();
      if (inspect(harness).phase !== 'QUIESCING') {
        const quiesce = runCli(harness, 'quiesce', {
          descriptor: harness.alternateDescriptorPath,
          'transition-id': transitionId,
        });
        assert.equal(quiesce.body.ok, true);
      }
      if (stopPhase !== 'QUIESCING') {
        await core.cmd({ cmd: 'poll' });
        await core.cmd({ cmd: 'ack' });
        await telegram.cmd({ cmd: 'poll' });
        await telegram.cmd({ cmd: 'ack' });
        runCli(harness, 'collect-quiescence');
        assert.equal(runCli(harness, 'prepare').body.ok, true);
      }
      if (stopPhase === 'ARMED') {
        for (const [child, slot, id] of [[core, 'core-analysis', 'core-1'], [telegram, 'telegram', 'tg-1']]) {
          runCli(harness, 'grant', { slot, instance: id, 'descriptor-sha': harness.alternate.descriptorSha256 });
          const staged = await child.cmd({
            cmd: 'prepare',
            grant: { descriptorSha256: harness.alternate.descriptorSha256, approvalId: inspect(harness).raw.approvalId },
          });
          assert.ok(staged.sha256);
        }
        runCli(harness, 'collect-prepared');
        const observerRun = runCli(harness, 'observer', {
          'transition-id': inspect(harness).raw.transitionId,
          'observer-id': 'core-bootstrap',
          'artifact-sha': harness.fixture.artifactMap['core-analysis'],
          'manifest-version': harness.alternate.manifest.manifestVersion,
          'manifest-sha': harness.alternate.manifestSha256,
        });
        assert.equal(observerRun.body.ok, true, JSON.stringify(observerRun.body));
        const armed = runCli(harness, 'arm');
        assert.equal(armed.body.ok, true, JSON.stringify(armed.body));
      }
      assert.equal(inspect(harness).phase, stopPhase);
      const paused = runCli(harness, 'pause', { reason: `recovery rehearsal from ${stopPhase}` });
      assert.equal(paused.body.ok, true);
      const recovered = runCli(harness, 'recover', {
        descriptor: harness.alternateDescriptorPath,
        'transition-id': randomUuid(),
      });
      assert.equal(recovered.body.ok, true);
      assert.equal(recovered.body.phase, 'QUIESCING');
      assert.ok(recovered.body.nextGeneration > paused.body.generation);
      // Both old instances remain obligations in the fresh barrier.
      const slots = recovered.body.oldMembers.map((member) => member.slot).sort();
      assert.deepEqual(slots, ['core-analysis', 'telegram']);
      // Fresh acks are required under the new transition ID.
      const prepareAgain = runCli(harness, 'prepare');
      assert.equal(prepareAgain.body.ok, false);
    }
  } finally {
    await core.stop();
    await telegram.stop();
  }
});
