/**
 * Codex routing — the model registry, capability profiles and the core provider
 * factory must accept the local-CLI provider without weakening any identity
 * rule, and must refuse it by default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCapabilityProfile,
  validateCapabilityProfile,
  VALID_PROVIDERS,
} from '../src/ai/operation-profiles.mjs';
import {
  validateModelIdentityManifest,
  deriveChatCompletionsUrl,
  normalizeBaseUrl,
  LOCAL_CLI_BASE_URLS,
  PROVIDER_IDS,
} from '../src/config/ai-identity-manifest.mjs';
import { validateModelRegistry, loadModelRegistry } from '../src/config/ai-model-registry.mjs';
import { resolveOperationModel } from '../src/ai/model-resolver.mjs';
import { createDefaultCoreProviderFactory, SUPPORTED_CORE_PROVIDERS } from '../src/ai/core-ai-composition.mjs';
import { CODEX_LOCAL_IDENTITY, CODEX_ROUTINE_MODEL, CODEX_ASTRA_MODEL } from '../src/providers/codex/codex-provider.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { CoordinationError, COORDINATION_ERROR_CODE } from '../src/errors/coordination-error.mjs';

const PROFILE = createCapabilityProfile({ profileId: 'codex-unified-v1', providerId: 'codex' });
const DIGEST = 'aa'.repeat(32);

const MANIFEST = Object.freeze({
  schemaVersion: 1,
  manifestVersion: 'codex-v1',
  providerId: 'codex',
  modelId: CODEX_ROUTINE_MODEL,
  canonicalBaseUrl: CODEX_LOCAL_IDENTITY,
  capabilityProfileId: 'codex-unified-v1',
  capabilityProfileSha256: DIGEST,
});

/** A registry document routing every operation to one codex model. */
function registryWith(modelId = CODEX_ROUTINE_MODEL) {
  return {
    schemaVersion: 1,
    registryId: 'codex-registry',
    models: {
      'codex-routine': {
        providerId: 'codex',
        modelId,
        canonicalBaseUrl: CODEX_LOCAL_IDENTITY,
        capabilityProfileId: 'codex-unified-v1',
        capabilityProfileSha256: DIGEST,
        trustTier: 'consequential',
      },
    },
    routingTable: {
      ANALYZE: 'codex-routine',
      SCOUT: 'codex-routine',
      GUARD: 'codex-routine',
      MONITOR: 'codex-routine',
      STOPCHECK: 'codex-routine',
      REFLECT: 'codex-routine',
    },
    fallbacks: {
      SCOUT: null,
      MONITOR: null,
      REFLECT: null,
    },
  };
}

function transportDouble() {
  const requests = [];
  return {
    requests,
    transport: {
      async complete(request) {
        requests.push(request);
        return {
          ok: true,
          content: '{"bias":"BULLISH","confidence":0.8,"rationale":"ok"}',
          usage: null,
        };
      },
    },
  };
}

// ─── Identity layers ─────────────────────────────────────────────────────────

test('ROUTING: codex is an accepted provider id in the closed enums', () => {
  assert.ok(VALID_PROVIDERS.includes('codex'));
  assert.ok(PROVIDER_IDS.includes('codex'));
  assert.ok(SUPPORTED_CORE_PROVIDERS.includes('codex'));
  assert.equal(LOCAL_CLI_BASE_URLS.codex, 'cli://codex');
});

test('ROUTING: a codex capability profile validates and is content-addressable', () => {
  assert.equal(PROFILE.providerId, 'codex');
  assert.deepEqual(Object.keys(PROFILE.operations).sort(), [
    'ANALYZE',
    'GUARD',
    'MONITOR',
    'REFLECT',
    'SCOUT',
    'STOPCHECK',
  ]);
  assert.throws(
    () => validateCapabilityProfile({ ...PROFILE, providerId: 'not-a-provider' }),
    ConfigError,
  );
});

test('ROUTING: a codex manifest accepts only the local sentinel', () => {
  const manifest = validateModelIdentityManifest(MANIFEST);
  assert.equal(manifest.providerId, 'codex');
  assert.equal(manifest.canonicalBaseUrl, 'cli://codex');

  // No HTTP endpoint may be attached to a local process.
  assert.throws(
    () => validateModelIdentityManifest({ ...MANIFEST, canonicalBaseUrl: 'https://api.openai.com/v1' }),
    ConfigError,
  );
  // And the sentinel may not be used for an HTTP provider.
  assert.throws(
    () => normalizeBaseUrl('cli://codex', { providerId: 'deepseek' }),
    ConfigError,
  );
  assert.throws(() => deriveChatCompletionsUrl(manifest), ConfigError);
});

