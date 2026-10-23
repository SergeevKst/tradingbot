/**
 * UAI-06B/06C — the bot-facing effect seam (architecture §5, XP-06/XP-07).
 *
 * The failure this suite exists for: the AI call and the exchange write are not
 * adjacent. `bot.mjs` turns a Scout/Guard response into a preview ticket, an
 * exit proposal or an unattended entry, and the dispatch happens later — after a
 * human tap, after a timer, after another few awaits. The gateway in
 * `src/telegram/ai-effect-gateway.mjs` is the only path from the bot to an
 * AI-derived exchange write, so these tests drive *that* seam with the real
 * composition, real control store and real transition machinery: an activation
 * between the response and the dispatch must produce **zero** dispatch, and an
 * unknown dispatch outcome must keep the participant unable to acknowledge
 * quiescence until it is reconciled.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createTelegramAIComposition } from '../src/telegram/ai-composition.mjs';
import { createAIEffectGateway, classifyDispatchOutcome, UnknownEffectOutcome } from '../src/telegram/ai-effect-gateway.mjs';
import { COORDINATION_ERROR_CODE } from '../src/errors/coordination-error.mjs';
import {
  activateFixture,
  advanceBarrier,
  artifactDigest,
  buildAlternateDescriptor,
  buildReleaseFixture,
  buildTestGuard,
  guardConfigFor,
} from './fixtures/ai-release/factory.mjs';

function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Fake Telegram transport (no provider, no Telegram, no exchange). */
function fakeChat(calls, behaviour = {}) {
  return () => ({
    getCacheStats: () => ({ hits: 0, misses: 0, zeroHitCalls: 0, calls: 0, hitRatio: 0 }),
    generateIdeas: async (context) => {
      calls.push({ operation: 'SCOUT', context });
      return { prompt: { version: 'scout' }, parsed: { ok: true, ideas: [{ symbol: 'BTCUSDT', side: 'LONG' }], issues: [] }, raw: '{}' };
    },
    filterIdea: async (idea) => {
      calls.push({ operation: 'GUARD', idea });
      return { prompt: { version: 'guard' }, parsed: { ok: true, value: { approved: true, confidence: 0.8 } }, raw: '{}' };
    },
    _completeGuard: async (prompt) => {
      calls.push({ operation: 'GUARD_RAW', prompt });
      if (behaviour.holdGuard) await behaviour.holdGuard.promise;
      return JSON.stringify({ action: 'CLOSE', reason: 'loss and trend against', confidence: 0.9 });
    },
  });
}

/**
 * @param {any} fixture
 * @param {{ instanceId?: string, calls?: any[], behaviour?: object }} [options]
 */
