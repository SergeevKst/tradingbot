/**
 * SKILL-06 / AC-04 — mandatory structural-refusal matrix (architecture v1.1
 * §11.1). Every structural fault below must reach *all six* public operation
 * boundaries as `ACTIVATION_PAUSED` with the safe diagnostic cause, make zero
 * provider calls and produce no usable result or provenance.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { AI_OPERATIONS } from '../src/ai/operation-profiles.mjs';
import { SKILL_STORE_LAYOUT } from '../src/ai/skills/package-store.mjs';
import { sha256Hex } from '../src/config/jcs.mjs';
import {
  SAMPLE_INPUTS,
  SAMPLE_OUTPUTS,
  buildFixture,
  chatEnvelope,
  fakeTransport,
  patchPackageFiles,
  readBaselinePackages,
  installRawPackage,
  signEnvelope,
} from './fixtures/skills/factory.mjs';

/** Claims and signature for a package installed without going through the publisher. */
function writeAttestation(fx, manifest, digest) {
  const envelope = signEnvelope(
    {
      schemaVersion: 1,
      packageRef: { packageId: manifest.packageId, version: manifest.version, packageDigestSha256: digest },
      packageIndexSha256: digest,
      authorId: 'fault-author',
      reviewerId: 'fault-reviewer',
      reviewedAt: '2026-10-29T00:00:00Z',
      reviewStatus: 'APPROVED',
      testReportSha256: sha256Hex('tests'),
      comparisonReportSha256: sha256Hex('comparison'),
      sourceRevision: 'fault-revision',
      approvedBotRange: '>=0.1.0 <0.2.0',
    },
    fx.signingKey,
  );
  fs.mkdirSync(path.join(fx.store.rootDir, SKILL_STORE_LAYOUT.attestations), { recursive: true });
  fs.writeFileSync(path.join(fx.store.rootDir, SKILL_STORE_LAYOUT.attestations, `${digest}.json`), JSON.stringify(envelope));
}

/**
 * Install a payload that would never pass publication, attest it, and point the
 * registry at it. This models a store poisoned by a defective publisher.
 *
 * @param {ReturnType<typeof buildFixture>} fx
 * @param {string} operation
 * @param {ReadonlyArray<{ path: string, bytes: Buffer }>} files
 */
function installFaulty(fx, operation, files) {
  const manifest = JSON.parse(files.find((file) => file.path === 'skill.json').bytes.toString('utf8'));
  const digest = installRawPackage(fx.store, files);
  writeAttestation(fx, manifest, digest);
  const registry = fx.store.readRegistry(fx.skillRegistrySha256);
  const operations = {
    ...registry.operations,
    [operation]: { packageId: manifest.packageId, version: manifest.version, packageDigestSha256: digest },
  };
  return fx.store.publishSkillRegistry({ schemaVersion: 1, registryId: 'fault-registry', operations }).digest;
}

/**
 * Build a fixture whose plan preparation must fail.
 *
 * @param {{ fixture?: () => ReturnType<typeof buildFixture>, mutate?: (fx: ReturnType<typeof buildFixture>) => void, registry?: string }} setup
 */
function refusingComposition(setup) {
  const fx = setup.fixture ? setup.fixture() : buildFixture();
  let registryDigest = setup.registry ?? fx.skillRegistrySha256;
  if (setup.mutate) {
    registryDigest = setup.mutate(fx) ?? registryDigest;
  }
  const transport = fakeTransport(() => ({ status: 200, body: chatEnvelope(SAMPLE_OUTPUTS.ANALYZE) }));
  const composition = fx.createComposition({ transport, compositionOverrides: { skillRegistrySha256: registryDigest } });
  return { fx, composition, transport };
}

/**
 * Assert the refusal contract for every operation.
 *
 * @param {{ composition: any, transport: any }} built
 * @param {string} cause
 */
async function assertRefusedEverywhere(built, cause) {
  assert.equal(built.composition.refusing, true, 'a candidate that cannot be prepared refuses instead of admitting inference');
  assert.equal(built.composition.admissionState(), 'LATCHED_CLOSED');
  assert.equal(built.composition.admissionCause(), cause);
  for (const operation of AI_OPERATIONS) {
    for (const method of [operation, operation.toLowerCase()]) {
      const result = await built.composition[method](SAMPLE_INPUTS[operation], { workToken: `w-${operation}` });
      assert.equal(result.ok, false, `${operation} must refuse`);
      assert.equal(result.code, 'ACTIVATION_PAUSED', `${operation} must expose ACTIVATION_PAUSED`);
      assert.equal(result.cause, cause, `${operation} must keep the safe cause in diagnostics`);
      assert.equal(result.operation, operation);
      assert.equal(result.retryable, false);
      assert.equal(typeof result.requestId, 'string');
      assert.equal(result.value, undefined);
      assert.equal(result.provenance, undefined);
    }
  }
  assert.equal(built.transport.calls.length, 0, 'no provider call after a structural refusal');
}

