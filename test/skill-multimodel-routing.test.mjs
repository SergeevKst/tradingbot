/**
 * SKILL-01 / AC-03 — six distinct operation routes, end to end.
 *
 * These tests pin the *observed* transport identity, not the resolver output:
 * the wire request (endpoint, model, settings) must equal the identity the
 * registry selected for that operation, and a registry that cannot resolve an
 * operation must fail closed instead of falling back to the manifest model.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { createCoreAIComposition } from '../src/ai/core-ai-composition.mjs';
import { createTelegramAIComposition } from '../src/telegram/ai-composition.mjs';
import { createDeepSeekChat } from '../src/telegram/deepseek-client.mjs';
import { validateModelRegistry } from '../src/config/ai-model-registry.mjs';
import { createCapabilityProfile } from '../src/ai/operation-profiles.mjs';
import { AI_STATUS } from '../src/ai/interface.mjs';
import { digestJson } from '../src/config/jcs.mjs';
import fs from 'node:fs';
import { activateFixture, buildReleaseFixture, guardConfigFor } from './fixtures/ai-release/factory.mjs';

/**
 * Remove a release fixture's temporary control directory. The fixture factory
 * owns the temp dir and does not expose a disposer.
 *
 * @param {{ controlDir: string }} fixture
 */
function cleanupFixture(fixture) {
  fs.rmSync(fixture.controlDir, { recursive: true, force: true });
}

const ANALYSIS_CONTENT = JSON.stringify({ bias: 'BULLISH', confidence: 0.7, rationale: 'trend' });

const CONTEXT = {
  schemaVersion: '1',
  generatedAt: 1_700_000_000_000,
  market: { symbol: 'BTCUSDT' },
  position: null,
  portfolio: null,
  strategy: null,
  risk: null,
};

/** A registry that routes ANALYZE and the five Telegram operations to distinct models. */
function buildRegistry() {
  const profile = createCapabilityProfile({
    profileId: 'shared-profile',
    providerId: 'deepseek',
    operations: {
      ANALYZE: { temperature: 0, reasoningEffort: null, maxOutputTokens: 1024, stream: false, responseFormat: 'json_object', timeoutMs: 20000 },
      SCOUT: { temperature: 0.7, reasoningEffort: null, maxOutputTokens: 2048, stream: false, responseFormat: 'json_object', timeoutMs: 60000 },
      GUARD: { temperature: 0, reasoningEffort: 'low', maxOutputTokens: 1024, stream: false, responseFormat: 'json_object', timeoutMs: 60000 },
      MONITOR: { temperature: 0, reasoningEffort: 'low', maxOutputTokens: 512, stream: false, responseFormat: 'json_object', timeoutMs: 60000 },
      STOPCHECK: { temperature: 0, reasoningEffort: 'low', maxOutputTokens: 512, stream: false, responseFormat: 'json_object', timeoutMs: 60000 },
      REFLECT: { temperature: 0, reasoningEffort: null, maxOutputTokens: 1024, stream: false, responseFormat: 'json_object', timeoutMs: 60000 },
    },
  });
  const profileSha = digestJson(profile, { label: 'profile' });
  const models = {
    'analyze-gpt': { providerId: 'deepseek', modelId: 'deepseek-reasoner', canonicalBaseUrl: 'https://api.deepseek.com/v1', capabilityProfileId: 'shared-profile', capabilityProfileSha256: profileSha, trustTier: 'consequential' },
    'scout-chat': { providerId: 'deepseek', modelId: 'deepseek-chat', canonicalBaseUrl: 'https://api.deepseek.com/v1', capabilityProfileId: 'shared-profile', capabilityProfileSha256: profileSha, trustTier: 'supplementary' },
    'guard-kimi': { providerId: 'kimi', modelId: 'kimi-k3-guard', canonicalBaseUrl: 'https://api.moonshot.cn/v1', capabilityProfileId: 'shared-profile', capabilityProfileSha256: profileSha, trustTier: 'consequential' },
    'monitor-kimi': { providerId: 'kimi', modelId: 'kimi-k3-monitor', canonicalBaseUrl: 'https://api.moonshot.cn/v1', capabilityProfileId: 'shared-profile', capabilityProfileSha256: profileSha, trustTier: 'supplementary' },
    'stopcheck-kimi': { providerId: 'kimi', modelId: 'kimi-k3-stopcheck', canonicalBaseUrl: 'https://api.moonshot.cn/v1', capabilityProfileId: 'shared-profile', capabilityProfileSha256: profileSha, trustTier: 'consequential' },
    'reflect-chat': { providerId: 'deepseek', modelId: 'deepseek-chat-reflect', canonicalBaseUrl: 'https://api.deepseek.com/v1', capabilityProfileId: 'shared-profile', capabilityProfileSha256: profileSha, trustTier: 'informational' },
  };
  const routingTable = {
    ANALYZE: 'analyze-gpt',
    SCOUT: 'scout-chat',
    GUARD: 'guard-kimi',
    MONITOR: 'monitor-kimi',
    STOPCHECK: 'stopcheck-kimi',
    REFLECT: 'reflect-chat',
  };
  const fallbacks = Object.fromEntries(Object.keys(routingTable).map((operation) => [operation, null]));
  return validateModelRegistry({ schemaVersion: 1, registryId: 'routing-fixture', models, routingTable, fallbacks });
}