function participant(fixture, options = {}) {
  const calls = options.calls ?? [];
  const config = guardConfigFor(fixture, 'telegram');
  const composition = createTelegramAIComposition({
    config,
    controlStore: fixture.store,
    artifactIdentity: { artifactSha256: config.artifactSha256 },
    transportDependencies: {
      apiKeyLoader: () => 'fake-key-not-a-secret',
      createChatClient: fakeChat(calls, options.behaviour),
      createReflector: () => ({ reflect: async () => ({ lesson: 'x', proposedRule: '', severity: 'low', matchedExistingRule: true }) }),
    },
    instanceId: options.instanceId ?? 'inst-tg-1',
  });
  const gateway = createAIEffectGateway({
    composition,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { composition, gateway, calls };
}

/**
 * @param {any} target descriptor bundle from `buildAlternateDescriptor`
 * @param {string} slot
 * @returns {string}
 */
function targetArtifact(target, slot) {
  const artifact = target.descriptor.artifacts.find((candidate) => candidate.slot === slot);
  assert.ok(artifact, `the target descriptor assigns an artifact to ${slot}`);
  return artifact.artifactSha256;
}

/**
 * Walk a real barrier to the next ACTIVE generation. The old instances are
 * operator-fenced (the operator asserts they are gone), and the target roster is
 * made of fresh instances — exactly the restart/release situation in which the
 * pre-transition process must never dispatch again.
 */
function activateNextGeneration(fixture, instances = { 'core-analysis': 'inst-core-2', telegram: 'inst-tg-2' }) {
  const target = buildAlternateDescriptor({
    fixture,
    artifactMap: { telegram: artifactDigest('telegram-v2'), 'core-analysis': artifactDigest('core-analysis-v2') },
    approvalId: 'approval-002',
  });
  const participants = [
    { guard: buildTestGuard(fixture, { slot: 'core-analysis', instanceId: instances['core-analysis'], artifactSha256: targetArtifact(target, 'core-analysis') }), slot: 'core-analysis', instanceId: instances['core-analysis'] },
    { guard: buildTestGuard(fixture, { slot: 'telegram', instanceId: instances.telegram, artifactSha256: targetArtifact(target, 'telegram') }), slot: 'telegram', instanceId: instances.telegram },
  ];
  const advanced = advanceBarrier(fixture, {
    descriptor: target.descriptor,
    participants,
    fence: ['core-analysis', 'telegram'],
    operatorApprovalId: 'approval-fence-002',
    transitionId: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(advanced.record.phase, 'ACTIVE');
  assert.equal(advanced.record.generation, 2);
  return advanced;
}

test('effect gateway: activation between the AI response and the tap yields zero dispatch', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  assert.equal(composition.start().identityReady, true);

  // The analysis happens in generation 1 and is bound to a preview ticket.
  const analysis = composition.beginApprovalConsumption(
    composition.registerPendingApproval('batch:0', { operation: 'GUARD' }).approvalId,
  );
  gateway.hold('effect:pv-1', analysis, { operation: 'GUARD', purpose: 'entry' });
  assert.equal(composition.status().outstandingWork, 0, 'the ticket holds the scope, not the workflow');
  assert.equal(composition.pendingApprovalCount(), 1);

  // Generation 2 is activated while the card sits in the chat.
  activateNextGeneration(fixture);

  const effects = [];
  assert.throws(
    () => gateway.consume('effect:pv-1'),
    (error) => [
      COORDINATION_ERROR_CODE.ACTIVATION_PAUSED,
      COORDINATION_ERROR_CODE.APPROVAL_INVALID,
      COORDINATION_ERROR_CODE.GENERATION_RETIRED,
      COORDINATION_ERROR_CODE.IDENTITY_MISMATCH,
    ].includes(error.code),
  );
  // The tap is rejected before any await, so nothing can be dispatched.
  assert.deepEqual(effects, []);
});

test('effect gateway: activation between the tap and the dispatch yields zero dispatch', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();

  const analysis = composition.beginApprovalConsumption(
    composition.registerPendingApproval('batch:1', { operation: 'GUARD' }).approvalId,
  );
  gateway.hold('effect:pv-2', analysis, { operation: 'GUARD', purpose: 'entry' });

  // The human taps "execute": provenance is consumed synchronously, the counted
  // token exists before the first await of the dispatch path.
  const handle = gateway.consume('effect:pv-2');
  assert.equal(composition.status().outstandingWork, 1);

  // A whole release is completed while the dispatch path is still preparing.
  activateNextGeneration(fixture);

  const effects = [];
  await assert.rejects(
    gateway.dispatch(handle, {
      lane: 'entry-spot',
      effect: async () => {
        effects.push('order:placed');
        return { orderId: 'should-never-exist' };
      },
    }),
    (error) => error.code === COORDINATION_ERROR_CODE.ACTIVATION_PAUSED
      || error.code === COORDINATION_ERROR_CODE.GENERATION_RETIRED,
  );
  assert.deepEqual(effects, [], 'no order under a retired provenance');
  assert.equal(composition.status().outstandingWork, 0, 'the refused scope is released');
});

test('effect gateway: an in-flight dispatch blocks a QUIESCED acknowledgement', async () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();

  const analysis = composition.beginApprovalConsumption(
    composition.registerPendingApproval('batch:2', { operation: 'GUARD' }).approvalId,
  );
  gateway.hold('effect:pv-3', analysis, { operation: 'GUARD', purpose: 'entry' });
  const handle = gateway.consume('effect:pv-3');

  const dispatched = deferred();
  const seen = deferred();
  const pending = gateway.dispatch(handle, {
    lane: 'entry-linear',
    effect: async () => {
      seen.resolve();
      await dispatched.promise;
      return { resultMsg: 'ok', orderId: 'order-1' };
    },
  });
  await seen.promise;

  // The barrier starts and the participant cannot acknowledge while the order is
  // in flight: this is the ordering guarantee that makes a check-to-dispatch
  // race safe.
  fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: '44444444-4444-4444-8444-444444444444' },
    { expectedRevision: active.record.revision },
  );
  composition.poll();
  assert.throws(() => composition.acknowledgeQuiesced(), /outstanding AI work|pending AI approvals/);

  dispatched.resolve();
  const result = await pending;
  assert.equal(result.orderId, 'order-1');
  assert.equal(composition.status().outstandingWork, 0);
  assert.equal(composition.acknowledgeQuiesced().ack.status, 'QUIESCED');
});

