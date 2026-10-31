/**
 * Production wiring of the data-only Skill runtime (architecture v1.1 §3.1,
 * §6.2, §10 Phase C/E; acceptance criteria AC-01, AC-03, AC-04).
 *
 * These tests drive the *actual* production entry points — the core ANALYZE
 * composition and the Telegram participant composition — against a real v2
 * joint binding, a real immutably-addressed package store inside a real control
 * directory, a real execution plan and real capability profiles. Only the
 * provider transport is injected, so no network, exchange or credential is
 * touched.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { test, describe } from 'node:test';

import { AI_OPERATIONS } from '../src/ai/operation-profiles.mjs';
import { AI_STATUS } from '../src/ai/interface.mjs';
import { createCoreAIComposition } from '../src/ai/core-ai-composition.mjs';
import { createTelegramAIComposition } from '../src/telegram/ai-composition.mjs';
import {
  createProductionDispatch,
  resolveSkillRuntimeMode,
} from '../src/ai/skills/production.mjs';
import { buildMigratedRecord } from '../src/ai/skills/migration.mjs';
import { sha256Hex } from '../src/config/jcs.mjs';
import {
  MODELS,
  SAMPLE_INPUTS,
  SAMPLE_OUTPUTS,
  chatEnvelope,
} from './fixtures/skills/factory.mjs';
import { deployV2 } from './fixtures/skills/deployment.mjs';
import {
  buildReleaseFixture,
  guardConfigFor,
  makeStore,
} from './fixtures/ai-release/factory.mjs';

/** Map a plan model id back to its operation, for the scripted transport. */
const OPERATION_BY_MODEL = Object.freeze(
  Object.fromEntries(AI_OPERATIONS.map((operation) => [MODELS[operation].modelId, operation])),
);

/**
 * @param {any[]} calls
 * @param {{ fail?: (operation: string) => any }} [options]
 */
function scriptedTransport(calls, options = {}) {
  return {
    id: 'offline-scripted',
    calls,
    async complete(request) {
      calls.push(request);
      const operation = OPERATION_BY_MODEL[request.identity.modelId];
      assert.ok(operation, `every request must carry a planned model identity, saw ${request.identity.modelId}`);
      if (options.fail) {
        const answer = options.fail(operation);
        if (answer !== undefined) return { status: 200, body: answer, usage: null, latencyMs: 1 };
      }
      return { status: 200, body: chatEnvelope(SAMPLE_OUTPUTS[operation]), usage: null, latencyMs: 1 };
    },
  };
}

/** The trusted projection of an AI context the core composition consumes. */
function aiContext() {
  return {
    schemaVersion: '1',
    generatedAt: 1_700_000_000_000,
    market: {
      ...SAMPLE_INPUTS.ANALYZE.market,
      markPrice: 102,
      spread: 0.2,
      volume24h: 1000,
      orderbook: null,
    },
    position: null,
    portfolio: null,
    strategy: null,
    risk: null,
  };
}

/**
 * @param {ReturnType<typeof deployV2>} deployment
 * @param {{ transport: any, skillMode?: string }} input
 */
function coreComposition(deployment, input) {
  const config = guardConfigFor(deployment.fixture, 'core-analysis');
  return createCoreAIComposition({
    config,
    controlStore: deployment.fixture.store,
    artifactIdentity: { artifactSha256: config.artifactSha256 },
    skillMode: input.skillMode ?? 'v2',
    skillTransport: input.transport,
    skillArtifact: deployment.fx.artifact,
    instanceId: 'inst-core-analysis',
    clock: () => 1_700_000_000_000,
  });
}

/**
 * @param {ReturnType<typeof deployV2>} deployment
 * @param {{ transport: any, skillMode?: string, instanceId?: string }} input
 */
function telegramComposition(deployment, input) {
  const config = guardConfigFor(deployment.fixture, 'telegram');
  return createTelegramAIComposition({
    config,
    controlStore: deployment.fixture.store,
    artifactIdentity: { artifactSha256: config.artifactSha256 },
    skillMode: input.skillMode ?? 'v2',
    skillTransport: input.transport,
    skillArtifact: deployment.fx.artifact,
    instanceId: input.instanceId ?? 'inst-telegram',
    clock: () => 1_700_000_000_000,
  });
}

