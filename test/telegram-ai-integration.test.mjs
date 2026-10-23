/**
 * UAI-06B — Telegram participant binding, whole-work scope and effect fences.
 *
 * The five AI roles share one participant binding. These tests use the real
 * composition with a fake chat/reflector transport, so the behaviour under test
 * is the composition itself (admission, scopes, approvals, invalidation), not a
 * stand-in that re-implements it.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  createTelegramAIComposition,
  assertProfileSupportedByFacade,
  TELEGRAM_OPERATIONS,
} from '../src/telegram/ai-composition.mjs';
import { COORDINATION_ERROR_CODE } from '../src/errors/coordination-error.mjs';
import { createCapabilityProfile } from '../src/ai/operation-profiles.mjs';
import {
  activateFixture,
  buildReleaseFixture,
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

/**
 * @param {any[]} calls
 * @param {{ holdGuard?: boolean, failGuard?: Error | null }} [behaviour]
 */
function fakeChat(calls, behaviour = {}) {
  return (options) => {
    calls.push({ kind: 'client-options', options });
    return {
      getCacheStats: () => ({ hits: 0, misses: 0, zeroHitCalls: 0, calls: 0, hitRatio: 0 }),
      generateIdeas: async (context) => {
        calls.push({ operation: 'SCOUT', context });
        return { prompt: { version: 'scout' }, parsed: { ok: true, ideas: [{ symbol: 'BTCUSDT', side: 'LONG' }], issues: [] }, raw: '{}' };
      },
      filterIdea: async (idea, market, opts) => {
        calls.push({ operation: 'GUARD', idea, market, opts });
        if (behaviour.failGuard && idea.symbol === behaviour.failGuard.symbol) throw behaviour.failGuard;
        return { prompt: { version: 'guard' }, parsed: { ok: true, value: { approved: true, confidence: 0.8 } }, raw: '{}' };
      },
      _completeGuard: async (prompt) => {
        calls.push({ operation: 'GUARD_RAW', prompt });
        if (behaviour.holdGuard) await behaviour.holdGuard.promise;
        return JSON.stringify({ verdict: 'HOLD', reason: 'test' });
      },
    };
  };
}

/**
 * @param {any} fixture
 * @param {{ calls?: any[], behaviour?: object, createReflector?: Function, config?: object }} [options]
 */
function composition(fixture, options = {}) {
  const calls = options.calls ?? [];
  const config = options.config ?? guardConfigFor(fixture, 'telegram');
  return {
    calls,
    composition: createTelegramAIComposition({
      config,
      controlStore: fixture.store,
      artifactIdentity: { artifactSha256: config.artifactSha256 },
      transportDependencies: {
        apiKeyLoader: () => 'fake-key-not-a-secret',
        createChatClient: fakeChat(calls, options.behaviour),
        createReflector: options.createReflector ?? ((opts) => {
          calls.push({ kind: 'reflector-options', opts });
          return {
            reflect: async (trade) => {
              calls.push({ operation: 'REFLECT', trade });
              return { lesson: 'lesson', proposedRule: '', severity: 'low', matchedExistingRule: true };
            },
          };
        }),
      },
      instanceId: 'inst-tg-1',
    }),
  };
}

