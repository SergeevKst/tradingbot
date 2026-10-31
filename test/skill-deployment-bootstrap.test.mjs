/**
 * Configuration -> credential -> transport path of a v2 deployment
 * (architecture v1.1 §3.1, §6.1, §10 Phase C; review finding 3).
 *
 * These tests start from a real `loadAIRuntimeConfig` environment, exactly as a
 * process bootstrap would, and drive the production Telegram composition with a
 * real committed v2 generation. Neither the transport nor the credential
 * resolver is injected: only the HTTP client is a stub, so the test proves the
 * reviewed environment reaches the provider transport with its provider-scoped
 * secret. A multi-provider deployment binds DeepSeek and Kimi operations, and
 * `KIMI_API_KEY` must therefore be a credential in v2 rather than a competing
 * legacy identity.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  AI_SKILL_MODE,
  CONFLICTING_IDENTITY_ENV,
  LEGACY_PROMPT_IDENTITY_ENV,
  describeAIRuntimeConfig,
  loadAIRuntimeConfig,
  loadProviderApiKey,
} from '../src/config/ai-runtime.mjs';
import { createTelegramAICompositionFromEnv } from '../src/telegram/ai-composition.mjs';
import {
  MODELS,
  SAMPLE_INPUTS,
  SAMPLE_OUTPUTS,
  chatEnvelope,
} from './fixtures/skills/factory.mjs';
import { deployV2 } from './fixtures/skills/deployment.mjs';

/** Sentinel secrets: a leak anywhere in the config or its description fails. */
const KIMI_SENTINEL = 'kimi-deployment-sentinel';
const DEEPSEEK_SENTINEL = 'deepseek-deployment-sentinel';

const OPERATION_BY_MODEL = Object.freeze({
  [MODELS.ANALYZE.modelId]: 'ANALYZE',
  [MODELS.SCOUT.modelId]: 'SCOUT',
  [MODELS.GUARD.modelId]: 'GUARD',
  [MODELS.MONITOR.modelId]: 'MONITOR',
  [MODELS.STOPCHECK.modelId]: 'STOPCHECK',
  [MODELS.REFLECT.modelId]: 'REFLECT',
});

/**
 * The environment a real v2 Telegram participant boots with.
 *
 * @param {ReturnType<typeof deployV2>} deployment
 * @param {Record<string, string | undefined>} [overrides]
 */
function deploymentEnv(deployment, overrides = {}) {
  const record = deployment.fixture.store.readRecord();
  return {
    AI_RUNTIME_MODE: 'single',
    AI_SKILL_MODE: 'v2',
    AI_CONTROL_DIR: deployment.fixture.controlDir,
    AI_DEPLOYMENT_ID: record.deploymentId,
    AI_EXPECTED_MANIFEST_VERSION: deployment.fixture.manifest.manifestVersion,
    AI_EXPECTED_MANIFEST_SHA256: deployment.fixture.manifestSha256,
    AI_PARTICIPANT_SLOT: 'telegram',
    AI_ARTIFACT_SHA256: deployment.fixture.artifactMap.telegram,
    ...overrides,
  };
}

/**
 * Boot the real production entry point from the reviewed environment
 * (`createTelegramAICompositionFromEnv` loads the config, then hands the same
 * env to the v2 credential resolver). Neither the transport nor the credential
 * resolver is supplied, so the composition constructs the real
 * OpenAI-compatible transport.
 *
 * @param {Record<string, string | undefined>} env
 * @param {any[]} calls
 */
function compositionFromEnv(env, calls) {
  const config = loadAIRuntimeConfig(env);
  const composition = createTelegramAICompositionFromEnv({
    env,
    transportDependencies: { fetchImpl: recordingFetch(calls) },
    instanceId: 'inst-telegram',
  });
  return { config, composition };
}

/**
 * The only seam left in these tests: an HTTP client that answers like an
 * OpenAI-compatible endpoint and records exactly what the transport sent.
 *
 * @param {any[]} calls
 */
function recordingFetch(calls) {
  return async function fetchImpl(url, init) {
    const body = JSON.parse(String(init.body));
    const call = {
      url: String(url),
      authorization: init.headers?.authorization ?? null,
      method: init.method,
      body,
    };
    calls.push(call);
    const operation = OPERATION_BY_MODEL[body.model];
    assert.ok(operation, `every request must carry a planned model id, saw ${body.model}`);
    const payload = chatEnvelope(SAMPLE_OUTPUTS[operation]);
    return {
      ok: true,
      status: 200,
      async text() {
        return payload;
      },
    };
  };
}

