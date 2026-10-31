/**
 * Offline fixtures for the Skill v2 test suite.
 *
 * Everything is local and deterministic: an Ed25519 test keypair, a temporary
 * control directory, real package bytes published through the real CAS, a real
 * Model Registry, real capability profiles/evidence and a real execution plan.
 * No provider is contacted; transports are injected per test.
 *
 * @module test/fixtures/skills/factory
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { canonicalizeJson, digestJson, parseStrictJsonBytes, sha256Hex } from '../../../src/config/jcs.mjs';
import { AI_OPERATIONS } from '../../../src/ai/operation-profiles.mjs';
import { createCapabilityProfile } from '../../../src/ai/operation-profiles.mjs';
import { validateModelRegistry } from '../../../src/config/ai-model-registry.mjs';
import {
  computeModelIdentitySha256,
  validateCapabilityEvidence,
} from '../../../src/config/skill-release-contracts.mjs';
import { parseSkillPackage } from '../../../src/config/skill-package.mjs';
import {
  SKILL_STORE_LAYOUT,
  createSkillPackageStore,
  parseSourcePackage,
  readPackageFiles,
} from '../../../src/ai/skills/package-store.mjs';
import {
  ADAPTER_CATALOGUE_SHA256,
  ADAPTERS,
  HOST_CONTRACT_CATALOGUE_SHA256,
} from '../../../src/ai/skills/adapters/catalogue.mjs';
import { prepareExecutionPlan } from '../../../src/ai/skills/execution-plan.mjs';
import { createRuntimePolicy } from '../../../src/ai/skills/runtime-policy.mjs';
import { createSkillComposition } from '../../../src/ai/skills/composition.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const PACKAGE_IDS = Object.freeze({
  ANALYZE: 'trading.analyze',
  SCOUT: 'trading.scout',
  GUARD: 'trading.guard',
  MONITOR: 'trading.monitor',
  STOPCHECK: 'trading.stopcheck',
  REFLECT: 'trading.reflect',
});

/** Per-operation model identities: six distinct models on two providers. */
const MODELS = Object.freeze({
  ANALYZE: { key: 'analyze-primary', providerId: 'deepseek', modelId: 'deepseek-reasoner', base: 'https://api.deepseek.com/v1', trustTier: 'consequential', profileId: 'profile-analyze' },
  SCOUT: { key: 'scout-primary', providerId: 'deepseek', modelId: 'deepseek-chat', base: 'https://api.deepseek.com/v1', trustTier: 'supplementary', profileId: 'profile-scout' },
  GUARD: { key: 'guard-primary', providerId: 'kimi', modelId: 'kimi-k2-guard', base: 'https://api.moonshot.ai/v1', trustTier: 'consequential', profileId: 'profile-guard' },
  MONITOR: { key: 'monitor-primary', providerId: 'kimi', modelId: 'kimi-k2-monitor', base: 'https://api.moonshot.ai/v1', trustTier: 'supplementary', profileId: 'profile-monitor' },
  STOPCHECK: { key: 'stopcheck-primary', providerId: 'deepseek', modelId: 'deepseek-reasoner-stop', base: 'https://api.deepseek.com/v1', trustTier: 'consequential', profileId: 'profile-stopcheck' },
  REFLECT: { key: 'reflect-primary', providerId: 'deepseek', modelId: 'deepseek-chat-reflect', base: 'https://api.deepseek.com/v1', trustTier: 'informational', profileId: 'profile-reflect' },
});