test('UAI-06B telegram: all five roles are bound to one guard and recorded', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { calls, composition: tg } = composition(fixture);
  assert.equal(tg.start().identityReady, true);
  const client = tg.getChatClient();

  const scout = await client.generateIdeas({ symbols: ['BTCUSDT'] });
  assert.equal(scout.parsed.ok, true);
  const guard = await client.filterIdea({ symbol: 'BTCUSDT', side: 'LONG' }, { markPrice: 1 }, {});
  assert.equal(guard.parsed.ok, true);
  await client.completeMonitor({ system: 's', user: 'u' });
  await client.completeStopcheck({ system: 's', user: 'u' });
  const reflection = await client.reflect({ symbol: 'BTCUSDT' });
  assert.equal(reflection.severity, 'low');

  const operations = calls.filter((call) => call.operation).map((call) => call.operation);
  assert.deepEqual(operations, ['SCOUT', 'GUARD', 'GUARD_RAW', 'GUARD_RAW', 'REFLECT']);
  assert.deepEqual(TELEGRAM_OPERATIONS, ['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT']);
  // One deployment-wide identity: every client option comes from the manifest.
  const clientOptions = calls.find((call) => call.kind === 'client-options').options;
  assert.equal(clientOptions.model, 'deepseek-chat');
  assert.equal(clientOptions.guardModel, 'deepseek-chat');
  assert.equal(clientOptions.scoutProvider, 'deepseek');
  assert.equal(clientOptions.guardProvider, 'deepseek');
  assert.equal(clientOptions.baseUrl, 'https://api.deepseek.com');
  assert.equal(clientOptions.timeoutMs, 60000);
  assert.equal(tg.status().outstandingWork, 0);
});

test('UAI-06B telegram: Scout -> parallel Guard share one counted workflow', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition: tg } = composition(fixture);
  tg.start();
  const client = tg.getChatClient();

  let maxOutstanding = 0;
  await tg.runInWorkflow('SCOUT', async () => {
    await client.generateIdeas({ symbols: ['BTCUSDT'] });
    maxOutstanding = Math.max(maxOutstanding, tg.status().outstandingWork);
    await Promise.all([
      client.filterIdea({ symbol: 'BTCUSDT', side: 'LONG' }, {}, {}),
      client.filterIdea({ symbol: 'ETHUSDT', side: 'SHORT' }, {}, {}),
      client.filterIdea({ symbol: 'SOLUSDT', side: 'LONG' }, {}, {}),
    ]);
    maxOutstanding = Math.max(maxOutstanding, tg.status().outstandingWork);
    assert.equal(tg.status().outstandingWork, 1, 'nested calls join the outer workflow');
  });
  assert.equal(maxOutstanding, 1);
  assert.equal(tg.status().outstandingWork, 0);
});

test('UAI-06B telegram: a failed parallel Guard cannot let survivors reach an effect', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const effects = [];
  const fail = Object.assign(new Error('guard transport failed'), { symbol: 'ETHUSDT' });
  const { composition: tg } = composition(fixture, { behaviour: { failGuard: fail } });
  tg.start();
  const client = tg.getChatClient();

  await assert.rejects(
    tg.runInWorkflow('SCOUT', async () => {
      await client.generateIdeas({ symbols: ['BTCUSDT'] });
      // The bot fans out and handles per-idea failures; any failure taints the
      // workflow, so the derived effects are refused even for the survivors.
      const outcomes = await Promise.allSettled([
        client.filterIdea({ symbol: 'BTCUSDT', side: 'LONG' }, {}, {}),
        client.filterIdea({ symbol: 'ETHUSDT', side: 'SHORT' }, {}, {}),
        client.filterIdea({ symbol: 'SOLUSDT', side: 'LONG' }, {}, {}),
      ]);
      const survivors = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      assert.ok(survivors.length >= 1, 'at least one Guard survived');
      await tg.runEffect(async () => {
        effects.push('order:survivor');
      });
    }),
    /guard transport failed|derived effect is refused/,
  );
  assert.deepEqual(effects, []);
  assert.equal(tg.status().outstandingWork, 0);
});

test('UAI-06B telegram: a delayed monitor response cannot append a rule after quiescence', async () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const held = deferred();
  const { calls, composition: tg } = composition(fixture, { behaviour: { holdGuard: held } });
  tg.start();
  const client = tg.getChatClient();

  const pending = client.completeMonitor({ system: 's', user: 'u' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tg.status().outstandingWork, 1);

  fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: 'acac1212-1212-4212-8212-121212121212' },
    { expectedRevision: active.record.revision },
  );
  tg.poll();
  assert.throws(() => tg.acknowledgeQuiesced(), /outstanding AI work/);

  held.resolve();
  await assert.rejects(pending);
  assert.equal(tg.status().outstandingWork, 0);
  assert.equal(tg.acknowledgeQuiesced().ack.status, 'QUIESCED');
  // The reflector is refused while the participant is quiescing: no rule append.
  const rulesBefore = calls.filter((call) => call.operation === 'REFLECT').length;
  assert.equal(await tg.reflect({ symbol: 'BTCUSDT' }), null);
  assert.equal(calls.filter((call) => call.operation === 'REFLECT').length, rulesBefore);
});