describe('v2 deployment bootstrap: reviewed mode, credentials and transport', () => {
  test('a Kimi-bound operation loads its credential from the reviewed environment', async () => {
    const deployment = deployV2();
    try {
      const env = deploymentEnv(deployment, { KIMI_API_KEY: KIMI_SENTINEL });
      const config = loadAIRuntimeConfig(env);
      assert.equal(config.mode, 'single');
      assert.equal(config.skillMode, AI_SKILL_MODE.V2);
      // The Kimi credential alone is a usable secret; no DeepSeek variable is set.
      assert.deepEqual([...config.credentialProviders], ['kimi']);
      assert.equal(config.hasApiKey, true);
      assert.equal(loadProviderApiKey('kimi', env), KIMI_SENTINEL);
      assert.equal(loadProviderApiKey('deepseek', env), null);

      const calls = [];
      const { composition } = compositionFromEnv(env, calls);
      const status = composition.start();
      assert.equal(status.inferenceEnabled, true, status.errorCode ?? 'admitted');
      const client = composition.getChatClient();

      // GUARD is bound to the Kimi model by the approved plan.
      const guard = await client.filterIdea(SAMPLE_INPUTS.GUARD.idea, {
        symbol: SAMPLE_INPUTS.GUARD.market,
        btc: SAMPLE_INPUTS.GUARD.btc,
      }, { news: SAMPLE_INPUTS.GUARD.news, sentiment: null });
      assert.equal(guard.parsed.ok, true, JSON.stringify(guard.parsed));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.moonshot.ai/v1/chat/completions');
      assert.equal(calls[0].body.model, MODELS.GUARD.modelId);
      assert.equal(calls[0].authorization, `Bearer ${KIMI_SENTINEL}`);

      // MONITOR is the second Kimi-bound operation.
      const monitor = await client.monitor(SAMPLE_INPUTS.MONITOR);
      assert.equal(monitor.parsed.ok, true, JSON.stringify(monitor.parsed));
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url, 'https://api.moonshot.ai/v1/chat/completions');
      assert.equal(calls[1].body.model, MODELS.MONITOR.modelId);
      assert.equal(calls[1].authorization, `Bearer ${KIMI_SENTINEL}`);

      // DeepSeek-bound operations still need their own provider credential: a
      // key is never reused across origins, so the run fails closed here.
      const scout = await client.generateIdeas(SAMPLE_INPUTS.SCOUT);
      assert.equal(scout.parsed.ok, false);
      assert.equal(scout.failureCode, 'SKILL_PROVIDER_ERROR');
      assert.equal(calls.length, 2, 'no request is made without a provider credential');

      // Nothing in the redacted description carries key material.
      const described = JSON.stringify(describeAIRuntimeConfig(config));
      assert.ok(!described.includes(KIMI_SENTINEL), 'the Kimi secret must never be described');
      assert.ok(described.includes('"credentialProviders":["kimi"]'));
    } finally {
      deployment.cleanup();
    }
  });

  test('a two-provider deployment injects each provider credential on its own origin', async () => {
    const deployment = deployV2();
    try {
      const env = deploymentEnv(deployment, {
        KIMI_API_KEY: KIMI_SENTINEL,
        AI_API_KEY: DEEPSEEK_SENTINEL,
      });
      const config = loadAIRuntimeConfig(env);
      assert.deepEqual([...config.credentialProviders], ['deepseek', 'kimi']);

      const calls = [];
      const { composition } = compositionFromEnv(env, calls);
      assert.equal(composition.start().inferenceEnabled, true);
      const client = composition.getChatClient();

      const scout = await client.generateIdeas(SAMPLE_INPUTS.SCOUT);
      assert.equal(scout.parsed.ok, true, JSON.stringify(scout.parsed));
      const guard = await client.filterIdea(SAMPLE_INPUTS.GUARD.idea, {
        symbol: SAMPLE_INPUTS.GUARD.market,
        btc: SAMPLE_INPUTS.GUARD.btc,
      }, { news: SAMPLE_INPUTS.GUARD.news, sentiment: null });
      assert.equal(guard.parsed.ok, true, JSON.stringify(guard.parsed));

      const byModel = Object.fromEntries(calls.map((call) => [call.body.model, call]));
      assert.equal(byModel[MODELS.SCOUT.modelId].url, 'https://api.deepseek.com/v1/chat/completions');
      assert.equal(byModel[MODELS.SCOUT.modelId].authorization, `Bearer ${DEEPSEEK_SENTINEL}`);
      assert.equal(byModel[MODELS.GUARD.modelId].url, 'https://api.moonshot.ai/v1/chat/completions');
      assert.equal(byModel[MODELS.GUARD.modelId].authorization, `Bearer ${KIMI_SENTINEL}`);
    } finally {
      deployment.cleanup();
    }
  });

  test('the same environment without the Kimi credential fails closed before any request', async () => {
    const deployment = deployV2();
    try {
      const env = deploymentEnv(deployment, { AI_API_KEY: DEEPSEEK_SENTINEL });
      const config = loadAIRuntimeConfig(env);
      assert.deepEqual([...config.credentialProviders], ['deepseek']);

      const calls = [];
      const { composition } = compositionFromEnv(env, calls);
      assert.equal(composition.start().inferenceEnabled, true);
      const guard = await composition.getChatClient().filterIdea(SAMPLE_INPUTS.GUARD.idea, {
        symbol: SAMPLE_INPUTS.GUARD.market,
        btc: SAMPLE_INPUTS.GUARD.btc,
      }, { news: SAMPLE_INPUTS.GUARD.news, sentiment: null });
      assert.equal(guard.parsed.ok, false);
      assert.equal(guard.failureCode, 'SKILL_PROVIDER_ERROR');
      assert.equal(calls.length, 0, 'no HTTP request without a provider credential');
      // An ordinary provider failure is not a structural refusal: admission stays open.
      assert.equal(composition.status().inferenceEnabled, true);
    } finally {
      deployment.cleanup();
    }
  });
});