/** Reviewed per-operation settings used by the fixtures. */
const SETTINGS = Object.freeze({
  ANALYZE: { temperature: 0, reasoningEffort: null, maxOutputTokens: 1024, stream: false, responseFormat: 'json_object', timeoutMs: 20000 },
  SCOUT: { temperature: 0.7, reasoningEffort: null, maxOutputTokens: 2048, stream: false, responseFormat: 'json_object', timeoutMs: 60000 },
  GUARD: { temperature: 0, reasoningEffort: 'low', maxOutputTokens: 1024, stream: false, responseFormat: 'json_object', timeoutMs: 60000 },
  MONITOR: { temperature: 0, reasoningEffort: 'low', maxOutputTokens: 512, stream: false, responseFormat: 'json_object', timeoutMs: 60000 },
  STOPCHECK: { temperature: 0, reasoningEffort: 'low', maxOutputTokens: 512, stream: false, responseFormat: 'json_object', timeoutMs: 60000 },
  REFLECT: { temperature: 0, reasoningEffort: null, maxOutputTokens: 1024, stream: false, responseFormat: 'json_object', timeoutMs: 60000 },
});

/**
 * @param {string} [prefix]
 * @returns {string}
 */
export function makeTempDir(prefix = 'skill-fixture-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * @returns {{ privateKey: import('node:crypto').KeyObject, publicKeySpkiBase64: string, keyId: string }}
 */
export function createSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeySpkiBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    keyId: 'reviewer-test-1',
  };
}

/**
 * @param {unknown} payload
 * @param {{ privateKey: import('node:crypto').KeyObject, keyId: string }} key
 * @returns {Readonly<object>}
 */
export function signEnvelope(payload, key) {
  const signed = Buffer.from(canonicalizeJson(payload, { label: 'payload' }), 'utf8');
  return Object.freeze({
    payload,
    keyId: key.keyId,
    algorithm: /** @type {'Ed25519'} */ ('Ed25519'),
    signatureBase64: sign(null, signed, key.privateKey).toString('base64'),
  });
}

/**
 * @param {ReturnType<typeof createSigningKey>} key
 * @param {{ roles?: string[] }} [options]
 */
export function createTrustRoots(key, options = {}) {
  return {
    schemaVersion: 1,
    keys: [
      {
        keyId: key.keyId,
        algorithm: 'Ed25519',
        publicKeySpkiBase64: key.publicKeySpkiBase64,
        roles: options.roles ?? ['package-reviewer', 'plan-reviewer', 'release-authorizer'],
      },
    ],
  };
}

/**
 * Build an attestation envelope for an unpublished package payload.
 *
 * @param {{ packageId: string, version: string, digest: string, botRange: string }} input
 * @param {ReturnType<typeof createSigningKey>} key
 */
export function createAttestationEnvelope(input, key) {
  return signEnvelope(
    {
      schemaVersion: 1,
      packageRef: { packageId: input.packageId, version: input.version, packageDigestSha256: input.digest },
      packageIndexSha256: input.digest,
      authorId: 'fixture-author',
      reviewerId: 'fixture-reviewer',
      reviewedAt: '2026-10-29T00:00:00Z',
      reviewStatus: 'APPROVED',
      testReportSha256: sha256Hex('test-report'),
      comparisonReportSha256: sha256Hex('comparison-report'),
      sourceRevision: 'fixture-revision',
      approvedBotRange: input.botRange,
    },
    key,
  );
}

/**
 * Read the six baseline source packages.
 *
 * @returns {Record<string, ReadonlyArray<{ path: string, bytes: Buffer }>>}
 */
export function readBaselinePackages() {
  /** @type {Record<string, any>} */
  const out = {};
  for (const operation of AI_OPERATIONS) {
    const dir = path.join(REPO_ROOT, 'skills', PACKAGE_IDS[operation], '1.0.0');
    out[operation] = readPackageFiles(dir);
  }
  return out;
}

/**
 * Patch a package payload (documents or raw text) and return the new file list.
 *
 * @param {ReadonlyArray<{ path: string, bytes: Buffer }>} files
 * @param {{ patchJson?: Record<string, (value: any) => any>, raw?: Record<string, string | Buffer>, add?: Record<string, string | Buffer>, remove?: string[] }} patch
 */
