/**
 * UAI-05A — manifest, profile and release-schema validation.
 *
 * These tests pin the identity contract before any coordination code can rely on
 * it: canonical JCS digests, strict JSON (duplicate keys, unknown fields, size
 * ceilings, invalid UTF-8), canonical endpoint rules, immutable manifest
 * versions, profile digest matching and the single-mode environment conflicts.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  canonicalizeJson,
  digestJson,
  parseStrictJson,
  parseStrictJsonBytes,
  sha256Hex,
  StrictJsonError,
  STRICT_JSON_CODE,
} from '../src/config/jcs.mjs';
import {
  canonicalizeBaseUrl,
  computeManifestDigest,
  deriveChatCompletionsUrl,
  loadModelIdentityManifestFromBytes,
  MANIFEST_MAX_BYTES,
  normalizeBaseUrl,
  validateModelIdentityManifest,
} from '../src/config/ai-identity-manifest.mjs';
import {
  capabilityProfileSha256,
  createCapabilityProfile,
  DEFAULT_CAPABILITY_PROFILE_BODIES,
  getOperationSettings,
  validateCapabilityProfile,
  AI_OPERATIONS,
} from '../src/ai/operation-profiles.mjs';
import {
  computeArtifactSetDigest,
  computeInventoryDigest,
  validateAck,
  validateBinding,
  validateControlRecord,
  validateReleaseDescriptor,
  validateTransition,
} from '../src/config/ai-release-schema.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import {
  CONFLICTING_IDENTITY_ENV,
  describeAIRuntimeConfig,
  isSingleModeConfig,
  loadAIRuntimeConfig,
} from '../src/config/ai-runtime.mjs';
import { artifactDigest, buildReleaseFixture } from './fixtures/ai-release/factory.mjs';

const manifestBody = (overrides = {}) => ({
  schemaVersion: 1,
  manifestVersion: 'release-1',
  providerId: 'deepseek',
  modelId: 'deepseek-chat',
  canonicalBaseUrl: 'https://api.deepseek.com/v1',
  capabilityProfileId: 'deepseek-unified-v1',
  capabilityProfileSha256: capabilityProfileSha256(
    createCapabilityProfile({ profileId: 'deepseek-unified-v1', providerId: 'deepseek' }),
  ),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------
test('UAI-05A JCS: equivalent formatting and key order hash equally', () => {
  const a = parseStrictJson('{"b":1,"a":{"d":true,"c":[1,2,3]}}');
  const b = parseStrictJson('{\n  "a": { "c": [1, 2, 3], "d": true },\n  "b": 1\n}\n');
  assert.equal(canonicalizeJson(a), canonicalizeJson(b));
  assert.equal(digestJson(a), digestJson(b));
  assert.equal(canonicalizeJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('UAI-05A JCS: string escaping follows RFC 8785', () => {
  assert.equal(canonicalizeJson('a\u0001b"c\\d'), '"a\\u0001b\\"c\\\\d"');
  assert.equal(canonicalizeJson('привет'), '"привет"');
  assert.equal(canonicalizeJson(-0), '0');
  assert.equal(canonicalizeJson(1.5), '1.5');
});

test('UAI-05A JCS: values without a canonical form are rejected', () => {
  assert.throws(() => canonicalizeJson({ a: Number.NaN }), StrictJsonError);
  assert.throws(() => canonicalizeJson({ a: Infinity }), StrictJsonError);
  assert.throws(() => canonicalizeJson({ a: undefined }), StrictJsonError);
  assert.throws(() => canonicalizeJson({ a: 1n }), StrictJsonError);
  assert.throws(() => canonicalizeJson({ a: new Date() }), StrictJsonError);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => canonicalizeJson(cycle), StrictJsonError);
  assert.throws(() => canonicalizeJson('\ud800'), StrictJsonError);
});

test('UAI-05A strict JSON: duplicate keys fail before canonicalization', () => {
  assert.throws(
    () => parseStrictJson('{"manifestVersion":"a","manifestVersion":"b"}', { label: 'manifest' }),
    (error) => error instanceof StrictJsonError && error.code === STRICT_JSON_CODE.DUPLICATE_KEY,
  );
  assert.throws(() => parseStrictJson('{"a":{"b":1,"b":2}}'), StrictJsonError);
});

test('UAI-05A strict JSON: unknown fields, size ceiling and invalid UTF-8 fail', () => {
  assert.throws(() => validateModelIdentityManifest(manifestBody({ extra: true })), ConfigError);
  assert.throws(() => validateModelIdentityManifest(manifestBody({ modelId: '' })), ConfigError);
  assert.throws(
    () => parseStrictJsonBytes(Buffer.alloc(MANIFEST_MAX_BYTES + 1, 0x20), { maxBytes: MANIFEST_MAX_BYTES }),
    (error) => error.code === STRICT_JSON_CODE.OVERSIZE,
  );
  const invalidUtf8 = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  assert.throws(
    () => parseStrictJsonBytes(invalidUtf8),
    (error) => error.code === STRICT_JSON_CODE.INVALID_UTF8,
  );
  assert.throws(() => parseStrictJson('{"a":1} trailing'), StrictJsonError);
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
test('UAI-05A manifest: a valid manifest validates and hashes deterministically', () => {
  const manifest = validateModelIdentityManifest(manifestBody());
  const digest = computeManifestDigest(manifest);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(computeManifestDigest({ ...manifest }), digest);
  assert.equal(deriveChatCompletionsUrl(manifest), 'https://api.deepseek.com/v1/chat/completions');
});

test('UAI-05A manifest: version, model and profile changes change the digest', () => {
  const base = computeManifestDigest(manifestBody());
  assert.notEqual(computeManifestDigest(manifestBody({ manifestVersion: 'release-2' })), base);
  assert.notEqual(computeManifestDigest(manifestBody({ modelId: 'deepseek-reasoner' })), base);
  assert.notEqual(
    computeManifestDigest(manifestBody({ capabilityProfileId: 'deepseek-unified-v2' })),
    base,
  );
});

test('UAI-05A manifest: a same-version digest mutation is detectable and rejected on load', () => {
  const manifest = manifestBody();
  const digest = computeManifestDigest(manifest);
  const bytes = Buffer.from(JSON.stringify({ ...manifest, modelId: 'deepseek-reasoner' }));
  assert.throws(
    () => loadModelIdentityManifestFromBytes(bytes, { expectedVersion: 'release-1', expectedSha256: digest }),
    /does not match the expected manifest hash/,
  );
  const good = Buffer.from(JSON.stringify(manifest));
  const loaded = loadModelIdentityManifestFromBytes(good, { expectedVersion: 'release-1', expectedSha256: digest });
  assert.equal(loaded.manifestSha256, digest);
});

test('UAI-05A manifest: schema, identifiers and control characters are closed', () => {
  assert.throws(() => validateModelIdentityManifest(manifestBody({ schemaVersion: 2 })), ConfigError);
  assert.throws(() => validateModelIdentityManifest(manifestBody({ manifestVersion: 'bad version' })), ConfigError);
  assert.throws(() => validateModelIdentityManifest(manifestBody({ modelId: ' padded ' })), ConfigError);
  assert.throws(() => validateModelIdentityManifest(manifestBody({ modelId: 'bad\u0000model' })), ConfigError);
  assert.throws(() => validateModelIdentityManifest(manifestBody({ providerId: 'openai' })), ConfigError);
  assert.throws(() => validateModelIdentityManifest(manifestBody({ capabilityProfileSha256: 'ABC' })), ConfigError);
});

test('UAI-05A endpoint: authoring vectors normalize to the canonical API root', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1', { providerId: 'deepseek' }), 'https://api.deepseek.com/v1');
  assert.equal(normalizeBaseUrl('HTTPS://API.DeepSeek.com:443/v1/', { providerId: 'deepseek' }), 'https://api.deepseek.com/v1');
  assert.equal(normalizeBaseUrl('https://api.moonshot.cn/v1/', { providerId: 'kimi' }), 'https://api.moonshot.cn/v1');
  assert.equal(canonicalizeBaseUrl('https://api.deepseek.com/v1', { providerId: 'deepseek' }), 'https://api.deepseek.com/v1');
});

test('UAI-05A endpoint: noncanonical and unsafe URLs fail closed', () => {
  const policy = { providerId: 'deepseek' };
  const bad = [
    'http://api.deepseek.com/v1',
    'https://api.deepseek.com/v1/chat',
    'https://api.deepseek.com/',
    'https://user:pass@api.deepseek.com/v1',
    'https://api.deepseek.com/v1?x=1',
    'https://api.deepseek.com/v1#frag',
    'https://api.deepseek.com/v1/%2e%2e/other',
    'https://api.deepseek.com:8443/v1',
    'https://evil.example.com/v1',
    'https://api.moonshot.cn/v1',
    'https://api.deepseek.com\\v1',
    'https://api.deepseek.com/a/../v1',
    '  https://api.deepseek.com/v1',
    'https://api.deepseek.com/v1/extra',
  ];
  for (const url of bad) {
    assert.throws(() => canonicalizeBaseUrl(url, policy), ConfigError, `expected rejection for ${url}`);
  }
  // Noncanonical but otherwise valid strings are rejected by the validator.
  assert.throws(() => canonicalizeBaseUrl('https://API.deepseek.com/v1', policy), /not canonical/);
  assert.throws(() => canonicalizeBaseUrl('https://api.deepseek.com:443/v1', policy), /not canonical/);
});

test('UAI-05A endpoint: a loopback test policy is constructor-injected, never env-driven', () => {
  const policy = { allowLoopback: true, allowHttp: true };
  assert.equal(
    normalizeBaseUrl('http://127.0.0.1:8080/v1', { providerId: 'deepseek', policy }),
    'http://127.0.0.1:8080/v1',
  );
  // Without the injected policy the same URL fails, and no environment variable
  // can enable the bypass.
  assert.throws(() => normalizeBaseUrl('http://127.0.0.1:8080/v1', { providerId: 'deepseek' }), ConfigError);
  assert.throws(
    () => normalizeBaseUrl('https://api.deepseek.com:8080/v1', { providerId: 'deepseek', policy }),
    /default HTTPS port/,
  );
});

// ---------------------------------------------------------------------------
// Capability profile
// ---------------------------------------------------------------------------
test('UAI-05A profile: all six operations are required and content-addressable', () => {
  const profile = createCapabilityProfile({ profileId: 'deepseek-unified-v1', providerId: 'deepseek' });
  for (const operation of AI_OPERATIONS) assert.ok(getOperationSettings(profile, operation));
  const digest = capabilityProfileSha256(profile);
  assert.equal(capabilityProfileSha256(createCapabilityProfile({ profileId: 'deepseek-unified-v1', providerId: 'deepseek' })), digest);
  assert.notEqual(
    capabilityProfileSha256(createCapabilityProfile({ profileId: 'deepseek-unified-v2', providerId: 'deepseek' })),
    digest,
  );
});

test('UAI-05A profile: operation settings preserve legacy behaviour and reject unknown keys', () => {
  const profile = createCapabilityProfile({ profileId: 'deepseek-unified-v1', providerId: 'deepseek' });
  assert.equal(getOperationSettings(profile, 'SCOUT').temperature, 0.7);
  assert.equal(getOperationSettings(profile, 'GUARD').temperature, 0);
  assert.equal(getOperationSettings(profile, 'GUARD').reasoningEffort, 'low');
  assert.equal(getOperationSettings(profile, 'ANALYZE').temperature, 0);

  const body = structuredClone(DEFAULT_CAPABILITY_PROFILE_BODIES.deepseek);
  body.operations.ANALYZE.bogus = 1;
  assert.throws(() => validateCapabilityProfile(body), ConfigError);
  const missing = structuredClone(DEFAULT_CAPABILITY_PROFILE_BODIES.deepseek);
  delete missing.operations.REFLECT;
  assert.throws(() => validateCapabilityProfile(missing), ConfigError);
  const streaming = structuredClone(DEFAULT_CAPABILITY_PROFILE_BODIES.deepseek);
  streaming.operations.GUARD.stream = true;
  assert.throws(() => validateCapabilityProfile(streaming), ConfigError);
});

// ---------------------------------------------------------------------------
// Release schema
// ---------------------------------------------------------------------------
test('UAI-05A release schema: inventory and artifact digests are order-insensitive but slot-stable', () => {
  const inventory = [
    { slot: 'telegram', operations: ['REFLECT', 'SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK'], enabled: true },
    { slot: 'core-analysis', operations: ['ANALYZE'], enabled: true },
  ];
  const reordered = [...inventory].reverse();
  assert.equal(computeInventoryDigest(inventory), computeInventoryDigest(reordered));
  assert.throws(
    () => computeInventoryDigest([{ slot: 'telegram', operations: ['SCOUT', 'SCOUT'], enabled: true }]),
    /duplicate operation/,
  );
  assert.throws(
    () => computeInventoryDigest([
      { slot: 'telegram', operations: ['SCOUT'], enabled: true },
      { slot: 'telegram', operations: ['GUARD'], enabled: true },
    ]),
    /duplicate slot/,
  );

  const artifacts = [{ slot: 'telegram', artifactSha256: artifactDigest('tg') }];
  const observers = [{ observerId: 'core-bootstrap', artifactSha256: artifactDigest('core'), required: true }];
  const digest = computeArtifactSetDigest({ artifacts, observers, inventory: [{ slot: 'telegram', operations: ['SCOUT'], enabled: true }] });
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test('UAI-05A release schema: replicas may share an operation across distinct slots', () => {
  const inventory = [
    { slot: 'telegram-a', operations: ['SCOUT'], enabled: true },
    { slot: 'telegram-b', operations: ['SCOUT'], enabled: true },
  ];
  const digest = computeInventoryDigest(inventory);
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test('UAI-05A release schema: an enabled slot must have an artifact and a disabled slot must not', () => {
  const inventory = [
    { slot: 'core-analysis', operations: ['ANALYZE'], enabled: true },
    { slot: 'telegram', operations: ['SCOUT'], enabled: true },
  ];
  assert.throws(
    () => computeArtifactSetDigest({
      artifacts: [{ slot: 'telegram', artifactSha256: artifactDigest('tg') }],
      observers: [],
      inventory,
    }),
    /no assigned artifact/,
  );
  assert.throws(
    () => computeArtifactSetDigest({
      artifacts: [{ slot: 'core-analysis', artifactSha256: artifactDigest('core') }],
      observers: [],
      inventory: [{ slot: 'core-analysis', operations: ['ANALYZE'], enabled: false }],
    }),
    /must not have an active artifact/,
  );
  assert.throws(
    () => computeArtifactSetDigest({
      artifacts: [
        { slot: 'core-analysis', artifactSha256: artifactDigest('core') },
        { slot: 'telegram', artifactSha256: artifactDigest('tg') },
      ],
      observers: [{ observerId: 'core-analysis', artifactSha256: artifactDigest('x'), required: true }],
      inventory,
    }),
    /aliases an inference slot/,
  );
});

test('UAI-05A release schema: control record phases and cross-references are closed', () => {
  const fixture = buildReleaseFixture();
  const record = {
    schemaVersion: 1,
    deploymentId: '11111111-1111-4111-8111-111111111111',
    revision: 0,
    generation: 0,
    nextGeneration: null,
    phase: 'PAUSED',
    active: null,
    target: null,
    transitionId: null,
    inventory: fixture.inventory,
    members: [],
    highWaterGeneration: 0,
    approvalId: null,
    releaseDescriptorSha256: null,
    transition: null,
  };
  const validated = validateControlRecord(record);
  assert.equal(validated.phase, 'PAUSED');
  assert.throws(() => validateControlRecord({ ...record, phase: 'ACTIVE' }), /ACTIVE requires/);
  assert.throws(() => validateControlRecord({ ...record, highWaterGeneration: -1 }), ConfigError);
  assert.throws(
    () => validateControlRecord({ ...record, members: [{ slot: 'nope', instanceId: 'x', artifactSha256: artifactDigest('x') }] }),
    /not in the inventory/,
  );
  assert.throws(
    () => validateControlRecord({
      ...record,
      inventory: [{ slot: 'core-analysis', operations: ['ANALYZE'], enabled: false }],
      members: [{ slot: 'core-analysis', instanceId: 'x', artifactSha256: artifactDigest('x') }],
    }),
    /belongs to a disabled slot/,
  );
  assert.throws(() => validateControlRecord({ ...record, revision: Number.MAX_SAFE_INTEGER + 2 }), ConfigError);
});

test('UAI-05A release schema: acknowledgements cannot claim readiness with outstanding work', () => {
  const fixture = buildReleaseFixture();
  const ack = {
    schemaVersion: 1,
    deploymentId: '11111111-1111-4111-8111-111111111111',
    transitionId: '22222222-2222-4222-8222-222222222222',
    targetGeneration: 2,
    slot: 'telegram',
    instanceId: 'inst-1',
    artifactSha256: fixture.artifactMap.telegram,
    status: 'PREPARED',
    manifestVersion: fixture.binding.manifestVersion,
    manifestSha256: fixture.binding.manifestSha256,
    capabilityProfileSha256: fixture.binding.capabilityProfileSha256,
    inventorySha256: fixture.binding.inventorySha256,
    outstandingWork: 0,
    pendingAIApprovals: 0,
    errorCode: null,
  };
  assert.equal(validateAck(ack).status, 'PREPARED');
  assert.throws(() => validateAck({ ...ack, outstandingWork: 1 }), /requires outstandingWork 0/);
  assert.throws(() => validateAck({ ...ack, pendingAIApprovals: 1 }), /requires pendingAIApprovals 0/);
  assert.throws(() => validateAck({ ...ack, status: 'ERROR', errorCode: null }), /requires an errorCode/);
  assert.throws(() => validateAck({ ...ack, targetGeneration: 0 }), ConfigError);
});

test('UAI-05A release schema: a descriptor binding must match its inventory and artifacts', () => {
  const fixture = buildReleaseFixture();
  assert.equal(validateReleaseDescriptor(fixture.descriptor).approvalId, fixture.descriptor.approvalId);
  assert.throws(
    () => validateReleaseDescriptor({
      ...fixture.descriptor,
      binding: { ...fixture.descriptor.binding, inventorySha256: 'a'.repeat(64) },
    }),
    /inventory digest does not match/,
  );
  assert.throws(
    () => validateReleaseDescriptor({ ...fixture.descriptor, approvalId: 'bad approval' }),
    ConfigError,
  );
});

test('UAI-05A release schema: transition cross-references are validated', () => {
  const fixture = buildReleaseFixture();
  const base = {
    descriptorSha256: fixture.descriptorSha256,
    oldMembers: [{ slot: 'telegram', instanceId: 'old-1', artifactSha256: fixture.artifactMap.telegram }],
    targetMembers: [],
    retirementEvidence: [],
    prepareEvidence: [],
    observerEvidence: [],
    stageGrants: [],
    abandonedTransitionId: null,
  };
  assert.equal(validateTransition(base).oldMembers.length, 1);
  assert.throws(
    () => validateTransition({
      ...base,
      retirementEvidence: [{ slot: 'telegram', instanceId: 'ghost', kind: 'QUIESCED', evidenceSha256: 'b'.repeat(64) }],
    }),
    /which is not an old member/,
  );
  assert.throws(
    () => validateTransition({
      ...base,
      prepareEvidence: [{ slot: 'telegram', instanceId: 'ghost', evidenceSha256: 'b'.repeat(64) }],
    }),
    /neither a target member nor a granted retained instance/,
  );
  // A retained instance may hold a trusted stage grant and prepare under it.
  const retained = validateTransition({
    ...base,
    stageGrants: [{ slot: 'telegram', instanceId: 'old-1', descriptorSha256: fixture.descriptorSha256, approvalId: 'approval-001' }],
    prepareEvidence: [{ slot: 'telegram', instanceId: 'old-1', evidenceSha256: 'b'.repeat(64) }],
  });
  assert.equal(retained.stageGrants.length, 1);
  assert.equal(retained.prepareEvidence.length, 1);
  // A grant for an instance that is not an old member is rejected.
  assert.throws(
    () => validateTransition({
      ...base,
      stageGrants: [{ slot: 'telegram', instanceId: 'ghost', descriptorSha256: fixture.descriptorSha256, approvalId: 'approval-001' }],
    }),
    /which is not an old member/,
  );
});

test('UAI-05A binding: every field is a digest or identifier', () => {
  const fixture = buildReleaseFixture();
  assert.doesNotThrow(() => validateBinding(fixture.binding));
  assert.throws(() => validateBinding({ ...fixture.binding, manifestSha256: fixture.binding.manifestSha256.toUpperCase() }), ConfigError);
  assert.throws(() => validateBinding({ ...fixture.binding, extra: 1 }), ConfigError);
});

// ---------------------------------------------------------------------------
// Single-mode configuration
// ---------------------------------------------------------------------------
test('UAI-05A config: legacy mode is inert and unchanged', () => {
  const config = loadAIRuntimeConfig({});
  assert.deepEqual(config, { mode: 'legacy' });
  assert.equal(isSingleModeConfig(config), false);
  assert.deepEqual(describeAIRuntimeConfig(config), { mode: 'legacy', identityValidated: false, inferenceEnabled: false });
  // Legacy identity variables are ignored outside single mode.
  assert.doesNotThrow(() => loadAIRuntimeConfig({ AI_MODEL: 'anything', AI_PROVIDER: 'deepseek' }));
});

test('UAI-05A config: single mode requires explicit control, deployment and expectations', () => {
  const base = {
    AI_RUNTIME_MODE: 'single',
    AI_CONTROL_DIR: '/tmp/ai-control',
    AI_DEPLOYMENT_ID: '11111111-1111-4111-8111-111111111111',
    AI_EXPECTED_MANIFEST_VERSION: 'release-1',
    AI_EXPECTED_MANIFEST_SHA256: 'a'.repeat(64),
    AI_PARTICIPANT_SLOT: 'core-analysis',
    AI_ARTIFACT_SHA256: 'b'.repeat(64),
  };
  const config = loadAIRuntimeConfig(base);
  assert.equal(config.mode, 'single');
  assert.equal(config.slot, 'core-analysis');
  assert.equal(config.hasApiKey, false, 'a disabled observer needs no key');

  for (const field of ['AI_CONTROL_DIR', 'AI_DEPLOYMENT_ID', 'AI_EXPECTED_MANIFEST_VERSION', 'AI_EXPECTED_MANIFEST_SHA256']) {
    const env = { ...base };
    delete env[field];
    assert.throws(() => loadAIRuntimeConfig(env), ConfigError, `missing ${field} must fail`);
  }
  assert.throws(() => loadAIRuntimeConfig({ ...base, AI_CONTROL_DIR: 'relative/dir' }), /absolute/);
  assert.throws(() => loadAIRuntimeConfig({ ...base, AI_DEPLOYMENT_ID: 'not-a-uuid' }), ConfigError);
  assert.throws(() => loadAIRuntimeConfig({ ...base, AI_EXPECTED_MANIFEST_SHA256: 'short' }), ConfigError);
  assert.throws(() => loadAIRuntimeConfig({ ...base, AI_ARTIFACT_SHA256: undefined }), /AI_ARTIFACT_SHA256 is required/);
  assert.throws(() => loadAIRuntimeConfig({ ...base, AI_RUNTIME_MODE: 'dual' }), ConfigError);
});

test('UAI-05A config: the Skill dispatch mode is a reviewed value, never inferred', () => {
  const base = {
    AI_RUNTIME_MODE: 'single',
    AI_CONTROL_DIR: '/tmp/ai-control',
    AI_DEPLOYMENT_ID: '11111111-1111-4111-8111-111111111111',
    AI_EXPECTED_MANIFEST_VERSION: 'release-1',
    AI_EXPECTED_MANIFEST_SHA256: 'a'.repeat(64),
  };
  // Default is the explicit migration compatibility mode.
  assert.equal(loadAIRuntimeConfig(base).skillMode, 'legacy');
  assert.equal(loadAIRuntimeConfig({ ...base, AI_SKILL_MODE: 'v2' }).skillMode, 'v2');
  assert.equal(loadAIRuntimeConfig({ ...base, AI_SKILL_MODE: ' LEGACY ' }).skillMode, 'legacy');
  // An unknown value fails closed instead of guessing a mode.
  assert.throws(() => loadAIRuntimeConfig({ ...base, AI_SKILL_MODE: 'auto' }), /AI_SKILL_MODE/);
  // The mode is part of the redacted description.
  assert.equal(describeAIRuntimeConfig(loadAIRuntimeConfig({ ...base, AI_SKILL_MODE: 'v2' })).skillMode, 'v2');
});

test('UAI-05A config: every competing identity variable is a conflict, even with an equal value', () => {
  for (const name of CONFLICTING_IDENTITY_ENV) {
    const env = {
      AI_RUNTIME_MODE: 'single',
      AI_CONTROL_DIR: '/tmp/ai-control',
      AI_DEPLOYMENT_ID: '11111111-1111-4111-8111-111111111111',
      AI_EXPECTED_MANIFEST_VERSION: 'release-1',
      AI_EXPECTED_MANIFEST_SHA256: 'a'.repeat(64),
      [name]: 'deepseek',
    };
    assert.throws(() => loadAIRuntimeConfig(env), /must be unset/, `${name} must conflict in single mode`);
  }
});

test('UAI-05A config: description is redacted', () => {
  const config = loadAIRuntimeConfig({
    AI_RUNTIME_MODE: 'single',
    AI_CONTROL_DIR: '/tmp/ai-control',
    AI_DEPLOYMENT_ID: '11111111-1111-4111-8111-111111111111',
    AI_EXPECTED_MANIFEST_VERSION: 'release-1',
    AI_EXPECTED_MANIFEST_SHA256: 'a'.repeat(64),
    AI_API_KEY: 'super-secret-sentinel',
  });
  const described = JSON.stringify(describeAIRuntimeConfig(config));
  assert.ok(!described.includes('super-secret-sentinel'));
  assert.ok(described.includes('hasApiKey'));
});

// ---------------------------------------------------------------------------
// Fixture integrity: the test double itself obeys the contract
// ---------------------------------------------------------------------------
test('UAI-05A fixtures: the synthetic release descriptor is internally consistent', () => {
  const fixture = buildReleaseFixture();
  assert.equal(fixture.descriptor.binding.manifestSha256, fixture.manifestSha256);
  assert.equal(fixture.descriptor.binding.capabilityProfileSha256, fixture.profileSha256);
  assert.equal(fixture.descriptor.binding.inventorySha256, computeInventoryDigest(fixture.inventory));
  assert.equal(fixture.descriptorSha256.length, 64);
  assert.notEqual(sha256Hex('a'), sha256Hex('b'));
});