test('effect gateway: an unknown exchange outcome is retained until an operator reconciles it', async () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();

  const analysis = composition.beginApprovalConsumption(
    composition.registerPendingApproval('batch:3', { operation: 'GUARD' }).approvalId,
  );
  gateway.hold('effect:pv-4', analysis, { operation: 'GUARD', purpose: 'entry' });
  const handle = gateway.consume('effect:pv-4');

  const transportFailure = new TypeError('fetch failed');
  await assert.rejects(
    gateway.dispatch(handle, { lane: 'entry-spot', effect: async () => { throw transportFailure; } }),
    (error) => error instanceof UnknownEffectOutcome && error.requiresReconciliation === true,
  );
  // The scope stays counted: an exchange outcome nobody can prove must never be
  // hidden behind a QUIESCED acknowledgement.
  assert.equal(composition.unresolvedEffects(), 1);
  assert.equal(composition.status().outstandingWork, 1);

  fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: '55555555-5555-4555-8555-555555555555' },
    { expectedRevision: active.record.revision },
  );
  composition.poll();
  assert.throws(() => composition.acknowledgeQuiesced(), /unknown AI-derived effect outcome/);

  // Only an explicit operator reference releases it, and the release is audited.
  assert.throws(() => composition.reconcileUnresolved({ workId: handle.token.id, reference: '' }), /operator reference/);
  const reconciled = composition.reconcileUnresolved({ workId: handle.token.id, reference: 'bybit-order-9f2c checked manually' });
  assert.equal(reconciled.workId, handle.token.id);
  assert.equal(composition.unresolvedEffects(), 0);
  assert.equal(composition.status().outstandingWork, 0);
  assert.equal(composition.acknowledgeQuiesced().ack.status, 'QUIESCED');
});

test('effect gateway: a definite exchange rejection keeps the ticket retryable and dispatches once', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();

  const analysis = composition.beginApprovalConsumption(
    composition.registerPendingApproval('batch:4', { operation: 'GUARD' }).approvalId,
  );
  gateway.hold('effect:pv-5', analysis, { operation: 'GUARD', purpose: 'entry' });

  const first = gateway.consume('effect:pv-5');
  await assert.rejects(
    gateway.dispatch(first, {
      lane: 'entry-spot',
      rearmAs: 'effect:pv-5',
      effect: async () => { throw new Error('Bybit market order failed retCode=110007: insufficient balance'); },
    }),
    /retCode=110007/,
  );
  // Definitively refused: nothing is live, so the provenance returns to the
  // ticket and the operator may retry the same card.
  assert.equal(composition.pendingApprovalCount(), 1);
  assert.equal(composition.unresolvedEffects(), 0);
  assert.equal(composition.status().outstandingWork, 0);

  const second = gateway.consume('effect:pv-5');
  const effects = [];
  const result = await gateway.dispatch(second, {
    lane: 'entry-spot',
    rearmAs: 'effect:pv-5',
    effect: async () => {
      effects.push('order:placed');
      return { resultMsg: 'ok', orderId: 'order-2' };
    },
  });
  assert.equal(result.orderId, 'order-2');
  assert.deepEqual(effects, ['order:placed']);
  assert.equal(composition.pendingApprovalCount(), 0, 'a consumed sidecar is single-use');
});

test('effect gateway: a duplicate tap cannot consume the same provenance twice', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();

  const analysis = composition.beginApprovalConsumption(
    composition.registerPendingApproval('batch:5', { operation: 'GUARD' }).approvalId,
  );
  gateway.hold('effect:pv-6', analysis, { operation: 'GUARD', purpose: 'entry' });
  const first = gateway.consume('effect:pv-6');
  assert.throws(
    () => gateway.consume('effect:pv-6'),
    (error) => error.code === COORDINATION_ERROR_CODE.APPROVAL_INVALID,
  );
  await gateway.dispatch(first, { lane: 'entry-spot', effect: async () => ({ orderId: 'order-3' }) });
  assert.equal(composition.status().outstandingWork, 0);
});

