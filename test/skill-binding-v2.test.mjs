/**
 * SKILL-04 / SKILL-07 — joint Skill + Model binding v2, generation change and
 * migration/rollback rules (architecture v1.1 §7, §10; AC-06, AC-09, AC-15).
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  BINDING_V2_FIELDS,
  bindingComparisonFields,
  bindingSchemaVersion,
  computeBindingV2Sha256,
  createBindingV2,
  validateBindingV2,
  validateControlRecord,
  validateControlRecordV2,
  validateReleaseDescriptor,
  computeReleaseDescriptorDigest,
} from '../src/config/ai-release-schema.mjs';
import {
  computeExecutionPlanDigest,
  computeModelIdentitySha256,
  computeRuntimePolicyDigest,
  computeSkillRegistryDigest,
  validateExecutionPlan,
  validateRuntimePolicy,
  validateSkillRegistry,
} from '../src/config/skill-release-contracts.mjs';
import {
  assertRollbackIsHigherGeneration,
  assertRollbackPackagesAvailable,
  assessMigration,
  buildMigratedRecord,
  describeRollbackDelta,
} from '../src/ai/skills/migration.mjs';
import { AI_OPERATIONS } from '../src/ai/operation-profiles.mjs';
import { SKILL_STORE_LAYOUT } from '../src/ai/skills/package-store.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixture, patchPackageFiles } from './fixtures/skills/factory.mjs';
import { activateFixture, buildReleaseFixture } from './fixtures/ai-release/factory.mjs';

const digest = (character) => character.repeat(64);

/** A complete v2 binding body built from a real release fixture. */
function bindingBody(fixture, overrides = {}) {
  return {
    schemaVersion: 2,
    manifestVersion: fixture.binding.manifestVersion,
    manifestSha256: fixture.binding.manifestSha256,
    capabilityProfileSha256: fixture.binding.capabilityProfileSha256,
    inventorySha256: fixture.binding.inventorySha256,
    artifactSetSha256: fixture.binding.artifactSetSha256,
    modelRegistrySha256: digest('1'),
    skillRegistrySha256: digest('2'),
    executionPlanSha256: digest('3'),
    runtimePolicySha256: digest('4'),
    ...overrides,
  };
}

function bindingOf(fixture, overrides) {
  const body = bindingBody(fixture, overrides);
  return { ...body, bindingSha256: computeBindingV2Sha256(body) };
}