describe('Core ANALYZE runs through its packaged skill (AC-01, AC-03)', () => {
  test('a v2 generation dispatches ANALYZE with its own package, model and settings', async () => {
    const deployment = deployV2();
    try {
      const calls = [];
      const core = coreComposition(deployment, { transport: scriptedTransport(calls) });
      const status = core.start();
      assert.equal(status.identityReady, true);
      assert.equal(status.inferenceEnabled, true, status.errorCode ?? 'admitted');

      const outcome = await core.analyze(aiContext());
      assert.equal(outcome.status, AI_STATUS.OK);
      assert.equal(outcome.ok, true);
      assert.equal(outcome.analysis.bias, 'BULLISH');
      assert.equal(outcome.analysis.symbol, 'BTCUSDT');
      assert.equal(outcome.modelId, MODELS.ANALYZE.modelId);
      assert.equal(outcome.promptVersion, `skill:${deployment.fx.packages.ANALYZE.parsed.packageId}@1.0.0`);

      // The observed wire request equals the plan identity for ANALYZE.
      assert.equal(calls.length, 1);
      assert.equal(calls[0].identity.modelId, MODELS.ANALYZE.modelId);
      assert.equal(calls[0].identity.canonicalBaseUrl, MODELS.ANALYZE.base);
      assert.equal(calls[0].settings.temperature, 0);
      assert.equal(calls[0].settings.maxOutputTokens, 1024);
      // The packaged instruction set — not the legacy hard-coded prompt — was sent.
      assert.equal(
        calls[0].system,
        deployment.fx.packages.ANALYZE.parsed.instructions,
        'the system message is the verified package instruction set',
      );
      assert.ok(!calls[0].user.includes('tickSize'), 'no instrument data reaches the model');
    } finally {
      deployment.cleanup();
    }
  });

  test('a structural package fault returns ACTIVATION_PAUSED and makes no model call', async () => {
    const deployment = deployV2({ revokeOperation: 'ANALYZE' });
    try {
      const calls = [];
      const core = coreComposition(deployment, { transport: scriptedTransport(calls) });
      const started = core.start();
      assert.equal(started.inferenceEnabled, true);

      const outcome = await core.analyze(aiContext());
      assert.equal(outcome.ok, false, 'a structural refusal is never a usable analysis');
      assert.equal(outcome.code, 'ACTIVATION_PAUSED');
      assert.equal(outcome.cause, 'SKILL_REVOKED');
      assert.equal(outcome.retryable, false);
      assert.equal(outcome.operation, 'ANALYZE');
      assert.equal(typeof outcome.requestId, 'string');
      assert.equal(calls.length, 0, 'zero model calls after a structural refusal');

      // The refusal closed participant admission: every later call answers with
      // the same public code and safe cause, never a plain provider error.
      assert.equal(core.guard.status().inferenceEnabled, false);
      const second = await core.analyze(aiContext());
      assert.equal(second.ok, false);
      assert.equal(second.code, 'ACTIVATION_PAUSED');
      assert.equal(second.cause, 'SKILL_REVOKED');
      assert.equal(calls.length, 0);
    } finally {
      deployment.cleanup();
    }
  });

  test('an ordinary output failure stays a PROVIDER_ERROR without latching admission', async () => {
    const deployment = deployV2();
    try {
      const calls = [];
      const core = coreComposition(deployment, {
        transport: scriptedTransport(calls, { fail: () => '{"bias":"BULLISH","confidence":3,"rationale":"x"}' }),
      });
      core.start();
      const outcome = await core.analyze(aiContext());
      assert.equal(outcome.status, AI_STATUS.PROVIDER_ERROR);
      assert.deepEqual(outcome.issues, ['SKILL_OUTPUT_INVALID']);
      assert.equal(outcome.analysis, null);
      assert.equal(calls.length, 1);
      assert.equal(core.guard.status().inferenceEnabled, true);
    } finally {
      deployment.cleanup();
    }
  });
});