export function patchPackageFiles(files, patch) {
  const byPath = new Map(files.map((file) => [file.path, Buffer.from(file.bytes)]));
  for (const [filePath, transform] of Object.entries(patch.patchJson ?? {})) {
    const current = byPath.get(filePath);
    if (!current) throw new Error(`cannot patch missing file ${filePath}`);
    const parsed = JSON.parse(current.toString('utf8'));
    const next = transform(parsed);
    byPath.set(filePath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'));
  }
  for (const [filePath, value] of Object.entries(patch.raw ?? {})) {
    byPath.set(filePath, Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'));
  }
  for (const [filePath, value] of Object.entries(patch.add ?? {})) {
    byPath.set(filePath, Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'));
  }
  for (const filePath of patch.remove ?? []) byPath.delete(filePath);
  return [...byPath.entries()]
    .map(([filePath, bytes]) => ({ path: filePath.replaceAll('\\', '/'), bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Install package bytes directly, bypassing publication validation. This models
 * a store poisoned by a defective publisher and is only used to prove that the
 * resolver refuses such content at read time.
 *
 * @param {ReturnType<typeof createSkillPackageStore>} store
 * @param {ReadonlyArray<{ path: string, bytes: Buffer }>} files
 * @param {{ withIndex?: boolean, includeUnlisted?: boolean }} [options]
 */
export function installRawPackage(store, files, options = {}) {
  const index = {
    format: 'skill-package-v1',
    files: files
      .map((file) => ({ path: file.path, size: file.bytes.byteLength, sha256: sha256Hex(file.bytes) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  const digest = digestJson(index, { label: 'skill package index' });
  const dir = path.join(store.rootDir, SKILL_STORE_LAYOUT.packages, digest);
  fs.mkdirSync(path.join(dir, 'payload'), { recursive: true });
  for (const file of files) {
    const target = path.join(dir, 'payload', ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.bytes);
  }
  fs.writeFileSync(path.join(dir, 'package-index.json'), JSON.stringify(index, null, 2));
  return digest;
}

/**
 * Build the complete fixture.
 *
 * @param {{
 *   packageMutator?: (input: { operation: string, files: any[] }) => any[] | void,
 *   registryRefs?: Record<string, { packageId: string, version: string, packageDigestSha256: string }>,
 *   policyOverrides?: Record<string, any>,
 *   profileMutator?: (profile: any, operation: string) => any,
 *   evidenceMutator?: (evidence: any, operation: string, identity: any) => any,
 *   skipAttestationFor?: string | null,
 *   revokeOperation?: string | null,
 * }} [options]
 */
export function buildFixture(options = {}) {
  const rootDir = makeTempDir();
  const store = createSkillPackageStore({ rootDir });
  const signingKey = createSigningKey();
  const trustRoots = createTrustRoots(signingKey);
  const trustRootsSha256 = store.publishTrustRoots(trustRoots).digest;

  const baseline = readBaselinePackages();
  /** @type {Record<string, any>} */
  const packages = {};
  for (const operation of AI_OPERATIONS) {
    let files = baseline[operation];
    if (options.packageMutator) {
      const mutated = options.packageMutator({ operation, files });
      if (mutated) files = mutated;
    }
    const parsed = parseSkillPackage(files, { artifact: { botVersion: '0.1.0', skillApiVersion: 1 } });
    if (options.skipAttestationFor === operation) {
      // Published without a signed approval: the resolver must refuse.
      const digest = installRawPackage(store, files);
      packages[operation] = { files, parsed: { ...parsed, digest }, digest, ref: { packageId: parsed.packageId, version: parsed.version, packageDigestSha256: digest } };
      continue;
    }
    const envelope = createAttestationEnvelope(
      { packageId: parsed.packageId, version: parsed.version, digest: parsed.digest, botRange: parsed.manifest.compatibility.botVersionRange },
      signingKey,
    );
    store.publishPackage({ files, attestation: envelope, trustRoots, artifact: { botVersion: '0.1.0', skillApiVersion: 1 } });
    if (options.revokeOperation === operation) {
      const revocation = signEnvelope(
        {
          schemaVersion: 1,
          packageRef: { packageId: parsed.packageId, version: parsed.version, packageDigestSha256: parsed.digest },
          revokedAt: '2026-10-29T01:00:00Z',
          operatorApprovalId: 'op-approval-1',
        },
        signingKey,
      );
      store.publishRevocation(revocation, { trustRoots });
    }
    packages[operation] = {
      files,
      parsed,
      digest: parsed.digest,
      attestationSha256: sha256Hex(canonicalizeJson(envelope, { label: 'attestation' })),
      ref: { packageId: parsed.packageId, version: parsed.version, packageDigestSha256: parsed.digest },
    };
  }

  const refs = options.registryRefs ?? {};
  /** @type {Record<string, any>} */
  const operations = {};
  for (const operation of AI_OPERATIONS) {
    operations[operation] = refs[operation] ?? packages[operation].ref;
  }
  const skillRegistry = { schemaVersion: 1, registryId: 'fixture-skills-v1', operations };
  const skillRegistrySha256 = store.publishSkillRegistry(skillRegistry).digest;

  /** @type {Record<string, any>} */
  const profiles = {};
  /** @type {Record<string, any>} */
  const models = {};
  /** @type {Record<string, string>} */
  const routingTable = {};
  /** @type {Record<string, null>} */
  const fallbacks = {};
  for (const operation of AI_OPERATIONS) {
    const spec = MODELS[operation];
    let profile = createCapabilityProfile({
      profileId: spec.profileId,
      providerId: spec.providerId,
      operations: { ...Object.fromEntries(AI_OPERATIONS.map((op) => [op, SETTINGS[op]])) },
    });
    if (options.profileMutator) profile = options.profileMutator(profile, operation);
    profiles[digestJson(profile, { label: 'profile' })] = profile;
    models[spec.key] = {
      providerId: spec.providerId,
      modelId: spec.modelId,
      canonicalBaseUrl: spec.base,
      capabilityProfileId: spec.profileId,
      capabilityProfileSha256: digestJson(profile, { label: 'profile' }),
      trustTier: spec.trustTier,
    };
    routingTable[operation] = spec.key;
    fallbacks[operation] = null;
  }
  const modelRegistryDocument = { schemaVersion: 1, registryId: 'fixture-models-v1', models, routingTable, fallbacks };
  const modelRegistry = validateModelRegistry(modelRegistryDocument);
  const modelRegistrySha256 = store.publishModelRegistry(modelRegistryDocument).digest;

  /** @type {Record<string, any>} */
  const capabilityEvidence = {};
  for (const operation of AI_OPERATIONS) {
    const spec = MODELS[operation];
    const entry = modelRegistry.models[spec.key];
    const identity = {
      providerId: entry.providerId,
      modelId: entry.modelId,
      canonicalBaseUrl: entry.canonicalBaseUrl,
      trustTier: entry.trustTier,
      capabilityProfileSha256: entry.capabilityProfileSha256,
    };
    const modelIdentitySha256 = computeModelIdentitySha256(identity);
    const host = new URL(entry.canonicalBaseUrl).hostname;
    let evidence = {
      schemaVersion: 1,
      modelIdentitySha256,
      adapterId: ADAPTERS[operation].adapterId,
      adapterContractVersion: 1,
      temperature: { min: 0, max: 2 },
      responseFormats: ['json_object'],
      reasoningEfforts: [null, 'low', 'medium', 'high'],
      maxOutputTokens: 4096,
      contextWindow: 128000,
      endpointSupport: [{ host, path: '/v1/chat/completions' }],
      testArtifactSha256: sha256Hex(`evidence-${operation}`),
      reviewId: `review-${operation.toLowerCase()}`,
    };
    if (options.evidenceMutator) evidence = options.evidenceMutator(evidence, operation, identity);
    const validated = validateCapabilityEvidence(evidence);
    const published = store.publishCapabilityEvidence(validated);
    delete capabilityEvidence[modelIdentitySha256];
    capabilityEvidence[modelIdentitySha256] = {
      evidenceSha256: published.digest,
      adapterId: validated.adapterId,
      adapterContractVersion: 1,
    };
  }

  const runtimePolicy = createRuntimePolicy({
    capabilityEvidence,
    trustRootsSha256,
    ...(options.policyOverrides ?? {}),
  });
  const runtimePolicySha256 = store.publishRuntimePolicy(runtimePolicy).digest;

  const artifact = {
    artifactSha256: sha256Hex('fixture-artifact'),
    botVersion: '0.1.0',
    skillApiVersion: 1,
    adapterCatalogueSha256: ADAPTER_CATALOGUE_SHA256,
    hostContractCatalogueSha256: HOST_CONTRACT_CATALOGUE_SHA256,
  };

  const profileReader = {
    read: (profileSha256) => {
      const profile = profiles[profileSha256];
      if (!profile) throw new Error(`missing profile ${profileSha256}`);
      return profile;
    },
  };

  const fixture = {
    rootDir,
    store,
    signingKey,
    trustRoots,
    trustRootsSha256,
    packages,
    skillRegistrySha256,
    modelRegistrySha256,
    runtimePolicySha256,
    runtimePolicy,
    artifact,
    profileReader,
    modelRegistry,
    preparePlan() {
      return prepareExecutionPlan({
        store,
        skillRegistrySha256,
        modelRegistrySha256,
        runtimePolicySha256,
        artifact,
        profileReader,
      });
    },
    /**
     * @param {{ transport?: any, audit?: any, latch?: any, identity?: any, compositionOverrides?: any }} [input]
     */
    createComposition(input = {}) {
      const transport = input.transport ?? fakeTransport(() => ({ status: 200, body: JSON.stringify(defaultOutput(operation => operation)) }));
      return createSkillComposition({
        store,
        skillRegistrySha256,
        modelRegistrySha256,
        runtimePolicySha256,
        artifact,
        profileReader,
        transport,
        identity: input.identity ?? { deploymentId: 'deployment-1', generation: 7, slot: 'telegram', instanceId: 'instance-1' },
        latch: input.latch,
        audit: input.audit,
        clock: input.clock,
        uuid: input.uuid,
        ...(input.compositionOverrides ?? {}),
      });
    },
    cleanup() {
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
  return fixture;
}

/** Deterministic per-operation model answers used by the happy-path tests. */
export const SAMPLE_OUTPUTS = Object.freeze({
  ANALYZE: { bias: 'BULLISH', confidence: 0.62, rationale: 'Higher lows on the hourly series.' },
  SCOUT: {
    ideas: [{ symbol: 'BTCUSDT', side: 'LONG', entry: 102, stopLoss: 99, takeProfit: 107, rationale: 'Swing low holds.' }],
  },
  GUARD: { verdict: 'APPROVED', confidence: 0.55, reasons: ['Coherent setup.'] },
  MONITOR: { action: 'HOLD', reason: 'Trend still aligned.', confidence: 0.6 },
  STOPCHECK: { action: 'HOLD', reason: 'Loss is normal noise.', confidence: 0.5 },
  REFLECT: { lesson: 'The stop did its job.', proposedRule: '', severity: 'low', matchedExistingRule: false },
});

/** Deterministic host snapshots used by the happy-path tests. */
export const SAMPLE_INPUTS = Object.freeze({
  ANALYZE: {
    market: {
      symbol: 'BTCUSDT',
      timeframe: '1h',
      lastPrice: 102,
      bid: 101.9,
      ask: 102.1,
      candles: [
        { startTime: 1760000000000, open: 100, high: 102, low: 99, close: 101, volume: 10 },
        { startTime: 1760003600000, open: 101, high: 103, low: 100, close: 102, volume: 12 },
      ],
      indicators: { ema21: 101.5, rsi14: 55 },
    },
    position: null,
  },
  SCOUT: {
    news: 'No material headlines.',
    symbols: [
      {
        symbol: 'BTCUSDT',
        lastPrice: 102,
        bid: 101.9,
        ask: 102.1,
        high24h: 110,
        low24h: 95,
        avgRange14h: 1,
        candles: [
          { o: 100, h: 102, l: 99, c: 101, v: 10 },
          { o: 101, h: 103, l: 100, c: 102, v: 12 },
        ],
      },
    ],
    openPositions: null,
  },
  GUARD: {
    btc: { lastPrice: 102, ema21h: 101, change4hPct: 0.5, bias: 'up' },
    news: 'No material headlines.',
    idea: { symbol: 'BTCUSDT', side: 'LONG', entry: 102, stopLoss: 99, takeProfit: 107 },
    market: {
      symbol: 'BTCUSDT',
      lastPrice: 102,
      bid: 101.9,
      ask: 102.1,
      high24h: 110,
      low24h: 95,
      avgRange14h: 1,
      candles: [
        { o: 100, h: 102, l: 99, c: 101, v: 10 },
        { o: 101, h: 103, l: 100, c: 102, v: 12 },
      ],
    },
    sentiment: null,
  },
  MONITOR: {
    news: null,
    position: { symbol: 'BTCUSDT', side: 'LONG', avgPrice: 100, markPrice: 102, stopLoss: 97, takeProfit: 110, unrealisedPnl: 4, leverage: 3, kind: 'limit' },
    market: {
      symbol: 'BTCUSDT',
      lastPrice: 102,
      bid: 101.9,
      ask: 102.1,
      high24h: 110,
      low24h: 95,
      avgRange14h: 1,
      candles: [
        { o: 100, h: 102, l: 99, c: 101, v: 10 },
        { o: 101, h: 103, l: 100, c: 102, v: 12 },
      ],
      atr14h: 1.2,
      trend: { ema21h: 101, change4hPct: 0.5, bias: 'up' },
    },
    btc: { lastPrice: 102, ema21h: 101, change4hPct: 0.5, bias: 'up' },
  },
  STOPCHECK: {
    news: null,
    position: { symbol: 'BTCUSDT', side: 'LONG', avgPrice: 103, markPrice: 101, stopLoss: 97, takeProfit: 110, unrealisedPnl: -4, leverage: 3, kind: 'limit' },
    market: {
      symbol: 'BTCUSDT',
      lastPrice: 101,
      bid: 100.9,
      ask: 101.1,
      high24h: 110,
      low24h: 95,
      avgRange14h: 1,
      candles: [
        { o: 100, h: 102, l: 99, c: 101, v: 10 },
        { o: 101, h: 103, l: 100, c: 102, v: 12 },
      ],
      atr14h: 1.2,
      trend: { ema21h: 102, change4hPct: -0.8, bias: 'down' },
    },
    btc: { lastPrice: 101, ema21h: 102, change4hPct: -0.8, bias: 'down' },
  },
  REFLECT: {
    trade: { symbol: 'BTCUSDT', side: 'LONG', entry: 100, exit: 99, pnlUsd: -1.1, reason: 'Protective stop', exitCause: 'stop', holdMinutes: 10, mfeUsd: 0 },
    existingRules: null,
  },
});

/** Default chat-completions envelope around a model answer. */
export function chatEnvelope(answer) {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) } }],
  });
}

/**
 * @param {(request: any) => any | Promise<any>} handler
 * @param {{ usage?: object | null }} [options]
 */
export function fakeTransport(handler, options = {}) {
  const calls = [];
  return {
    id: 'fake',
    calls,
    async complete(request) {
      calls.push(request);
      const result = await handler(request);
      if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
        return { usage: options.usage ?? null, latencyMs: 5, ...result };
      }
      return { status: 200, body: chatEnvelope(result), usage: options.usage ?? null, latencyMs: 5 };
    },
  };
}

/** @param {(operation: string) => unknown} _unused */
function defaultOutput(_unused) {
  return SAMPLE_OUTPUTS.ANALYZE;
}

/** Re-export a few helpers so tests do not import internals directly. */
export { PACKAGE_IDS, SETTINGS, MODELS, parseStrictJsonBytes, randomUUID };