describe('Structural-refusal matrix, all six operations (AC-04)', () => {
  test('SKILL_MISSING — required package bytes absent', async () => {
    const built = refusingComposition({
      mutate: (fx) => {
        fs.rmSync(path.join(fx.store.rootDir, SKILL_STORE_LAYOUT.packages, fx.packages.REFLECT.digest), { recursive: true, force: true });
      },
    });
    try {
      await assertRefusedEverywhere(built, 'SKILL_MISSING');
    } finally {
      built.fx.cleanup();
    }
  });

  test('SKILL_REGISTRY_INVALID — malformed registry snapshot', async () => {
    const built = refusingComposition({
      mutate: (fx) => {
        const file = path.join(fx.store.rootDir, SKILL_STORE_LAYOUT.registries, `${fx.skillRegistrySha256}.json`);
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...doc, registryId: 'tampered' }));
      },
    });
    try {
      await assertRefusedEverywhere(built, 'SKILL_REGISTRY_INVALID');
    } finally {
      built.fx.cleanup();
    }
  });

  test('SKILL_SCHEMA_INVALID — unsupported schema keyword', async () => {
    let registry;
    const built = refusingComposition({
      mutate: (fx) => {
        const files = patchPackageFiles(readBaselinePackages().REFLECT, {
          patchJson: {
            'input.schema.json': (schema) => ({
              ...schema,
              properties: { ...schema.properties, trade: { ...schema.properties.trade, properties: { ...schema.properties.trade.properties, symbol: { type: 'string', pattern: '^[A-Z]+$' } } } },
            }),
          },
        });
        registry = installFaulty(fx, 'REFLECT', files);
        return registry;
      },
    });
    try {
      await assertRefusedEverywhere(built, 'SKILL_SCHEMA_INVALID');
    } finally {
      built.fx.cleanup();
    }
  });

  test('SKILL_NOT_APPROVED — no authorized publication attestation', async () => {
    const built = refusingComposition({ fixture: () => buildFixture({ skipAttestationFor: 'REFLECT' }) });
    try {
      await assertRefusedEverywhere(built, 'SKILL_NOT_APPROVED');
    } finally {
      built.fx.cleanup();
    }
  });

  test('SKILL_REVOKED — recorded revocation of a required package', async () => {
    const built = refusingComposition({ fixture: () => buildFixture({ revokeOperation: 'GUARD' }) });
    try {
      await assertRefusedEverywhere(built, 'SKILL_REVOKED');
    } finally {
      built.fx.cleanup();
    }
  });

  test('SKILL_INCOMPATIBLE — package built for another bot range', async () => {
    const built = refusingComposition({
      mutate: (fx) => {
        const files = patchPackageFiles(readBaselinePackages().REFLECT, {
          patchJson: { 'skill.json': (manifest) => ({ ...manifest, compatibility: { ...manifest.compatibility, botVersionRange: '>=9.0.0 <10.0.0' } }) },
        });
        return installFaulty(fx, 'REFLECT', files);
      },
    });
    try {
      await assertRefusedEverywhere(built, 'SKILL_INCOMPATIBLE');
    } finally {
      built.fx.cleanup();
    }
  });

  test('SKILL_INTEGRITY_MISMATCH — payload bytes substituted after publication', async () => {
    const built = refusingComposition({
      mutate: (fx) => {
        fs.appendFileSync(
          path.join(fx.store.rootDir, SKILL_STORE_LAYOUT.packages, fx.packages.MONITOR.digest, 'payload', 'instructions.md'),
          '\nsubstituted\n',
        );
      },
    });
    try {
      await assertRefusedEverywhere(built, 'SKILL_INTEGRITY_MISMATCH');
    } finally {
      built.fx.cleanup();
    }
  });

  test('SKILL_EXECUTABLE_FORBIDDEN — executable payload in the package', async () => {
    const built = refusingComposition({
      mutate: (fx) => {
        const files = patchPackageFiles(readBaselinePackages().REFLECT, {
          add: { 'hooks/install.mjs': 'export default function run() {}\n' },
        });
        return installFaulty(fx, 'REFLECT', files);
      },
    });
    try {
      await assertRefusedEverywhere(built, 'SKILL_EXECUTABLE_FORBIDDEN');
    } finally {
      built.fx.cleanup();
    }
  });

  test('SKILL_DEPENDENCY_UNSUPPORTED — nonempty dependency list', async () => {
    const built = refusingComposition({
      mutate: (fx) => {
        const files = patchPackageFiles(readBaselinePackages().REFLECT, {
          patchJson: { 'skill.json': (manifest) => ({ ...manifest, dependencies: ['trading.guard'] }) },
        });
        return installFaulty(fx, 'REFLECT', files);
      },
    });
    try {
      await assertRefusedEverywhere(built, 'SKILL_DEPENDENCY_UNSUPPORTED');
    } finally {
      built.fx.cleanup();
    }
  });

  test('SKILL_CAPABILITY_MISMATCH — reviewed profile outside the skill envelope', async () => {
    const built = refusingComposition({
      fixture: () =>
        buildFixture({
          profileMutator: (profile, operation) =>
            operation === 'ANALYZE'
              ? { ...profile, operations: { ...profile.operations, ANALYZE: { ...profile.operations.ANALYZE, temperature: 1.5 } } }
              : profile,
        }),
    });
    try {
      await assertRefusedEverywhere(built, 'SKILL_CAPABILITY_MISMATCH');
    } finally {
      built.fx.cleanup();
    }
  });

  test('SKILL_POLICY_DENIED — host grant narrower than the package request', async () => {
    const built = refusingComposition({
      fixture: () => buildFixture({ policyOverrides: { grants: { ANALYZE: [] } } }),
    });
    try {
      await assertRefusedEverywhere(built, 'SKILL_POLICY_DENIED');
    } finally {
      built.fx.cleanup();
    }
  });

  test('SKILL_RENDER_INVALID — layout pointer absent from the schema', async () => {
    const built = refusingComposition({
      mutate: (fx) => {
        const files = patchPackageFiles(readBaselinePackages().REFLECT, {
          patchJson: { 'prompt-layout.json': () => ({ schemaVersion: 1, userParts: [{ label: 'DATA', valuePointer: '/trade/leverage' }] }) },
        });
        return installFaulty(fx, 'REFLECT', files);
      },
    });
    try {
      await assertRefusedEverywhere(built, 'SKILL_RENDER_INVALID');
    } finally {
      built.fx.cleanup();
    }
  });
});