test('effect gateway: a restart has no provenance, so a stale card cannot dispatch', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const before = participant(fixture);
  before.composition.start();
  const analysis = before.composition.beginApprovalConsumption(
    before.composition.registerPendingApproval('batch:6', { operation: 'GUARD' }).approvalId,
  );
  before.gateway.hold('effect:pv-7', analysis, { operation: 'GUARD', purpose: 'entry' });

  // Restart: same admitted instance, brand-new process-local sidecar table.
  const after = participant(fixture);
  assert.equal(after.composition.start().identityReady, true);
  assert.equal(after.composition.pendingApprovalCount(), 0);
  const effects = [];
  assert.throws(
    () => after.gateway.consume('effect:pv-7'),
    (error) => error.code === COORDINATION_ERROR_CODE.APPROVAL_INVALID,
  );
  assert.deepEqual(effects, []);
});

test('effect gateway: a restarted process cannot adopt an occupied slot (fail closed)', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const restarted = participant(fixture, { instanceId: 'inst-tg-restarted' });
  const status = restarted.composition.start();
  assert.equal(status.identityReady, false);
  assert.equal(status.inferenceEnabled, false);
  assert.equal(status.errorCode, COORDINATION_ERROR_CODE.SLOT_CONFLICT);
  // The committed membership is untouched: replacing a member is a transition
  // with operator fencing evidence, not a self-adoption.
  const record = fixture.store.readRecord();
  assert.equal(record.members.find((member) => member.slot === 'telegram').instanceId, 'inst-tg-1');
  assert.equal(record.generation, 1);
});

test('effect gateway: workflow-scoped dispatch (auto-close shape) is refused after an activation', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const held = deferred();
  const { composition, gateway } = participant(fixture, { behaviour: { holdGuard: held } });
  composition.start();
  const client = composition.getChatClient();

  const closed = [];
  const pass = gateway.workflow('STOPCHECK', async (work) => {
    const content = await client._completeGuard({ system: 's', user: 'u' });
    assert.match(content, /CLOSE/);
    // The verdict is in hand; the generation changes before the close dispatch.
    activateNextGeneration(fixture);
    await gateway.dispatchInScope(work, {
      lane: 'stopcheck-auto-close',
      effect: async () => {
        closed.push('position:closed');
        return { orderId: 'should-never-exist' };
      },
    });
  });

  held.resolve();
  await assert.rejects(pass, (error) => error.code === COORDINATION_ERROR_CODE.ACTIVATION_PAUSED
    || error.code === COORDINATION_ERROR_CODE.GENERATION_RETIRED);
  assert.deepEqual(closed, [], 'no AI close under a retired generation');
});

test('effect gateway: legacy mode is a pass-through (no control plane, no gating)', async () => {
  const gateway = createAIEffectGateway({ composition: null });
  assert.equal(gateway.enabled, false);
  assert.equal(gateway.consume('anything'), null);
  assert.equal(gateway.hold('anything', null), null);
  assert.equal(gateway.drop('anything'), false);
  const effects = [];
  const result = await gateway.dispatch(null, {
    lane: 'legacy-entry',
    effect: async () => {
      effects.push('order:placed');
      return { orderId: 'legacy-1' };
    },
  });
  assert.equal(result.orderId, 'legacy-1');
  assert.deepEqual(effects, ['order:placed']);
  const scoped = await gateway.workflow('SCOUT', async (work) => work);
  assert.equal(scoped, null);
});

test('effect gateway: a workflow that produces an exit proposal re-arms its token without failing', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();
  const client = composition.getChatClient();

  // The monitor shape: the model answers EXIT and the proposal inherits the
  // generation of the review. Converting the counted token must not make the
  // workflow itself look "retired".
  const proposal = await gateway.workflow('MONITOR', async (work) => {
    await client.completeMonitor({ system: 'monitor', user: 'u' });
    const held = work.rearm('exit:exit-1', { operation: 'MONITOR', purpose: 'exit' });
    return held;
  });
  assert.equal(proposal.approvalId, 'exit:exit-1');
  assert.equal(composition.status().outstandingWork, 0);
  assert.equal(composition.pendingApprovalCount(), 1);

  // The close button can then consume it exactly once.
  const handle = gateway.consume('exit:exit-1');
  assert.equal(composition.status().outstandingWork, 1);
  const closed = [];
  await gateway.dispatch(handle, { lane: 'ai-exit', effect: async () => { closed.push('close:placed'); return { orderId: 'close-1' }; } });
  assert.deepEqual(closed, ['close:placed']);
  assert.equal(composition.status().outstandingWork, 0);
});