describe('Binding v2 identity (AC-06)', () => {
  test('the binding digest covers model registry, skill registry, plan and policy', () => {
    const fixture = buildReleaseFixture();
    try {
      const base = bindingOf(fixture);
      assert.deepEqual(Object.keys(base).sort(), [...BINDING_V2_FIELDS].sort());
      assert.equal(validateBindingV2(base).bindingSha256, base.bindingSha256);
      assert.equal(bindingSchemaVersion(base), 2);
      assert.equal(bindingComparisonFields(base).includes('bindingSha256'), true);

      for (const field of ['modelRegistrySha256', 'skillRegistrySha256', 'executionPlanSha256', 'runtimePolicySha256', 'manifestSha256', 'artifactSetSha256']) {
        const changed = bindingOf(fixture, { [field]: digest('f') });
        assert.notEqual(changed.bindingSha256, base.bindingSha256, `changing ${field} must change the joint binding`);
      }
      // The v1 five-field hash is unchanged for a v1 binding: no legacy digest
      // algorithm was rewritten.
      assert.equal(bindingSchemaVersion(fixture.binding), 1);
      assert.equal(bindingComparisonFields(fixture.binding).length, 5);
    } finally {
      fs.rmSync(fixture.controlDir, { recursive: true, force: true });
    }
  });

  test('a binding whose digest does not hash its body is refused', () => {
    const fixture = buildReleaseFixture();
    try {
      const base = bindingOf(fixture);
      assert.throws(() => validateBindingV2({ ...base, bindingSha256: digest('0') }), /does not hash its own body/);
      assert.throws(() => validateBindingV2({ ...base, extra: 1 }), /unknown field|unexpected field/);
      const { bindingSha256, ...rest } = base;
      void bindingSha256;
      assert.throws(() => validateBindingV2(rest), /missing field|unexpected/);
      assert.throws(() => validateBindingV2({ ...base, schemaVersion: 1 }), /schemaVersion/);
    } finally {
      fs.rmSync(fixture.controlDir, { recursive: true, force: true });
    }
  });

  test('createBindingV2 derives every field from verified components', () => {
    const fixture = buildReleaseFixture();
    try {
      const binding = createBindingV2({
        manifest: fixture.manifest,
        manifestSha256: fixture.manifestSha256,
        profileSha256: fixture.profileSha256,
        inventory: fixture.inventory,
        artifacts: fixture.artifacts,
        observers: fixture.observers,
        modelRegistrySha256: digest('a'),
        skillRegistrySha256: digest('b'),
        executionPlanSha256: digest('c'),
        runtimePolicySha256: digest('d'),
      });
      assert.equal(binding.schemaVersion, 2);
      const { bindingSha256, ...body } = binding;
      assert.equal(bindingSha256, computeBindingV2Sha256(body));
      assert.equal(binding.inventorySha256, fixture.binding.inventorySha256);
      assert.equal(binding.artifactSetSha256, fixture.binding.artifactSetSha256);
    } finally {
      fs.rmSync(fixture.controlDir, { recursive: true, force: true });
    }
  });

  test('a v2 control record binds a v2 binding; a v1 record still validates', () => {
    const fixture = buildReleaseFixture();
    try {
      const record = fixture.store.tryReadRecord() ?? fixture.store.initialize({ inventory: fixture.inventory }).record;
      assert.equal(validateControlRecord(record).schemaVersion, 1);

      const binding = bindingOf(fixture);
      const v2 = validateControlRecordV2({
        ...record,
        schemaVersion: 2,
        active: binding,
        phase: 'ACTIVE',
        releaseDescriptorSha256: fixture.descriptorSha256,
      });
      assert.equal(v2.schemaVersion, 2);
      assert.equal(v2.active.bindingSha256, binding.bindingSha256);

      // A v2 record may not carry a v1 binding, and a v1 record may not carry v2.
      assert.throws(() => validateControlRecord({ ...record, schemaVersion: 2, active: fixture.binding }), /schemaVersion|binding/);
      assert.throws(() => validateControlRecordV2(record), /schemaVersion 2/);
    } finally {
      fs.rmSync(fixture.controlDir, { recursive: true, force: true });
    }
  });

  test('a v2 release descriptor commits the six approvals and the plan approval', () => {
    const fixture = buildReleaseFixture();
    try {
      const skillApprovalRefs = Object.fromEntries(
        AI_OPERATIONS.map((operation) => [operation, { packageDigestSha256: digest('a'), attestationSha256: digest('b') }]),
      );
      const descriptor = {
        schemaVersion: 2,
        binding: bindingOf(fixture),
        inventory: fixture.inventory,
        artifacts: fixture.artifacts,
        observers: fixture.observers,
        approvalId: 'approval-v2',
        skillApprovalRefs,
        planApprovalRef: digest('c'),
      };
      const validated = validateReleaseDescriptor(descriptor);
      assert.equal(validated.schemaVersion, 2);
      const descriptorDigest = computeReleaseDescriptorDigest(validated);

      const swapped = validateReleaseDescriptor({
        ...descriptor,
        skillApprovalRefs: {
          ...skillApprovalRefs,
          REFLECT: { packageDigestSha256: digest('d'), attestationSha256: digest('b') },
        },
      });
      assert.notEqual(computeReleaseDescriptorDigest(swapped), descriptorDigest, 'an approval cannot be swapped after the fact');

      assert.throws(() => validateReleaseDescriptor({ ...descriptor, skillApprovalRefs: { REFLECT: skillApprovalRefs.REFLECT } }), /missing field|unexpected/);
      assert.throws(() => validateReleaseDescriptor({ ...descriptor, planApprovalRef: null }), /planApprovalRef/);
    } finally {
      fs.rmSync(fixture.controlDir, { recursive: true, force: true });
    }
  });
});