test('ROUTING: the registry accepts a codex model and refuses a mismatched endpoint', () => {
  const registry = validateModelRegistry(registryWith());
  assert.equal(registry.models['codex-routine'].canonicalBaseUrl, 'cli://codex');
  assert.equal(registry.routingTable.ANALYZE, 'codex-routine');

  assert.throws(
    () => validateModelRegistry({
      ...registryWith(),
      models: {
        'codex-routine': { ...registryWith().models['codex-routine'], canonicalBaseUrl: 'https://api.deepseek.com/v1' },
      },
    }),
    ConfigError,
  );
});

test('ROUTING: the registry refuses a provider that is not in the allowlist', () => {
  const document = registryWith();
  document.models['codex-routine'].providerId = 'mystery-provider';
  assert.throws(() => validateModelRegistry(document), ConfigError);
});

test('ROUTING: resolveOperationModel resolves ANALYZE to the codex identity', () => {
  const { registry } = loadModelRegistry(JSON.stringify(registryWith(CODEX_ASTRA_MODEL)));
  const resolved = resolveOperationModel('ANALYZE', registry);
  assert.equal(resolved.providerId, 'codex');
  assert.equal(resolved.modelId, CODEX_ASTRA_MODEL);
  assert.equal(resolved.canonicalBaseUrl, 'cli://codex');
});

// ─── Provider factory ────────────────────────────────────────────────────────

test('ROUTING: the core factory refuses codex while AI_CODEX_ENABLED is false', () => {
  const { transport } = transportDouble();
  assert.throws(
    () => createDefaultCoreProviderFactory({
      manifest: MANIFEST,
      profile: PROFILE,
      apiKey: null,
      env: {},
      codexTransport: transport,
    }),
    (error) => error instanceof CoordinationError && error.code === COORDINATION_ERROR_CODE.ACTIVATION_PAUSED,
  );
});

test('ROUTING: the enabled factory builds a codex provider with no API key', async () => {
  const { transport, requests } = transportDouble();
  const provider = createDefaultCoreProviderFactory({
    manifest: MANIFEST,
    profile: PROFILE,
    apiKey: null,
    env: { AI_CODEX_ENABLED: 'true' },
    codexTransport: transport,
  });
  assert.equal(provider.id, 'codex');
  assert.equal(provider.modelId, CODEX_ROUTINE_MODEL);

  const outcome = await provider.analyze({
    market: { symbol: 'BTCUSDT', lastPrice: 86000, indicators: { atr: 320 } },
    position: null,
  });
  assert.equal(outcome.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].schema.title, 'AIAnalysisOutput');
  // ANALYZE's reviewed profile has reasoningEffort null and no server-side schema.
  assert.equal(requests[0].reasoningEffort, null);
});

test('ROUTING: Astra is refused for ANALYZE unless explicitly configured', () => {
  const { transport } = transportDouble();
  const astraManifest = { ...MANIFEST, modelId: CODEX_ASTRA_MODEL };

  assert.throws(
    () => createDefaultCoreProviderFactory({
      manifest: astraManifest,
      profile: PROFILE,
      apiKey: null,
      env: { AI_CODEX_ENABLED: 'true' },
      codexTransport: transport,
    }),
    (error) => error instanceof CoordinationError && error.code === COORDINATION_ERROR_CODE.CONFIGURATION_ERROR,
  );

  const provider = createDefaultCoreProviderFactory({
    manifest: astraManifest,
    profile: PROFILE,
    apiKey: null,
    env: { AI_CODEX_ENABLED: 'true', AI_CODEX_ASTRA_OPERATIONS: 'ANALYZE' },
    codexTransport: transport,
  });
  assert.equal(provider.modelId, CODEX_ASTRA_MODEL);
});

test('ROUTING: a profile the codex adapter cannot honour is refused', () => {
  const { transport } = transportDouble();
  const hotProfile = validateCapabilityProfile({
    ...PROFILE,
    profileId: 'codex-hot',
    operations: {
      ...PROFILE.operations,
      ANALYZE: { ...PROFILE.operations.ANALYZE, temperature: 0.7 },
    },
  });
  assert.throws(
    () => createDefaultCoreProviderFactory({
      manifest: MANIFEST,
      profile: hotProfile,
      apiKey: null,
      env: { AI_CODEX_ENABLED: 'true' },
      codexTransport: transport,
    }),
    (error) => error instanceof CoordinationError && error.code === COORDINATION_ERROR_CODE.CONFIGURATION_ERROR,
  );
});

test('ROUTING: an HTTP provider still requires an API key', () => {
  const deepseekManifest = {
    ...MANIFEST,
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    canonicalBaseUrl: 'https://api.deepseek.com/v1',
    capabilityProfileId: 'deepseek-unified-v1',
  };
  const deepseekProfile = createCapabilityProfile({ profileId: 'deepseek-unified-v1', providerId: 'deepseek' });
  assert.throws(
    () => createDefaultCoreProviderFactory({
      manifest: deepseekManifest,
      profile: deepseekProfile,
      apiKey: '',
      env: {},
    }),
    ConfigError,
  );
});