test('effect gateway: dispatch outcome classification distinguishes definite from unknown', () => {
  assert.equal(classifyDispatchOutcome(new Error('Bybit order create failed retCode=170131: Insufficient balance')), 'definite');
  assert.equal(classifyDispatchOutcome(new TypeError('fetch failed')), 'unknown');
  assert.equal(classifyDispatchOutcome(Object.assign(new Error('timeout'), { name: 'AbortError' })), 'unknown');
  assert.equal(classifyDispatchOutcome(new Error('110043: leverage not modified')), 'unknown', 'no retCode means the answer was never seen');
});

// ---------------------------------------------------------------------------
// `prepare` — the non-write part of a dispatch (metadata reads, leverage, the
// drift decision, fetching the position a close will use). These tests exist
// because a gateway that only ran `effect` silently disabled parts of the live
// trading path: a spot entry would send `qty: null`, futures would never apply
// the requested leverage, the moved-market rejection would be unreachable, and
// the AI close button would dereference a null position.
// ---------------------------------------------------------------------------

test('effect gateway: the entry plan prepares inside the counted scope before the write', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();

  const analysis = composition.beginApprovalConsumption(
    composition.registerPendingApproval('batch:10', { operation: 'GUARD' }).approvalId,
  );
  gateway.hold('effect:pv-10', analysis, { operation: 'GUARD', purpose: 'entry' });
  const handle = gateway.consume('effect:pv-10');

  // Exec shape: prepare normalises the spot quantity and decides the drift; the
  // effect is the write and uses what prepare produced.
  const order = [];
  /** @type {string | null} */
  let spotQty = null;
  /** @type {{ action: string, diffPct: number } | null} */
  let entryDecision = null;
  let workDuringPrepare = null;
  let workDuringEffect = null;

  const result = await gateway.dispatch(handle, {
    lane: 'entry-linear',
    rearmAs: 'effect:pv-10',
    prepare: async () => {
      order.push('prepare');
      workDuringPrepare = composition.status().outstandingWork;
      spotQty = '0.001';
      entryDecision = { action: 'proceed', diffPct: 0.42 };
      return {};
    },
    effect: async () => {
      order.push('effect');
      workDuringEffect = composition.status().outstandingWork;
      // Exactly the exec: dereference — with a skipped prepare this is
      // `String(null)` and `null.diffPct`.
      return { orderId: 'order-entry', qty: String(spotQty), diffPct: entryDecision.diffPct };
    },
  });

  assert.deepEqual(order, ['prepare', 'effect'], 'the preparation runs, and before the write');
  assert.equal(workDuringPrepare, 1, 'the token is counted while the preparation awaits');
  assert.equal(workDuringEffect, 1, 'the token is still counted while the write runs');
  assert.equal(result.qty, '0.001', 'the write uses the prepared quantity, not null');
  assert.equal(result.diffPct, 0.42, 'the write uses the prepared drift decision');
  assert.equal(composition.status().outstandingWork, 0, 'the scope is settled after the write');
  assert.equal(composition.pendingApprovalCount(), 0, 'a consumed sidecar stays consumed');
});

test('effect gateway: an entry whose preparation aborts places no order and releases the scope', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();

  const analysis = composition.beginApprovalConsumption(
    composition.registerPendingApproval('batch:11', { operation: 'GUARD' }).approvalId,
  );
  gateway.hold('effect:pv-11', analysis, { operation: 'GUARD', purpose: 'entry' });
  const handle = gateway.consume('effect:pv-11');

  const calls = [];
  const result = await gateway.dispatch(handle, {
    lane: 'entry-linear',
    rearmAs: 'effect:pv-11',
    prepare: async () => {
      calls.push('prepare');
      // The moved-market rejection: the caller reports this string to its user
      // and deletes the ticket, exactly like the baseline `decision.action ===
      // 'reject'` branch.
      return { abort: '⛔ Рынок ушёл слишком далеко (1.20%) — сделка отменена.' };
    },
    effect: async () => {
      calls.push('effect');
      return { orderId: 'must-not-exist' };
    },
  });

  assert.deepEqual(calls, ['prepare'], 'the effect never runs');
  assert.match(result.aborted, /Рынок ушёл/, 'the caller receives the rejection reason');
  assert.equal(result.orderId, undefined);
  assert.equal(composition.status().outstandingWork, 0, 'the aborted scope is released');
  assert.equal(composition.unresolvedEffects(), 0, 'an abort is not an unresolved effect');
  assert.equal(composition.pendingApprovalCount(), 0, 'the consumed ticket is not re-armed');
});