describe('v2 deployment bootstrap: identity sourcing stays prohibited', () => {
  test('provider, model and endpoint variables are refused in both skill modes', () => {
    const deployment = deployV2();
    try {
      for (const name of CONFLICTING_IDENTITY_ENV) {
        for (const skillMode of ['v2', 'legacy']) {
          const env = deploymentEnv(deployment, { AI_SKILL_MODE: skillMode, [name]: 'conflict' });
          assert.throws(
            () => loadAIRuntimeConfig(env),
            (error) => error.code === 'CONFIGURATION_ERROR' && error.field === name,
            `${name} must conflict in ${skillMode} mode`,
          );
        }
      }
    } finally {
      deployment.cleanup();
    }
  });

  test('KIMI_API_KEY is an identity only while the legacy dispatch is configured', () => {
    const deployment = deployV2();
    try {
      assert.deepEqual([...LEGACY_PROMPT_IDENTITY_ENV], ['KIMI_API_KEY']);
      // Legacy dispatch: the Kimi key selects a provider for REFLECT, so it is a
      // second identity authority and the launch is refused.
      assert.throws(
        () => loadAIRuntimeConfig(deploymentEnv(deployment, { AI_SKILL_MODE: 'legacy', KIMI_API_KEY: KIMI_SENTINEL })),
        /KIMI_API_KEY/,
      );
      // v2: the provider comes from the bound model registry, so the same
      // variable is a credential and the deployment starts.
      const v2 = loadAIRuntimeConfig(deploymentEnv(deployment, { KIMI_API_KEY: KIMI_SENTINEL }));
      assert.equal(v2.skillMode, 'v2');
      assert.deepEqual([...v2.credentialProviders], ['kimi']);
      // The default (unset) skill mode is still the explicit legacy migration
      // compatibility mode, which keeps refusing the Kimi identity variable.
      assert.throws(
        () => loadAIRuntimeConfig(deploymentEnv(deployment, { AI_SKILL_MODE: undefined, KIMI_API_KEY: KIMI_SENTINEL })),
        /KIMI_API_KEY/,
      );
    } finally {
      deployment.cleanup();
    }
  });

  test('a requested v2 dispatch without single-mode identity is refused, not downgraded', () => {
    assert.throws(
      () => loadAIRuntimeConfig({ AI_SKILL_MODE: 'v2' }),
      (error) => error.code === 'CONFIGURATION_ERROR' && error.details?.field === 'AI_SKILL_MODE',
    );
    // Legacy dispatch with no identity expectations stays byte-compatible.
    assert.deepEqual(loadAIRuntimeConfig({ AI_SKILL_MODE: 'legacy' }), { mode: 'legacy' });
    assert.deepEqual(loadAIRuntimeConfig({}), { mode: 'legacy' });
  });
});