describe('Telegram participant runs all five operations through their packages (AC-01, AC-03)', () => {
  test('each operation uses its dedicated package and model identity', async () => {
    const deployment = deployV2();
    try {
      const calls = [];
      const composition = telegramComposition(deployment, { transport: scriptedTransport(calls) });
      const status = composition.start();
      assert.equal(status.inferenceEnabled, true, status.errorCode ?? 'admitted');
      const client = composition.getChatClient();
      assert.equal(client.operationMode, 'v2');

      const scout = await client.generateIdeas(SAMPLE_INPUTS.SCOUT);
      const guard = await client.filterIdea(SAMPLE_INPUTS.GUARD.idea, {
        symbol: SAMPLE_INPUTS.GUARD.market,
        btc: SAMPLE_INPUTS.GUARD.btc,
      }, { news: SAMPLE_INPUTS.GUARD.news, sentiment: null });
      const monitor = await client.monitor(SAMPLE_INPUTS.MONITOR);
      const stopcheck = await client.stopcheck(SAMPLE_INPUTS.STOPCHECK);
      const reflect = await client.reflect({ ...SAMPLE_INPUTS.REFLECT.trade, existingRules: SAMPLE_INPUTS.REFLECT.existingRules });

      assert.equal(scout.parsed.ok, true, JSON.stringify(scout.parsed));
      assert.equal(scout.parsed.ideas.length, 1);
      assert.equal(guard.parsed.ok, true, JSON.stringify(guard.parsed));
      assert.equal(guard.parsed.value.verdict, 'APPROVED');
      assert.equal(monitor.parsed.ok, true, JSON.stringify(monitor.parsed));
      assert.equal(monitor.parsed.value.action, 'HOLD');
      assert.equal(stopcheck.parsed.ok, true, JSON.stringify(stopcheck.parsed));
      assert.equal(stopcheck.parsed.value.action, 'HOLD');
      assert.equal(reflect.parsed.ok, true, JSON.stringify(reflect.parsed));
      assert.equal(reflect.parsed.value.severity, 'low');

      // Five operations, five calls, five distinct model identities — and each
      // request carries its own operation package instructions.
      assert.equal(calls.length, 5);
      const models = calls.map((call) => call.identity.modelId);
      assert.equal(new Set(models).size, 5, 'every operation dispatches its own model identity');
      for (const operation of ['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT']) {
        const call = calls.find((candidate) => candidate.identity.modelId === MODELS[operation].modelId);
        assert.ok(call, `${operation} must dispatch its planned model`);
        assert.equal(
          call.system,
          deployment.fx.packages[operation].parsed.instructions,
          `${operation} must send its own verified package instructions`,
        );
      }

      // The composition-level REFLECT wrapper unwraps the typed result.
      const reflection = await composition.reflect({
        ...SAMPLE_INPUTS.REFLECT.trade,
        existingRules: null,
        holdMinutes: 10,
        mfeUsd: 0,
      });
      assert.equal(reflection.severity, 'low');
    } finally {
      deployment.cleanup();
    }
  });

  test('a structural fault returns ACTIVATION_PAUSED from every operation with zero calls', async () => {
    const deployment = deployV2({ revokeOperation: 'REFLECT' });
    try {
      for (const operation of ['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT']) {
        const calls = [];
        const composition = telegramComposition(deployment, {
          transport: scriptedTransport(calls),
          instanceId: 'inst-telegram',
        });
        const started = composition.start();
        assert.equal(started.inferenceEnabled, true, `${operation}: ${started.errorCode ?? 'admitted'}`);
        const client = composition.getChatClient();

        const result = await invokeOperation(client, operation);
        assert.equal(result.ok, false, `${operation} must refuse after a structural fault`);
        assert.equal(result.code, 'ACTIVATION_PAUSED', operation);
        assert.equal(result.cause, 'SKILL_REVOKED', operation);
        assert.equal(result.retryable, false, operation);
        assert.equal(calls.length, 0, `${operation} must make zero model calls`);
        assert.equal(composition.status().inferenceEnabled, false, `${operation} closes participant admission`);
        // Every later admission reports the public code with the safe cause in
        // diagnostic metadata.
        assert.throws(
          () => composition.getChatClient(),
          (error) => error.code === 'ACTIVATION_PAUSED' && error.details?.cause === 'SKILL_REVOKED',
        );
      }
    } finally {
      deployment.cleanup();
    }
  });

  test('a refusal taints the joined workflow so no derived effect can dispatch', async () => {
    const deployment = deployV2({ revokeOperation: 'REFLECT' });
    try {
      const composition = telegramComposition(deployment, { transport: scriptedTransport([]) });
      composition.start();
      const client = composition.getChatClient();
      let effectCalls = 0;
      await composition.runInWorkflow('MONITOR', async () => {
        const result = await client.monitor(SAMPLE_INPUTS.MONITOR);
        assert.equal(result.code, 'ACTIVATION_PAUSED');
        await assert.rejects(
          composition.runEffect(async () => {
            effectCalls += 1;
          }),
          (error) => error.code === 'ACTIVATION_PAUSED',
        );
      });
      assert.equal(effectCalls, 0, 'a tainted workflow may not dispatch an effect');
    } finally {
      deployment.cleanup();
    }
  });

  test('prompt-based completion entry points are offline-only in v2', async () => {
    const deployment = deployV2();
    try {
      const composition = telegramComposition(deployment, { transport: scriptedTransport([]) });
      composition.start();
      const client = composition.getChatClient();
      assert.throws(() => client._completeGuard({ system: 's', user: 'u' }), /offline-only/);
      assert.throws(() => client.completeMonitor({ system: 's', user: 'u' }), /offline-only/);
      assert.throws(() => client.completeStopcheck({ system: 's', user: 'u' }), /offline-only/);
    } finally {
      deployment.cleanup();
    }
  });
});