test('effect gateway: a generation switch during the preparation still yields zero dispatch', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();

  const analysis = composition.beginApprovalConsumption(
    composition.registerPendingApproval('batch:12', { operation: 'GUARD' }).approvalId,
  );
  gateway.hold('effect:pv-12', analysis, { operation: 'GUARD', purpose: 'entry' });
  const handle = gateway.consume('effect:pv-12');

  const prepared = deferred();
  const release = deferred();
  const effects = [];
  const pending = gateway.dispatch(handle, {
    lane: 'entry-linear',
    prepare: async () => {
      prepared.resolve();
      // A slow exchange-metadata read.
      await release.promise;
      return {};
    },
    effect: async () => {
      effects.push('order:placed');
      return { orderId: 'should-never-exist' };
    },
  });
  await prepared.promise;

  // The whole release happens while the preparation is in flight. The control
  // record is reread *after* the preparation, so the write is still refused.
  activateNextGeneration(fixture);
  release.resolve();

  await assert.rejects(pending, (error) => error.code === COORDINATION_ERROR_CODE.ACTIVATION_PAUSED
    || error.code === COORDINATION_ERROR_CODE.GENERATION_RETIRED);
  assert.deepEqual(effects, [], 'no order under a retired provenance');
  assert.equal(composition.status().outstandingWork, 0, 'the refused scope is released');
});

test('effect gateway: a failed preparation releases the scope and keeps the ticket retryable', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();

  const analysis = composition.beginApprovalConsumption(
    composition.registerPendingApproval('batch:13', { operation: 'GUARD' }).approvalId,
  );
  gateway.hold('effect:pv-13', analysis, { operation: 'GUARD', purpose: 'entry' });

  const first = gateway.consume('effect:pv-13');
  const effects = [];
  await assert.rejects(
    gateway.dispatch(first, {
      lane: 'entry-linear',
      rearmAs: 'effect:pv-13',
      prepare: async () => {
        // e.g. the exchange refused the leverage before any order was created.
        throw new Error('Не удалось выставить плечо 10×. retCode=110074');
      },
      effect: async () => {
        effects.push('order:first');
        return { orderId: 'must-not-exist' };
      },
    }),
    /Не удалось выставить плечо/,
  );
  assert.deepEqual(effects, [], 'nothing was sent');
  assert.equal(composition.status().outstandingWork, 0, 'the scope is released, never retained');
  assert.equal(composition.unresolvedEffects(), 0, 'a preparation failure is not an unknown outcome');
  assert.equal(composition.pendingApprovalCount(), 1, 'the ticket keeps its provenance so the operator can retry');

  // Retry with a lower leverage: exactly one order, under the same provenance.
  const second = gateway.consume('effect:pv-13');
  const result = await gateway.dispatch(second, {
    lane: 'entry-linear',
    rearmAs: 'effect:pv-13',
    prepare: async () => ({}),
    effect: async () => {
      effects.push('order:retry');
      return { orderId: 'order-retry' };
    },
  });
  assert.equal(result.orderId, 'order-retry');
  assert.deepEqual(effects, ['order:retry']);
  assert.equal(composition.status().outstandingWork, 0);
  assert.equal(composition.pendingApprovalCount(), 0);
});

