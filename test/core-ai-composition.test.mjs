/**
 * UAI-06A — core composition and the AI-disabled bootstrap observer.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  CORE_AI_CALL_SITE_INVENTORY,
  createCoreAIComposition,
  createDefaultCoreProviderFactory,
  observeCoreIdentity,
} from '../src/ai/core-ai-composition.mjs';
import { AI_STATUS } from '../src/ai/interface.mjs';
import { COORDINATION_ERROR_CODE } from '../src/errors/coordination-error.mjs';
import { createControlStore } from '../src/ai/coordination/control-store.mjs';
import { buildAlternateDescriptor, buildReleaseFixture, activateFixture, guardConfigFor } from './fixtures/ai-release/factory.mjs';

const ANALYSIS_CONTENT = JSON.stringify({ bias: 'BULLISH', confidence: 0.7, rationale: 'trend' });

/** @param {any[]} sink */
function fakeFetch(sink) {
  return async (url, init) => {
    sink.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: ANALYSIS_CONTENT } }], usage: {} }),
    };
  };
}

const CONTEXT = {
  schemaVersion: '1',
  generatedAt: 1_700_000_000_000,
  market: { symbol: 'BTCUSDT' },
  position: null,
  portfolio: null,
  strategy: null,
  risk: null,
};

/**
 * @param {any} fixture
 * @param {{ fetchImpl?: Function, invoke?: Function, apiKeyLoader?: Function, config?: object }} [options]
 */
function composition(fixture, options = {}) {
  const config = options.config ?? guardConfigFor(fixture, 'core-analysis');
  return createCoreAIComposition({
    config,
    controlStore: fixture.store,
    artifactIdentity: { artifactSha256: config.artifactSha256 },
    transportDependencies: {
      fetchImpl: options.fetchImpl,
      invoke: options.invoke,
      apiKeyLoader: options.apiKeyLoader ?? (() => 'fake-key-not-a-secret'),
    },
    instanceId: 'inst-core-1',
  });
}

test('UAI-06A core: an ACTIVE deployment produces an unchanged AIAnalysisOutcome', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const requests = [];
  const core = composition(fixture, { fetchImpl: fakeFetch(requests) });
  const status = core.start();
  assert.equal(status.identityReady, true);
  assert.equal(status.inferenceEnabled, true);

  const outcome = await core.analyze(CONTEXT);
  assert.equal(outcome.status, AI_STATUS.OK);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.analysis.bias, 'BULLISH');
  assert.equal(outcome.modelId, 'deepseek-chat');
  // The public shape is untouched: no provenance fields leaked into it.
  assert.deepEqual(Object.keys(outcome).sort(), [
    'analysis', 'issues', 'modelId', 'ok', 'promptVersion', 'receivedAt', 'status',
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(requests[0].body.model, 'deepseek-chat');
  assert.equal(requests[0].body.temperature, 0);
  assert.equal(requests[0].body.stream, false);
  assert.equal(requests[0].body.response_format.type, 'json_object');
  assert.ok(!JSON.stringify(requests[0].body).includes('fake-key-not-a-secret'));
});

test('UAI-06A core: the bootstrap observer makes no provider request and needs no key', () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const requests = [];
  const globalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    return globalFetch(...args);
  };
  try {
    const report = observeCoreIdentity({
      env: {
        AI_RUNTIME_MODE: 'single',
        AI_CONTROL_DIR: fixture.controlDir,
        AI_DEPLOYMENT_ID: fixture.store.readRecord().deploymentId,
        AI_EXPECTED_MANIFEST_VERSION: fixture.manifest.manifestVersion,
        AI_EXPECTED_MANIFEST_SHA256: fixture.manifestSha256,
      },
    });
    assert.equal(report.mode, 'single');
    assert.equal(report.identityValidated, true);
    assert.equal(report.inferenceEnabled, false);
    assert.equal(report.manifestVersion, 'release-1');
    assert.equal(fetchCalls, 0);
    assert.equal(requests.length, 0);
  } finally {
    globalThis.fetch = globalFetch;
  }
});

test('UAI-06A core: legacy mode is inert for the observer', () => {
  const report = observeCoreIdentity({ env: {} });
  assert.deepEqual(report, { mode: 'legacy', identityValidated: false, inferenceEnabled: false, errorCode: null });
});