describe('Core ANALYZE routing (AC-03)', () => {
  test('the wire request uses the registry-selected model and endpoint', async () => {
    const fixture = buildReleaseFixture();
    activateFixture(fixture);
    /** @type {any[]} */
    const requests = [];
    const core = createCoreAIComposition({
      config: guardConfigFor(fixture, 'core-analysis'),
      controlStore: fixture.store,
      artifactIdentity: { artifactSha256: guardConfigFor(fixture, 'core-analysis').artifactSha256 },
      transportDependencies: {
        apiKeyLoader: () => 'fake-key-not-a-secret',
        fetchImpl: async (url, init) => {
          requests.push({ url, body: JSON.parse(init.body) });
          return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: ANALYSIS_CONTENT } }], usage: {} }) };
        },
      },
      registry: buildRegistry(),
      instanceId: 'inst-core-1',
    });
    try {
      assert.equal(core.start().inferenceEnabled, true);
      const outcome = await core.analyze(CONTEXT);
      assert.equal(outcome.status, AI_STATUS.OK, 'routed ANALYZE must still produce an analysis');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, 'https://api.deepseek.com/v1/chat/completions');
      assert.equal(requests[0].body.model, 'deepseek-reasoner');
      assert.equal(outcome.modelId, 'deepseek-reasoner');
    } finally {
      cleanupFixture(fixture);
    }
  });

  test('a registry that cannot resolve ANALYZE fails closed instead of using the manifest model', async () => {
    const fixture = buildReleaseFixture();
    activateFixture(fixture);
    /** @type {any[]} */
    const requests = [];
    const broken = buildRegistry();
    const core = createCoreAIComposition({
      config: guardConfigFor(fixture, 'core-analysis'),
      controlStore: fixture.store,
      artifactIdentity: { artifactSha256: guardConfigFor(fixture, 'core-analysis').artifactSha256 },
      transportDependencies: {
        apiKeyLoader: () => 'fake-key-not-a-secret',
        fetchImpl: async (url, init) => {
          requests.push({ url, body: JSON.parse(init.body) });
          return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: ANALYSIS_CONTENT } }], usage: {} }) };
        },
      },
      registry: { ...broken, routingTable: { ...broken.routingTable, ANALYZE: 'missing-route' } },
      instanceId: 'inst-core-1',
    });
    try {
      core.start();
      const outcome = await core.analyze(CONTEXT);
      assert.notEqual(outcome.status, AI_STATUS.OK);
      assert.equal(requests.length, 0, 'no unreviewed fallback dispatch is allowed');
    } finally {
      cleanupFixture(fixture);
    }
  });
});