/**
 * Call one production operation boundary with a valid host input.
 *
 * @param {any} client
 * @param {string} operation
 */
function invokeOperation(client, operation) {
  switch (operation) {
    case 'SCOUT':
      return client.generateIdeas(SAMPLE_INPUTS.SCOUT);
    case 'GUARD':
      return client.filterIdea(SAMPLE_INPUTS.GUARD.idea, {
        symbol: SAMPLE_INPUTS.GUARD.market,
        btc: SAMPLE_INPUTS.GUARD.btc,
      }, { news: SAMPLE_INPUTS.GUARD.news, sentiment: null });
    case 'MONITOR':
      return client.monitor(SAMPLE_INPUTS.MONITOR);
    case 'STOPCHECK':
      return client.stopcheck(SAMPLE_INPUTS.STOPCHECK);
    case 'REFLECT':
      return client.reflect({ ...SAMPLE_INPUTS.REFLECT.trade, existingRules: SAMPLE_INPUTS.REFLECT.existingRules });
    default:
      throw new Error(`unknown operation ${operation}`);
  }
}

describe('Control-store schema migration is fenced (AC-15)', () => {
  test('only a paused v1 record migrates, it lands PAUSED/unbound and keeps a backup', () => {
    const controlDir = fs.mkdtempSync(`${process.env.TMPDIR ?? '/tmp'}/skill-migrate-`);
    try {
      const store = makeStore(controlDir);
      const { record } = store.initialize({ inventory: [
        { slot: 'core-analysis', operations: ['ANALYZE'], enabled: true },
        { slot: 'telegram', operations: ['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT'], enabled: true },
      ] });
      const migrated = buildMigratedRecord(record, { operatorApprovalId: 'operator-migration-1' });
      const result = store.migrateRecord({
        record: migrated,
        expectedRevision: record.revision,
        operatorApprovalId: 'operator-migration-1',
      });
      assert.equal(result.record.schemaVersion, 2);
      assert.equal(result.record.phase, 'PAUSED');
      assert.equal(result.record.active, null);
      assert.equal(result.record.target, null);
      assert.equal(result.record.generation, record.generation);
      assert.equal(result.record.highWaterGeneration, record.highWaterGeneration);
      assert.match(result.backupSha256, /^[0-9a-f]{64}$/);
      // The forensic backup is the exact pre-migration record.
      const backups = fs.readdirSync(`${controlDir}/migrations`);
      assert.equal(backups.length, 1);

      // A second conversion of an already-v2 record is refused.
      const again = buildMigratedRecord(record, { operatorApprovalId: 'operator-2' });
      assert.throws(
        () => store.migrateRecord({ record: again, expectedRevision: result.record.revision, operatorApprovalId: 'operator-2' }),
        /schemaVersion 1/,
      );
      // And a non-paused/active record is refused before anything is written.
      assert.throws(
        () => buildMigratedRecord({ ...record, phase: 'ACTIVE' }, { operatorApprovalId: 'op' }),
        /not migratable/,
      );
    } finally {
      fs.rmSync(controlDir, { recursive: true, force: true });
    }
  });
});