test('effect gateway: the exit plan resolves the position in prepare (a skipped prepare would throw)', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();

  const analysis = composition.beginApprovalConsumption(
    composition.registerPendingApproval('batch:14', { operation: 'GUARD' }).approvalId,
  );
  gateway.hold('effect:exit-1', analysis, { operation: 'GUARD', purpose: 'exit' });
  const handle = gateway.consume('effect:exit-1');

  // doexit shape: the close needs the live position, which prepare fetches.
  /** @type {{ side: string, size: string } | null} */
  let pos = null;
  /** @type {string | null} */
  let closeQty = null;

  // The failure mode this covers: without a preparation the effect dereferences
  // a null position — the reviewer's reproduction of the defect.
  const unpreparedEffect = async () => ({ orderId: 'x', side: pos.side });
  await assert.rejects(unpreparedEffect(), TypeError);

  const result = await gateway.dispatch(handle, {
    lane: 'ai-exit',
    prepare: async () => {
      pos = { side: 'LONG', size: '0.25' };
      closeQty = '0.25';
      return {};
    },
    effect: async () => ({ orderId: 'close-1', side: pos.side, qty: closeQty }),
  });

  assert.equal(result.orderId, 'close-1');
  assert.equal(result.side, 'LONG', 'the close uses the position the preparation fetched');
  assert.equal(result.qty, '0.25');
  assert.equal(composition.status().outstandingWork, 0);
});

test('effect gateway: an exit whose preparation finds nothing to close places no order', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();

  const analysis = composition.beginApprovalConsumption(
    composition.registerPendingApproval('batch:15', { operation: 'GUARD' }).approvalId,
  );
  gateway.hold('effect:exit-2', analysis, { operation: 'GUARD', purpose: 'exit' });
  const handle = gateway.consume('effect:exit-2');

  const effects = [];
  const result = await gateway.dispatch(handle, {
    lane: 'ai-exit',
    prepare: async () => ({ abort: 'Позиция уже закрыта.' }),
    effect: async () => {
      effects.push('close:placed');
      return { orderId: 'must-not-exist' };
    },
  });

  assert.equal(result.aborted, 'Позиция уже закрыта.');
  assert.deepEqual(effects, []);
  assert.equal(composition.status().outstandingWork, 0);
});

test('effect gateway: a workflow-scoped dispatch runs its preparation before the write', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition, gateway } = participant(fixture);
  composition.start();

  // Stop-check auto-close shape: one counted workflow from the verdict to the
  // close, with the position resolved inside that scope.
  const closed = [];
  const outcome = await gateway.workflow('STOPCHECK', async (work) => {
    /** @type {{ side: string, size: string } | null} */
    let position = null;
    return gateway.dispatchInScope(work, {
      lane: 'stopcheck-auto-close',
      prepare: async () => {
        position = { side: 'SHORT', size: '0.25' };
        return {};
      },
      effect: async () => {
        closed.push(`${position.side}:${position.size}`);
        return { orderId: 'close-scoped' };
      },
    });
  });

  assert.equal(outcome.orderId, 'close-scoped');
  assert.deepEqual(closed, ['SHORT:0.25'], 'the close used the position the preparation resolved');
  assert.equal(composition.status().outstandingWork, 0);
});

test('effect gateway: legacy mode also prepares the plan and honours its abort', async () => {
  const gateway = createAIEffectGateway({ composition: null });
  const calls = [];

  const aborted = await gateway.dispatch(null, {
    lane: 'legacy-entry',
    prepare: async () => {
      calls.push('prepare');
      return { abort: 'Рынок ушёл — отменено' };
    },
    effect: async () => {
      calls.push('effect');
      return { orderId: 'must-not-exist' };
    },
  });
  assert.deepEqual(calls, ['prepare'], 'a legacy dispatch prepares and honours the abort');
  assert.deepEqual(aborted, { aborted: 'Рынок ушёл — отменено' });

  // The legacy write path still uses what the preparation produced — the same
  // plan shape as single mode, so the exchange side effects are identical.
  /** @type {string | null} */
  let spotQty = null;
  const result = await gateway.dispatch(null, {
    lane: 'legacy-entry',
    prepare: async () => {
      calls.push('prepare-2');
      spotQty = '0.002';
      return {};
    },
    effect: async () => {
      calls.push('effect-2');
      return { orderId: 'legacy-1', qty: String(spotQty) };
    },
  });
  assert.deepEqual(calls, ['prepare', 'prepare-2', 'effect-2']);
  assert.equal(result.qty, '0.002');

  const scoped = await gateway.dispatchInScope(null, {
    lane: 'legacy-close',
    prepare: async () => {
      calls.push('prepare-3');
      return { abort: 'Позиция уже закрыта.' };
    },
    effect: async () => {
      calls.push('effect-3');
      return { orderId: 'must-not-exist' };
    },
  });
  assert.deepEqual(scoped, { aborted: 'Позиция уже закрыта.' });
  assert.equal(calls.includes('effect-3'), false);
});