test('UAI-06B telegram: a pending human approval is single-use and dies with the generation', async () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const { composition: tg } = composition(fixture);
  tg.start();
  tg.registerPendingApproval('batch:0', { operation: 'GUARD' });
  const scope = tg.beginApprovalConsumption('batch:0');
  assert.equal(tg.status().outstandingWork, 1);
  assert.throws(() => tg.beginApprovalConsumption('batch:0'), /no pending AI approval/);
  scope.settle();
  assert.equal(tg.status().outstandingWork, 0);

  tg.registerPendingApproval('batch:1', { operation: 'GUARD' });
  fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: 'adad1212-1212-4212-8212-121212121212' },
    { expectedRevision: active.record.revision },
  );
  tg.poll();
  assert.equal(tg.pendingApprovalCount(), 0, 'the barrier retires pending approvals');
  assert.throws(
    () => tg.beginApprovalConsumption('batch:1'),
    (error) => [COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, COORDINATION_ERROR_CODE.APPROVAL_INVALID].includes(error.code),
  );
});

test('UAI-06B telegram: the guarded facade refuses to exist before identity is admitted', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const { composition: tg } = composition(fixture, {
    config: { ...guardConfigFor(fixture, 'telegram'), expectedManifestSha256: 'f'.repeat(64) },
  });
  const status = tg.start();
  assert.equal(status.identityReady, false);
  assert.throws(() => tg.getChatClient(), (error) => error.code === COORDINATION_ERROR_CODE.MANIFEST_STALE);
  assert.equal(await tg.reflect({ symbol: 'BTCUSDT' }), null);
});

test('UAI-06B telegram: the facade rejects a profile it cannot honour', () => {
  const profile = createCapabilityProfile({
    profileId: 'deepseek-custom',
    providerId: 'deepseek',
    operations: {
      ANALYZE: { temperature: 0, reasoningEffort: null, maxOutputTokens: null, stream: false, responseFormat: 'json_object', timeoutMs: 1000 },
      SCOUT: { temperature: 0.7, reasoningEffort: null, maxOutputTokens: null, stream: false, responseFormat: 'json_object', timeoutMs: 1000 },
      GUARD: { temperature: 0.4, reasoningEffort: null, maxOutputTokens: null, stream: false, responseFormat: 'json_object', timeoutMs: 1000 },
      MONITOR: { temperature: 0, reasoningEffort: null, maxOutputTokens: null, stream: false, responseFormat: 'json_object', timeoutMs: 1000 },
      STOPCHECK: { temperature: 0, reasoningEffort: null, maxOutputTokens: null, stream: false, responseFormat: 'json_object', timeoutMs: 1000 },
      REFLECT: { temperature: 0, reasoningEffort: null, maxOutputTokens: null, stream: false, responseFormat: 'json_object', timeoutMs: 1000 },
    },
  });
  assert.throws(
    () => assertProfileSupportedByFacade(profile),
    (error) => error.code === COORDINATION_ERROR_CODE.CONFIGURATION_ERROR,
  );
});

test('UAI-06B telegram: reflect is null (not an error) when the participant is gated', async () => {
  const fixture = buildReleaseFixture();
  const active = activateFixture(fixture);
  const { calls, composition: tg } = composition(fixture);
  tg.start();
  fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: 'aeae1212-1212-4212-8212-121212121212' },
    { expectedRevision: active.record.revision },
  );
  tg.poll();
  assert.equal(await tg.reflect({ symbol: 'BTCUSDT' }), null);
  assert.equal(calls.filter((call) => call.operation === 'REFLECT').length, 0);
});