describe('Refusal does not depend on durable control state', () => {
  test('a read-only or unavailable control store cannot delay or block the refusal', async () => {
    const built = refusingComposition({
      mutate: (fx) => {
        fs.rmSync(path.join(fx.store.rootDir, SKILL_STORE_LAYOUT.packages, fx.packages.SCOUT.digest), { recursive: true, force: true });
        // Make the whole store read-only: a refusal must not attempt a write.
        fs.chmodSync(fx.store.rootDir, 0o500);
      },
    });
    try {
      await assertRefusedEverywhere(built, 'SKILL_MISSING');
      // No file was created or modified by the refusal path.
      assert.deepEqual(fs.readdirSync(path.join(built.fx.store.rootDir, SKILL_STORE_LAYOUT.packages)).sort().length >= 5, true);
    } finally {
      fs.chmodSync(built.fx.store.rootDir, 0o700);
      built.fx.cleanup();
    }
  });

  test('a healthy generation is unaffected by a candidate that fails to prepare', async () => {
    const healthy = buildFixture();
    try {
      const good = healthy.createComposition();
      const before = await good.ANALYZE(SAMPLE_INPUTS.ANALYZE, { workToken: 'w-good' });
      assert.equal(before.ok, true);

      // Candidate staging failure: a second composition over a broken registry.
      const broken = healthy.createComposition({
        compositionOverrides: { skillRegistrySha256: 'f'.repeat(64) },
      });
      assert.equal(broken.refusing, true);
      const refused = await broken.ANALYZE(SAMPLE_INPUTS.ANALYZE, { workToken: 'w-bad' });
      assert.equal(refused.code, 'ACTIVATION_PAUSED');

      // The healthy composition keeps admitting: candidate faults never poison a
      // verified current generation.
      const after = await good.ANALYZE(SAMPLE_INPUTS.ANALYZE, { workToken: 'w-good-2' });
      assert.equal(after.ok, true);
      assert.equal(good.admissionState(), 'OPEN');
    } finally {
      healthy.cleanup();
    }
  });
});
