/**
 * Tests for ai-model-resolver.mjs — operation-to-model resolution via central registry.
 *
 * Covers: correct resolution of all 6 operations, null-fallback enforcement for
 * consequential ops, error handling for unknown operations, undefined model keys,
 * size ceiling enforcement, deterministic output.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveOperationModel, resolveOperationFallback } from '../src/ai/model-resolver.mjs';
import { CoordinationError, COORDINATION_ERROR_CODE } from '../src/errors/coordination-error.mjs';

// ─── Test data helpers ────────────────────────────────────────────────────────

/** Build a minimal valid registry for testing. */
function makeRegistry(modelKey = 'model-a', routingOverrides = {}) {
  const models = {
    [modelKey]: {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      canonicalBaseUrl: 'https://api.deepseek.com/v1',
      capabilityProfileId: 'dp-v1',
      capabilityProfileSha256: 'aa'.repeat(32),
      trustTier: 'supplementary',
    },
  };
  return Object.freeze({
    schemaVersion: 1,
    registryId: 'test-registry',
    models,
    routingTable: {
      ANALYZE: modelKey,
      SCOUT: modelKey,
      GUARD: modelKey,
      MONITOR: modelKey,
      STOPCHECK: modelKey,
      REFLECT: modelKey,
      ...routingOverrides,
    },
    fallbacks: {
      ANALYZE: null,
      SCOUT: null,
      GUARD: null,
      MONITOR: null,
      STOPCHECK: null,
      REFLECT: null,
    },
  });
}

const ALL_OPS = ['ANALYZE', 'SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT'];

// ─── Resolution Correctness Tests ─────────────────────────────────────────────

describe('resolveOperationModel — correctness', () => {
  it('resolves all six operations to their model keys', () => {
    const reg = makeRegistry();
    const resolvedModels = {};
    for (const op of ALL_OPS) {
      const result = resolveOperationModel(op, reg);
      assert.strictEqual(result.providerId, 'deepseek');
      assert.strictEqual(result.modelId, 'deepseek-chat');
      assert.strictEqual(result.canonicalBaseUrl, 'https://api.deepseek.com/v1');
      assert.strictEqual(result.trustTier, 'supplementary');
      assert.ok(result.profileDigestSha256.length === 64);
      assert.ok(result.manifestDigestSha256.length === 64);
      resolvedModels[op] = result;
    }
    // All ops resolve to same model key in this simple test
    for (const op of ALL_OPS) {
      assert.strictEqual(resolvedModels[op].manifestDigestSha256, resolvedModels.ANALYZE.manifestDigestSha256);
    }
  });

  it('produces consistent results across calls (no mutable state)', () => {
    const reg = makeRegistry();
    const r1 = resolveOperationModel('ANALYZE', reg);
    const r2 = resolveOperationModel('ANALYZE', reg);
    assert.strictEqual(JSON.stringify(r1), JSON.stringify(r2));
  });

  it('returns frozen object (immutable)', () => {
    const reg = makeRegistry();
    const result = resolveOperationModel('GUARD', reg);
    assert.strictEqual(Object.isFrozen(result), true);
  });

  it('classifies trust tiers correctly', () => {
    const reg = makeRegistry('model-conseq', { GUARD: 'model-conseq' });
    // Modify the model entry to have consequential tier
    reg.models['model-conseq'].trustTier = 'consequential';
    const guardResult = resolveOperationModel('GUARD', reg);
    assert.strictEqual(guardResult.trustTier, 'consequential');
  });
});

// ─── Error Handling Tests ─────────────────────────────────────────────────────

describe('resolveOperationModel — failure modes', () => {
  it('throws COORDINATION_ERROR when operation not in routing table', () => {
    const reg = makeRegistry('model-a', { ANALYZE: 'model-a' }); // Only ANALYZE routed
    assert.throws(() => resolveOperationModel('UNKNOWN_OP', reg), CoordinationError);
  });

  it('throws when routing references undefined model key', () => {
    const reg = makeRegistry('model-a', { SCOUT: 'nonexistent-key' });
    assert.throws(() => resolveOperationModel('SCOUT', reg), CoordinationError);
  });

  it('provides meaningful error code for unresolved operations', () => {
    // Build registry where ONLY ANALYZE has a route; GUARD is missing from routingTable
    const reg = makeRegistry();
    // Override to remove GUARD from routingTable
    const partialReg = Object.freeze({
      ...reg,
      routingTable: { ANALYZE: 'model-a', SCOUT: 'model-a' }, // NO GUARD entry
      fallbacks: { ANALYZE: null, SCOUT: null },
    });
    let caught = null;
    try { resolveOperationModel('GUARD', partialReg); } catch (e) { caught = e; }
    assert.ok(caught instanceof CoordinationError);
    // Slot not admitted is the expected code when operation isn't in routing table
    assert.strictEqual(caught.code, COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED);
  });
});

// ─── Fallback Resolution Tests ────────────────────────────────────────────────

describe('resolveOperationFallback — behavior', () => {
  it('returns null for null fallback entries', () => {
    const reg = makeRegistry();
    assert.strictEqual(resolveOperationFallback('ANALYZE', reg), null);
  });

  it('allows supplementary operations to have non-null fallback', () => {
    const reg = makeRegistry('primary', { SCOUT: 'primary' });
    const withFallback = Object.freeze({
      ...reg,
      fallbacks: { ...reg.fallbacks, SCOUT: 'monitor-backup' },
      models: {
        ...reg.models,
        'monitor-backup': {
          providerId: 'deepseek',
          modelId: 'deepseek-r1',
          canonicalBaseUrl: 'https://api.deepseek.com/v1',
          capabilityProfileId: 'dp-r1',
          capabilityProfileSha256: 'bb'.repeat(32),
          trustTier: 'informational',
        },
      },
    });
    const fb = resolveOperationFallback('SCOUT', withFallback);
    assert.strictEqual(fb, 'monitor-backup');
  });

  it('rejects non-null fallback for consequential operations', () => {
    const reg = makeRegistry('opus', { ANALYZE: 'opus' });
    const withConseqFb = Object.freeze({
      ...reg,
      models: {
        ...reg.models,
        'backup-opus': reg.models['opus'], // same model as backup
      },
      fallbacks: { ...reg.fallbacks, ANALYZE: 'backup-opus' },
    });
    // Should throw because consequential ops MUST have null fallback
    let caught = null;
    try { resolveOperationFallback('ANALYZE', withConseqFb); } catch (e) { caught = e; }
    assert.ok(caught instanceof CoordinationError);
    assert.strictEqual(caught.code, COORDINATION_ERROR_CODE.CONFIGURATION_ERROR);
  });
});

// ─── Size Ceiling Test ────────────────────────────────────────────────────────

describe('Size constraints', () => {
  it('resolves normal-sized identity without issue', () => {
    const reg = makeRegistry();
    const result = resolveOperationModel('ANALYZE', reg);
    assert.ok(JSON.stringify(result).length < 8 * 1024); // Under 8KB limit
  });
});
