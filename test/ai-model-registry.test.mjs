/**
 * Tests for ai-model-registry.mjs — versioned content-addressed model registry v1.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { loadModelRegistry } from '../src/config/ai-model-registry.mjs';
import { ConfigError } from '../src/config/config-error.mjs';

describe('Valid registry parsing', () => {
  it('loads valid JSON successfully', () => {
    const json = JSON.stringify({
      schemaVersion: 1, registryId: 'test-v1',
      models: { m1: {
        providerId: 'deepseek', modelId: 'deepseek-chat',
        canonicalBaseUrl: 'https://api.deepseek.com/v1',
        capabilityProfileId: 'dp-v1',
        capabilityProfileSha256: 'a'.repeat(64),
        trustTier: 'supplementary',
      }},
      routingTable: { ANALYZE: 'm1' }, fallbacks: { ANALYZE: null },
    });
    const r = loadModelRegistry(json);
    assert.strictEqual(r.registry.schemaVersion, 1);
    assert.strictEqual(r.registry.registryId, 'test-v1');
    assert.ok(r.registry.models['m1']);
  });

  it('produces deterministic digest for same input', () => {
    const data = {
      schemaVersion: 1, registryId: 'digest-test',
      models: { x: {
        providerId: 'kimi', modelId: 'moonshot-v1',
        canonicalBaseUrl: 'https://api.moonshot.cn/v1',
        capabilityProfileId: 'km-v1',
        capabilityProfileSha256: 'b'.repeat(64), trustTier: 'informational',
      }},
      routingTable: { MONITOR: 'x' }, fallbacks: { MONITOR: null },
    };
    const r1 = loadModelRegistry(JSON.stringify(data));
    const r2 = loadModelRegistry(JSON.stringify(data));
    assert.strictEqual(r1.registry.digestSha256, r2.registry.digestSha256);
  });
});

describe('Invalid registry rejection', () => {
  it('rejects non-object input', () => {
    assert.throws(() => loadModelRegistry('not-json'), ConfigError);
  });

  it('rejects unknown top-level field', () => {
    const j = JSON.stringify({
      schemaVersion: 1, registryId: 't',
      models: {}, routingTable: {}, fallbacks: {}, _bad: 'nope',
    });
    assert.throws(() => loadModelRegistry(j), /unknown field.*_bad/);
  });

  it('rejects missing required fields', () => {
    assert.throws(() => loadModelRegistry(JSON.stringify({ schemaVersion: 1, registryId: 't' })), /missing required field/);
  });

  it('rejects wrong schema version', () => {
    const j = JSON.stringify({ schemaVersion: 99, registryId: 't', models: {}, routingTable: {}, fallbacks: {} });
    assert.throws(() => loadModelRegistry(j), /schemaVersion must be 1/);
  });

  it('rejects oversized payload (>16KB)', () => {
    const bigModels = {};
    for (let i = 0; i < 200; i++) {
      bigModels[`m-${i}`] = {
        providerId: 'deepseek', modelId: `d-${i}`,
        canonicalBaseUrl: 'https://api.deepseek.com/v1',
        capabilityProfileId: `cp-${i}`,
        capabilityProfileSha256: 'c'.repeat(64),
        trustTier: 'supplementary',
      };
    }
    const j = JSON.stringify({ schemaVersion: 1, registryId: 'big', models: bigModels, routingTable: { ANALYZE: 'm-0' }, fallbacks: { ANALYZE: null } });
    assert.throws(() => loadModelRegistry(j), /exceeds.*byte limit/);
  });

  it('rejects BOM marker', () => {
    assert.throws(() => loadModelRegistry('\uFEFF{"schemaVersion":1,"registryId":"b","models":{},"routingTable":{},"fallbacks":{}}'));
  });
});