describe('Skill and model changes require a new plan and binding (AC-06)', () => {
  test('changing one skill package changes the registry, the plan and the binding', () => {
    const first = buildFixture();
    const second = buildFixture({
      packageMutator: ({ operation, files }) =>
        operation === 'REFLECT'
          ? patchPackageFiles(files, { raw: { 'instructions.md': `${files.find((file) => file.path === 'instructions.md').bytes.toString('utf8')}\nAlways answer with low severity.\n` } })
          : files,
    });
    try {
      const planA = first.preparePlan();
      const planB = second.preparePlan();
      assert.notEqual(first.packages.REFLECT.digest, second.packages.REFLECT.digest);
      assert.notEqual(first.skillRegistrySha256, second.skillRegistrySha256, 'a skill change moves the registry digest');
      assert.notEqual(planA.planSha256, planB.planSha256, 'a skill change moves the execution plan digest');
      assert.equal(first.modelRegistrySha256, second.modelRegistrySha256, 'the model registry is untouched by a skill-only change');
      // The runtime policy digest includes the deployment trust roots, which the
      // fixture generates per instance; only the skill side is compared here.

      // Unchanged operations keep their plan entry; the changed one does not.
      for (const operation of AI_OPERATIONS) {
        const changed = operation === 'REFLECT';
        assert.equal(
          planA.plan.operations[operation].skill.packageDigestSha256 === planB.plan.operations[operation].skill.packageDigestSha256,
          !changed,
          `${operation} skill identity`,
        );
        if (!changed) {
          assert.equal(planA.plan.operations[operation].modelIdentitySha256, planB.plan.operations[operation].modelIdentitySha256);
        }
      }
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test('changing one model registry route moves the plan without touching skill packages', () => {
    const first = buildFixture();
    const second = buildFixture({
      evidenceMutator: (evidence) => ({ ...evidence, maxOutputTokens: 8192 }),
    });
    try {
      const planA = first.preparePlan();
      const planB = second.preparePlan();
      assert.equal(first.skillRegistrySha256, second.skillRegistrySha256, 'a model change keeps skill identity');
      assert.notEqual(planA.planSha256, planB.planSha256);
      for (const operation of AI_OPERATIONS) {
        assert.equal(
          planA.plan.operations[operation].skill.packageDigestSha256,
          planB.plan.operations[operation].skill.packageDigestSha256,
        );
        assert.notEqual(planA.plan.operations[operation].capabilityEvidenceSha256, planB.plan.operations[operation].capabilityEvidenceSha256);
      }
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test('every operation plan entry commits its skill digest and model identity', () => {
    const fx = buildFixture();
    try {
      const planResult = fx.preparePlan();
      const plan = planResult.plan;
      assert.equal(plan.schemaVersion, 1);
      assert.equal(computeExecutionPlanDigest(validateExecutionPlan(plan)), planResult.planSha256);
      for (const operation of AI_OPERATIONS) {
        const entry = plan.operations[operation];
        assert.equal(entry.operation, operation);
        assert.equal(entry.skill.packageDigestSha256, fx.packages[operation].digest);
        assert.match(entry.modelIdentitySha256, /^[0-9a-f]{64}$/);
        assert.match(entry.profileSha256, /^[0-9a-f]{64}$/);
        assert.match(entry.settingsSha256, /^[0-9a-f]{64}$/);
        assert.match(entry.effectivePolicySha256, /^[0-9a-f]{64}$/);
        assert.equal(entry.adapterContractVersion, 1);
      }
      assert.equal(new Set(AI_OPERATIONS.map((operation) => plan.operations[operation].modelIdentitySha256)).size, 6);
      assert.equal(computeRuntimePolicyDigest(validateRuntimePolicy(fx.runtimePolicy)), fx.runtimePolicySha256);
      assert.equal(computeSkillRegistryDigest(validateSkillRegistry(fx.store.readRegistry(fx.skillRegistrySha256))), fx.skillRegistrySha256);
    } finally {
      fx.cleanup();
    }
  });

  test('a model identity digest covers provider, model, endpoint, tier and profile', () => {
    const base = {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      canonicalBaseUrl: 'https://api.deepseek.com/v1',
      trustTier: 'supplementary',
      capabilityProfileSha256: digest('a'),
    };
    const digestOf = computeModelIdentitySha256(base);
    assert.match(digestOf, /^[0-9a-f]{64}$/);
    assert.notEqual(computeModelIdentitySha256({ ...base, modelId: 'deepseek-reasoner' }), digestOf);
    assert.notEqual(computeModelIdentitySha256({ ...base, canonicalBaseUrl: 'https://api.moonshot.cn/v1' }), digestOf);
    assert.notEqual(computeModelIdentitySha256({ ...base, capabilityProfileSha256: digest('b') }), digestOf);
  });
});

describe('Migration and rollback (AC-09, AC-15)', () => {
  test('only a paused or quiescing v1 record may be converted, and conversion lands PAUSED', () => {
    const fixture = buildReleaseFixture();
    try {
      const record = fixture.store.tryReadRecord() ?? fixture.store.initialize({ inventory: fixture.inventory }).record;
      assert.deepEqual(assessMigration(record), { eligible: true, reason: null });

      const migrated = buildMigratedRecord(record, { operatorApprovalId: 'operator-1' });
      assert.equal(migrated.schemaVersion, 2);
      assert.equal(migrated.phase, 'PAUSED');
      assert.equal(migrated.active, null);
      assert.equal(migrated.target, null);
      assert.equal(migrated.generation, record.generation);
      assert.equal(migrated.highWaterGeneration, record.highWaterGeneration);
      assert.equal(migrated.revision, record.revision + 1);
      assert.deepEqual(migrated.inventory, record.inventory);
      assert.equal(migrated.releaseDescriptorSha256, record.releaseDescriptorSha256, 'the prior descriptor stays as audit evidence');

      assert.equal(assessMigration(migrated).eligible, false);
      assert.equal(assessMigration({ ...record, phase: 'ACTIVE' }).reason, 'ACTIVE_REQUIRES_QUIESCE');
      assert.equal(assessMigration({ ...record, phase: 'PREPARING' }).reason, 'TRANSITION_IN_PROGRESS');
      assert.equal(assessMigration(null).reason, 'NO_CONTROL_RECORD');
      assert.throws(() => buildMigratedRecord({ ...record, phase: 'ACTIVE' }, { operatorApprovalId: 'op' }), /not migratable/);
    } finally {
      fs.rmSync(fixture.controlDir, { recursive: true, force: true });
    }
  });

  test('the migrated record never admits inference: it is PAUSED and unbound', async () => {
    const fixture = buildReleaseFixture();
    try {
      const record = fixture.store.tryReadRecord() ?? fixture.store.initialize({ inventory: fixture.inventory }).record;
      const migrated = buildMigratedRecord(record, { operatorApprovalId: 'operator-1' });
      assert.equal(migrated.phase, 'PAUSED');
      assert.ok(migrated.active === null && migrated.target === null);
      assert.equal(migrated.transitionId, null);
    } finally {
      fs.rmSync(fixture.controlDir, { recursive: true, force: true });
    }
  });

  test('a v2 deployment cannot be read by a legacy-only process', async () => {
    const { resolveRuntimeMode } = await import('../src/ai/skills/composition.mjs');
    assert.equal(resolveRuntimeMode({ configuredMode: 'legacy', controlRecord: { schemaVersion: 1 } }), 'legacy');
    assert.throws(() => resolveRuntimeMode({ configuredMode: 'legacy', controlRecord: { schemaVersion: 2 } }), /legacy compatibility/);
    assert.equal(resolveRuntimeMode({ configuredMode: 'v2', controlRecord: { schemaVersion: 2 } }), 'v2');
    assert.throws(() => resolveRuntimeMode({ configuredMode: 'v2', controlRecord: null }), /schemaVersion 2/);
    assert.throws(() => resolveRuntimeMode({ configuredMode: 'auto', controlRecord: null }), /never inferred/);
  });

  test('rollback requires a strictly higher generation and recoverable packages', () => {
    const fx = buildFixture();
    try {
      assert.doesNotThrow(() => assertRollbackIsHigherGeneration({ currentGeneration: 3, targetGeneration: 4 }));
      assert.throws(() => assertRollbackIsHigherGeneration({ currentGeneration: 3, targetGeneration: 3 }), /strictly higher/);
      assert.throws(() => assertRollbackIsHigherGeneration({ currentGeneration: 4, targetGeneration: 3 }), /strictly higher/);

      const registry = fx.store.readRegistry(fx.skillRegistrySha256);
      assert.doesNotThrow(() => assertRollbackPackagesAvailable({ store: fx.store, skillRegistry: registry, trustRoots: fx.trustRoots }));

      // Removing an approved package makes the pair unrecoverable.
      fs.rmSync(path.join(fx.store.rootDir, SKILL_STORE_LAYOUT.packages, fx.packages.MONITOR.digest), { recursive: true, force: true });
      assert.throws(() => assertRollbackPackagesAvailable({ store: fx.store, skillRegistry: registry, trustRoots: fx.trustRoots }), /cannot be reconstructed/);
    } finally {
      fx.cleanup();
    }
  });

  test('a revoked package can never be restored by a rollback', () => {
    const fx = buildFixture({ revokeOperation: 'REFLECT' });
    try {
      const registry = fx.store.readRegistry(fx.skillRegistrySha256);
      assert.throws(
        () => assertRollbackPackagesAvailable({ store: fx.store, skillRegistry: registry, trustRoots: fx.trustRoots }),
        (error) => error.code === 'SKILL_REVOKED',
      );
    } finally {
      fx.cleanup();
    }
  });

  test('the rollback delta names what changed', () => {
    assert.deepEqual(describeRollbackDelta({
      current: { skillRegistrySha256: 'a', modelRegistrySha256: 'b' },
      target: { skillRegistrySha256: 'a', modelRegistrySha256: 'c' },
    }), { skillChanged: false, modelChanged: true });
    assert.deepEqual(describeRollbackDelta({
      current: { skillRegistrySha256: 'a', modelRegistrySha256: 'b' },
      target: { skillRegistrySha256: 'z', modelRegistrySha256: 'b' },
    }), { skillChanged: true, modelChanged: false });
  });
});

describe('Cross-process consistency (AC-07)', () => {
  test('two independent readers of the same store agree on every identity digest', async () => {
    const fx = buildFixture();
    try {
      const { createSkillPackageStore } = await import('../src/ai/skills/package-store.mjs');
      const { prepareExecutionPlan } = await import('../src/ai/skills/execution-plan.mjs');
      const secondStore = createSkillPackageStore({ rootDir: fx.rootDir });
      const planA = fx.preparePlan();
      const planB = prepareExecutionPlan({
        store: secondStore,
        skillRegistrySha256: fx.skillRegistrySha256,
        modelRegistrySha256: fx.modelRegistrySha256,
        runtimePolicySha256: fx.runtimePolicySha256,
        artifact: fx.artifact,
        profileReader: fx.profileReader,
      });
      assert.equal(planA.planSha256, planB.planSha256);
      assert.deepEqual(
        [...planA.prepared.keys()].sort(),
        [...planB.prepared.keys()].sort(),
      );
      for (const operation of AI_OPERATIONS) {
        assert.equal(
          planA.prepared.get(operation).skill.packageDigestSha256,
          planB.prepared.get(operation).skill.packageDigestSha256,
        );
        assert.equal(
          planA.prepared.get(operation).modelIdentitySha256,
          planB.prepared.get(operation).modelIdentitySha256,
        );
      }
    } finally {
      fx.cleanup();
    }
  });

  test('a package replaced on disk between two readers is refused by the second', async () => {
    const fx = buildFixture();
    try {
      const { createSkillPackageStore } = await import('../src/ai/skills/package-store.mjs');
      const { resolvePreparedSkill } = await import('../src/ai/skills/resolver.mjs');
      const { ADAPTERS } = await import('../src/ai/skills/adapters/catalogue.mjs');
      const first = createSkillPackageStore({ rootDir: fx.rootDir });
      const registry = first.readRegistry(fx.skillRegistrySha256);
      const policy = first.readRuntimePolicy(fx.runtimePolicySha256);
      const trustRoots = first.readTrustRoots(fx.runtimePolicy.trustRootsSha256);
      const preparedA = resolvePreparedSkill({ operation: 'REFLECT', registry, store: first, policy, artifact: fx.artifact, adapter: ADAPTERS.REFLECT, trustRoots });
      assert.equal(preparedA.skill.packageDigestSha256, fx.packages.REFLECT.digest);

      fs.appendFileSync(
        path.join(fx.rootDir, SKILL_STORE_LAYOUT.packages, fx.packages.REFLECT.digest, 'payload', 'instructions.md'),
        '\ntampered by another process\n',
      );
      const second = createSkillPackageStore({ rootDir: fx.rootDir });
      assert.throws(
        () => resolvePreparedSkill({ operation: 'REFLECT', registry, store: second, policy, artifact: fx.artifact, adapter: ADAPTERS.REFLECT, trustRoots }),
        (error) => error.code === 'SKILL_INTEGRITY_MISMATCH',
      );
    } finally {
      fx.cleanup();
    }
  });

  test('activation fences a conflicting instance of the same slot', async () => {
    const fixture = buildReleaseFixture();
    try {
      activateFixture(fixture);
      const { createGenerationGuard } = await import('../src/ai/coordination/generation-guard.mjs');
      const { guardConfigFor } = await import('./fixtures/ai-release/factory.mjs');
      const guard = createGenerationGuard({
        controlStore: fixture.store,
        config: guardConfigFor(fixture, 'core-analysis'),
        instanceId: 'inst-other',
        runtimeFactory: () => {
          throw new Error('must not build a runtime for a fenced instance');
        },
      });
      const status = guard.start();
      assert.equal(status.identityReady, false);
      assert.equal(status.errorCode, 'SLOT_CONFLICT');
    } finally {
      fs.rmSync(fixture.controlDir, { recursive: true, force: true });
    }
  });
});