describe('Telegram per-operation routing (AC-03)', () => {
  /**
   * @param {any} fixture
   * @param {{ registry?: any, calls: any[] }} options
   */
  function telegram(fixture, options) {
    const config = guardConfigFor(fixture, 'telegram');
    return createTelegramAIComposition({
      config,
      controlStore: fixture.store,
      artifactIdentity: { artifactSha256: config.artifactSha256 },
      transportDependencies: {
        apiKeyLoader: () => 'fake-key-not-a-secret',
        createChatClient: (clientOptions) => {
          options.calls.push({ kind: 'client-options', clientOptions });
          return {
            getCacheStats: () => ({ hits: 0, misses: 0, zeroHitCalls: 0, calls: 0, hitRatio: 0 }),
            generateIdeas: async () => ({ prompt: {}, parsed: { ok: true, ideas: [], issues: [] }, raw: '{}' }),
            filterIdea: async () => ({ prompt: {}, parsed: { ok: true, value: { approved: true } }, raw: '{}' }),
            _completeGuard: async () => '{"verdict":"HOLD"}',
            _completeOperation: async (operation) => {
              options.calls.push({ kind: 'per-operation', operation });
              return '{"action":"HOLD","reason":"x","confidence":0.5}';
            },
          };
        },
        createReflector: () => ({
          reflect: async () => '{"lesson":"x","proposedRule":"","severity":"low","matchedExistingRule":false}',
        }),
      },
      registry: options.registry,
      instanceId: 'inst-tg-1',
    });
  }

  test('each operation is dispatched through its own resolved role', async () => {
    const fixture = buildReleaseFixture();
    activateFixture(fixture);
    const calls = [];
    const registry = buildRegistry();
    const composition = telegram(fixture, { registry, calls });
    try {
      assert.equal(composition.start().identityReady, true);
      const client = composition.getChatClient();

      const clientOptions = calls.find((call) => call.kind === 'client-options').clientOptions;
      assert.ok(clientOptions.operationRoles, 'per-operation roles are passed to the transport factory');
      assert.equal(clientOptions.operationRoles.MONITOR.model, 'kimi-k3-monitor');
      assert.equal(clientOptions.operationRoles.STOPCHECK.model, 'kimi-k3-stopcheck');
      assert.equal(clientOptions.operationRoles.GUARD.model, 'kimi-k3-guard');
      assert.equal(clientOptions.operationRoles.REFLECT.model, 'deepseek-chat-reflect');
      assert.equal(clientOptions.operationRoles.SCOUT.model, 'deepseek-chat');
      assert.equal(clientOptions.operationRoles.MONITOR.baseUrl, 'https://api.moonshot.cn');
      assert.equal(clientOptions.operationRoles.REFLECT.baseUrl, 'https://api.deepseek.com');

      await client.completeMonitor({ system: 's', user: 'u' });
      await client.completeStopcheck({ system: 's', user: 'u' });
      const dispatched = calls.filter((call) => call.kind === 'per-operation').map((call) => call.operation);
      assert.deepEqual(dispatched, ['MONITOR', 'STOPCHECK'], 'monitor and stop-check are not routed through GUARD');
    } finally {
      cleanupFixture(fixture);
    }
  });

  test('a registry missing an operation route fails construction instead of silently using the manifest', () => {
    const fixture = buildReleaseFixture();
    const calls = [];
    const registry = buildRegistry();
    try {
      const partial = {
        ...registry,
        routingTable: Object.fromEntries(Object.entries(registry.routingTable).filter(([operation]) => operation !== 'STOPCHECK')),
      };
      assert.throws(() => telegram(fixture, { registry: partial, calls }), (error) => typeof error.code === 'string');
    } finally {
      cleanupFixture(fixture);
    }
  });
});

describe('Chat client honours the resolved operation identity (AC-03)', () => {
  /** @param {any[]} sink */
  function fakeFetch(sink) {
    return async (url, init) => {
      sink.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"action":"HOLD"}' } }], usage: {} }) };
    };
  }

  test('_completeOperation sends the operation model, endpoint and temperature exactly', async () => {
    const originalFetch = globalThis.fetch;
    const sink = [];
    globalThis.fetch = fakeFetch(sink);
    try {
      const client = createDeepSeekChat({
        apiKey: 'fake-key-not-a-secret',
        temperature: 0.7,
        timeoutMs: 1000,
        operationRoles: {
          MONITOR: { provider: 'kimi', baseUrl: 'https://api.moonshot.cn', apiKey: 'fake-key-not-a-secret', model: 'kimi-k3-monitor', reasoningEffort: 'low', temperature: 0 },
          REFLECT: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'fake-key-not-a-secret', model: 'deepseek-chat-reflect', reasoningEffort: null, temperature: 0 },
        },
      });
      await client._completeOperation('MONITOR', { system: 'SYSTEM', user: 'USER' });
      await client._completeOperation('REFLECT', { system: 'SYSTEM', user: 'USER' });

      assert.equal(sink[0].url, 'https://api.moonshot.cn/v1/chat/completions');
      assert.equal(sink[0].body.model, 'kimi-k3-monitor');
      assert.equal(sink[0].body.temperature, 0);
      assert.equal(sink[0].body.reasoning_effort, 'low');
      assert.equal(sink[1].url, 'https://api.deepseek.com/v1/chat/completions');
      assert.equal(sink[1].body.model, 'deepseek-chat-reflect');
      assert.equal(sink[1].body.temperature, 0);
      assert.equal('reasoning_effort' in sink[1].body, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('an operation without a resolved role is refused', async () => {
    const client = createDeepSeekChat({
      apiKey: 'fake-key-not-a-secret',
      temperature: 0,
      timeoutMs: 1000,
      operationRoles: {},
    });
    await assert.rejects(() => client._completeOperation('MONITOR', { system: 's', user: 'u' }), /no resolved model role/);
  });

  test('a reviewed temperature the host rejects is refused rather than silently overridden', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    };
    try {
      const client = createDeepSeekChat({
        apiKey: 'fake-key-not-a-secret',
        temperature: 0,
        timeoutMs: 1000,
        operationRoles: {
          GUARD: { provider: 'kimi', baseUrl: 'https://api.moonshot.ai', apiKey: 'fake-key-not-a-secret', model: 'kimi-k3', reasoningEffort: null, temperature: 0 },
        },
      });
      await assert.rejects(() => client._completeOperation('GUARD', { system: 's', user: 'u' }), /temperature 1/);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