test('UAI-06A core: a missing or corrupt store is reported without throwing or inferring', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'ai-core-'));
  const env = {
    AI_RUNTIME_MODE: 'single',
    AI_CONTROL_DIR: dir,
    AI_DEPLOYMENT_ID: '11111111-1111-4111-8111-111111111111',
    AI_EXPECTED_MANIFEST_VERSION: 'release-1',
    AI_EXPECTED_MANIFEST_SHA256: 'a'.repeat(64),
  };
  const missing = observeCoreIdentity({ env });
  assert.equal(missing.identityValidated, false);
  assert.equal(missing.errorCode, COORDINATION_ERROR_CODE.STORE_UNAVAILABLE);

  fs.writeFileSync(path.join(dir, 'control.json'), '{"schemaVersion":1}');
  const corrupt = observeCoreIdentity({ env });
  assert.equal(corrupt.identityValidated, false);
  assert.equal(corrupt.errorCode, COORDINATION_ERROR_CODE.STORE_CORRUPT);

  fs.writeFileSync(path.join(dir, 'control.json'), '{"schemaVersion":1,"deploymentId":');
  const torn = observeCoreIdentity({ env });
  assert.equal(torn.identityValidated, false);
  assert.equal(torn.errorCode, COORDINATION_ERROR_CODE.STORE_CORRUPT);
});

test('UAI-06A core: a disabled core-analysis slot cannot be registered or infer', async () => {
  const fixture = buildReleaseFixture();
  const first = activateFixture(fixture);
  const target = buildAlternateDescriptor({
    fixture,
    manifestVersion: 'release-2',
    inventory: [
      { slot: 'core-analysis', operations: ['ANALYZE'], enabled: false },
      { slot: 'telegram', operations: ['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT'], enabled: true },
    ],
  });
  // Advance the store directly (fencing the core instance) to an ACTIVE record
  // that disables the core slot.
  const { advanceBarrier, buildTestGuard } = await import('./fixtures/ai-release/factory.mjs');
  const tg = buildTestGuard(fixture, { slot: 'telegram', instanceId: 'inst-tg-1' });
  assert.equal(tg.start().identityReady, true);
  advanceBarrier(fixture, {
    descriptor: target.descriptor,
    participants: [{ guard: tg, slot: 'telegram', instanceId: 'inst-tg-1' }],
    fence: ['core-analysis'],
  });

  const requests = [];
  const config = {
    ...guardConfigFor(fixture, 'core-analysis'),
    expectedManifestVersion: 'release-2',
    expectedManifestSha256: target.manifestSha256,
  };
  const core = composition(fixture, { fetchImpl: fakeFetch(requests), config });
  const status = core.start();
  assert.equal(status.identityReady, false);
  assert.equal(status.inferenceEnabled, false);
  assert.equal(status.errorCode, COORDINATION_ERROR_CODE.SLOT_DISABLED);
  const outcome = await core.analyze(CONTEXT);
  assert.equal(outcome.status, AI_STATUS.PROVIDER_ERROR);
  assert.ok(outcome.issues.includes(COORDINATION_ERROR_CODE.SLOT_DISABLED));
  assert.equal(requests.length, 0);
  assert.ok(first.record.phase === 'ACTIVE');
});

test('UAI-06A core: a stale expected hash fails before any provider use', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const requests = [];
  const core = composition(fixture, {
    fetchImpl: fakeFetch(requests),
    config: { ...guardConfigFor(fixture, 'core-analysis'), expectedManifestSha256: 'e'.repeat(64) },
  });
  const status = core.start();
  assert.equal(status.identityReady, false);
  assert.equal(status.errorCode, COORDINATION_ERROR_CODE.MANIFEST_STALE);
  const outcome = await core.analyze(CONTEXT);
  assert.equal(outcome.status, AI_STATUS.PROVIDER_ERROR);
  assert.equal(requests.length, 0);
});