describe('Mixed-version execution is refused in both directions (AC-15)', () => {
  test('the reviewed mode is never inferred', () => {
    assert.throws(() => resolveSkillRuntimeMode({ configuredMode: 'auto', binding: { schemaVersion: 1 } }), /never inferred/);
    assert.deepEqual(
      resolveSkillRuntimeMode({ configuredMode: 'v2', binding: { schemaVersion: 2 } }),
      { mode: 'v2', cause: null },
    );
    assert.deepEqual(
      resolveSkillRuntimeMode({ configuredMode: 'legacy', binding: { schemaVersion: 1 } }),
      { mode: 'legacy', cause: null },
    );
  });

  test('v2 mode with a v1 generation refuses every operation', async () => {
    const fixture = buildReleaseFixture();
    try {
      const dispatch = createProductionDispatch({
        configuredMode: 'v2',
        binding: fixture.binding,
        controlStore: fixture.store,
        artifact: {
          artifactSha256: sha256Hex('artifact'),
          botVersion: '0.1.0',
          skillApiVersion: 1,
          adapterCatalogueSha256: sha256Hex('adapter-catalogue'),
          hostContractCatalogueSha256: sha256Hex('host-contract-catalogue'),
        },
        transport: scriptedTransport([]),
      });
      assert.equal(dispatch.refusing, true);
      assert.equal(dispatch.cause, 'SKILL_REGISTRY_INVALID');
      const result = await dispatch.composition.SCOUT(SAMPLE_INPUTS.SCOUT, { workToken: 'w' });
      assert.equal(result.code, 'ACTIVATION_PAUSED');
      assert.equal(result.cause, 'SKILL_REGISTRY_INVALID');
    } finally {
      fs.rmSync(fixture.controlDir, { recursive: true, force: true });
    }
  });

  test('legacy mode with a v2-bound generation refuses instead of using prompts', async () => {
    const deployment = deployV2();
    try {
      const dispatch = createProductionDispatch({
        configuredMode: 'legacy',
        binding: deployment.binding,
        controlStore: deployment.fixture.store,
        artifact: deployment.fx.artifact,
        transport: scriptedTransport([]),
      });
      assert.equal(dispatch.mode, 'legacy');
      assert.equal(dispatch.refusing, true);
      assert.equal(dispatch.cause, 'SKILL_INCOMPATIBLE');
      const result = await dispatch.composition.ANALYZE(SAMPLE_INPUTS.ANALYZE, { workToken: 'w' });
      assert.equal(result.code, 'ACTIVATION_PAUSED');
      assert.equal(result.cause, 'SKILL_INCOMPATIBLE');
    } finally {
      deployment.cleanup();
    }
  });

  test('a plan that does not reproduce the bound digest is refused', async () => {
    const deployment = deployV2();
    try {
      const wrong = { ...deployment.binding, executionPlanSha256: sha256Hex('another-plan') };
      const dispatch = createProductionDispatch({
        configuredMode: 'v2',
        binding: wrong,
        controlDir: deployment.fixture.controlDir,
        controlStore: deployment.fixture.store,
        artifact: deployment.fx.artifact,
        transport: scriptedTransport([]),
      });
      assert.equal(dispatch.refusing, true);
      assert.ok(['SKILL_MISSING', 'SKILL_INTEGRITY_MISMATCH'].includes(dispatch.cause), dispatch.cause);
    } finally {
      deployment.cleanup();
    }
  });
});