test('UAI-06A core: work outlives result production until the consumer settles it', async () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const core = composition(fixture, { fetchImpl: fakeFetch([]) });
  core.start();
  const held = await core.analyzeWithProvenance(CONTEXT);
  assert.equal(held.outcome.ok, true);
  assert.equal(core.guard.status().outstandingWork, 1, 'the token is still counted');
  assert.equal(held.provenance.manifestVersion, 'release-1');
  assert.equal(held.provenance.generation, 1);

  // A transition cannot complete while the consumer still holds the result.
  fixture.store.transact(
    { action: 'quiesce', descriptor: fixture.descriptor, transitionId: 'ab121212-1212-4212-8212-121212121212' },
    { expectedRevision: fixture.store.readRecord().revision },
  );
  core.poll();
  assert.throws(() => core.acknowledgeQuiesced(), /outstanding AI work/);
  held.settle();
  assert.equal(core.guard.status().outstandingWork, 0);
  assert.equal(core.acknowledgeQuiesced().ack.status, 'QUIESCED');
});

test('UAI-06A core: a missing secret fails closed instead of silently skipping inference', () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const core = composition(fixture, {
    apiKeyLoader: () => {
      throw new Error('no key');
    },
  });
  const status = core.start();
  assert.equal(status.inferenceEnabled, false);
  assert.equal(status.errorCode, COORDINATION_ERROR_CODE.MISSING_SECRET);
});

test('UAI-06A core: an unsupported provider or capability profile fails closed', () => {
  const manifest = { providerId: 'kimi', modelId: 'kimi-k3', canonicalBaseUrl: 'https://api.moonshot.cn/v1' };
  const profile = { operations: { ANALYZE: { temperature: 0, reasoningEffort: null, maxOutputTokens: null, stream: false, responseFormat: 'json_object', timeoutMs: 1000 } } };
  assert.throws(
    () => createDefaultCoreProviderFactory({ manifest, profile, apiKey: 'x' }),
    (error) => error.code === COORDINATION_ERROR_CODE.UNSUPPORTED_PROVIDER,
  );
  const deepseek = { providerId: 'deepseek', modelId: 'deepseek-chat', canonicalBaseUrl: 'https://api.deepseek.com/v1' };
  const badProfile = { operations: { ANALYZE: { ...profile.operations.ANALYZE, temperature: 0.7 } } };
  assert.throws(
    () => createDefaultCoreProviderFactory({ manifest: deepseek, profile: badProfile, apiKey: 'x' }),
    (error) => error.code === COORDINATION_ERROR_CODE.CONFIGURATION_ERROR,
  );
});

test('UAI-06A core: the provider call-site inventory covers every construction site', () => {
  const root = path.resolve(import.meta.dirname, '..', 'src');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.mjs')) files.push(full);
    }
  };
  walk(root);
  const constructions = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.resolve(import.meta.dirname, '..'), file);
    if (/createDeepSeekProvider\s*\(/.test(text) || /createDeepSeekChat\s*\(/.test(text) || /createReflector\s*\(/.test(text)) {
      constructions.push(rel);
    }
  }
  const inventoried = new Set(CORE_AI_CALL_SITE_INVENTORY.map((entry) => entry.file));
  for (const rel of constructions) {
    assert.ok(
      inventoried.has(rel),
      `${rel} constructs a provider/chat client but is missing from CORE_AI_CALL_SITE_INVENTORY`,
    );
  }
  // Every production-guarded entry is a real file.
  for (const entry of CORE_AI_CALL_SITE_INVENTORY) {
    assert.ok(fs.existsSync(path.resolve(import.meta.dirname, '..', entry.file)), `${entry.file} does not exist`);
  }
  // The core bootstrap itself constructs nothing.
  const indexSource = fs.readFileSync(path.join(root, 'index.mjs'), 'utf8');
  assert.ok(!indexSource.includes('createDeepSeekProvider('));
  assert.ok(!indexSource.includes('createDeepSeekChat('));
});

test('UAI-06A core: the observer seam produces a receipt-shaped validation without side effects', () => {
  const fixture = buildReleaseFixture();
  activateFixture(fixture);
  const core = composition(fixture, { fetchImpl: fakeFetch([]) });
  const validation = core.createObserverValidation({ observerId: 'core-bootstrap' });
  assert.equal(validation.identityValidated, true);
  assert.equal(validation.inferenceEnabled, false);
  // The control record was not mutated by a read-only validation.
  const before = fixture.store.readRecord().revision;
  core.createObserverValidation({ observerId: 'core-bootstrap' });
  assert.equal(fixture.store.readRecord().revision, before);
  assert.equal(createControlStore({ controlDir: fixture.controlDir }).readLockOwner(), null);
});
