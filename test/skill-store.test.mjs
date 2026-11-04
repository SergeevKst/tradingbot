/**
 * SKILL-03 — immutable CAS, publication approval, revocation and read-time
 * integrity (architecture v1.1 §7.2; acceptance criteria AC-02, AC-11).
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  SKILL_STORE_LAYOUT,
  createSkillPackageStore,
  readPackageFiles,
  validateStoredIndex,
} from '../src/ai/skills/package-store.mjs';
import { parseSkillPackage } from '../src/config/skill-package.mjs';
import { sha256Hex } from '../src/config/jcs.mjs';
import {
  createSigningKey,
  createTrustRoots,
  makeTempDir,
  readBaselinePackages,
  signEnvelope,
  installRawPackage,
} from './fixtures/skills/factory.mjs';

const ARTIFACT = Object.freeze({ botVersion: '0.1.0', skillApiVersion: 1 });

/** @param {string} code */
const assertCode = (code) => (error) => error?.code === code;

/** @param {string} packageId @param {string} version @param {string} digest */
const ref = (packageId, version, digest) => ({ packageId, version, packageDigestSha256: digest });

/** @param {ReadonlyArray<{ path: string, bytes: Uint8Array }>} files */
const parseFiles = (files) => parseSkillPackage(files, { artifact: ARTIFACT });

/**
 * @param {{ packageId: string, version: string, digest: string, botRange: string }} input
 * @param {ReturnType<typeof createSigningKey>} key
 * @param {Record<string, unknown>} [overrides]
 */
function attestation(input, key, overrides = {}) {
  return signEnvelope(
    {
      schemaVersion: 1,
      packageRef: { packageId: input.packageId, version: input.version, packageDigestSha256: input.digest },
      packageIndexSha256: input.digest,
      authorId: 'author-1',
      reviewerId: 'reviewer-1',
      reviewedAt: '2026-10-29T00:00:00Z',
      reviewStatus: 'APPROVED',
      testReportSha256: sha256Hex('tests'),
      comparisonReportSha256: sha256Hex('comparison'),
      sourceRevision: 'rev-1',
      approvedBotRange: input.botRange,
      ...overrides,
    },
    key,
  );
}

/**
 * @param {ReturnType<typeof createSkillPackageStore>} store
 * @param {ReadonlyArray<{ path: string, bytes: Uint8Array }>} files
 * @param {{ key?: ReturnType<typeof createSigningKey>, trustRoots?: any, attestationOverrides?: Record<string, unknown> }} [options]
 */
function publish(store, files, options = {}) {
  const verified = parseFiles(files);
  const key = options.key ?? createSigningKey();
  const trustRoots = options.trustRoots ?? createTrustRoots(key);
  const envelope = attestation(
    {
      packageId: verified.packageId,
      version: verified.version,
      digest: verified.digest,
      botRange: verified.manifest.compatibility.botVersionRange,
    },
    key,
    options.attestationOverrides,
  );
  const published = store.publishPackage({ files, attestation: envelope, trustRoots, artifact: ARTIFACT });
  return { verified, published, key, trustRoots, envelope };
}

describe('Publication and immutability (AC-02, AC-11)', () => {
  test('publishing is content addressed and idempotent for identical bytes', () => {
    const store = createSkillPackageStore({ rootDir: makeTempDir() });
    const files = readBaselinePackages().REFLECT;
    const { verified, published, key, trustRoots } = publish(store, files);
    assert.equal(published.packageDigestSha256, verified.digest);
    assert.equal(published.republished, false);
    assert.ok(fs.existsSync(path.join(published.path, 'package-index.json')));

    // Re-publishing the identical payload with the identical attestation is
    // idempotent.
    const again = publish(store, files, { key, trustRoots });
    assert.equal(again.published.republished, true);
    assert.equal(again.published.packageDigestSha256, verified.digest);
  });

  test('a different attestation for an already published package is refused', () => {
    const store = createSkillPackageStore({ rootDir: makeTempDir() });
    const files = readBaselinePackages().REFLECT;
    const { verified } = publish(store, files);
    const otherKey = createSigningKey();
    const otherEnvelope = attestation(
      {
        packageId: verified.packageId,
        version: verified.version,
        digest: verified.digest,
        botRange: verified.manifest.compatibility.botVersionRange,
      },
      otherKey,
      { reviewerId: 'reviewer-2', reviewedAt: '2026-10-30T00:00:00Z' },
    );
    assert.throws(
      () =>
        store.publishPackage({
          files,
          attestation: otherEnvelope,
          trustRoots: createTrustRoots(otherKey),
          artifact: ARTIFACT,
        }),
      assertCode('SKILL_INTEGRITY_MISMATCH'),
    );
  });

  test('a crash before the rename leaves no published object and is recoverable', () => {
    const rootDir = makeTempDir();
    const files = readBaselinePackages().REFLECT;
    const verified = parseFiles(files);
    const key = createSigningKey();
    const trustRoots = createTrustRoots(key);
    const envelope = attestation(
      {
        packageId: verified.packageId,
        version: verified.version,
        digest: verified.digest,
        botRange: verified.manifest.compatibility.botVersionRange,
      },
      key,
    );
    const crashing = createSkillPackageStore({
      rootDir,
      faultHooks: {
        'before-rename': () => {
          throw new Error('simulated crash before rename');
        },
      },
    });
    assert.throws(() => crashing.publishPackage({ files, attestation: envelope, trustRoots, artifact: ARTIFACT }));
    assert.equal(fs.existsSync(path.join(rootDir, SKILL_STORE_LAYOUT.packages, verified.digest)), false);
    assert.equal(crashing.listPackageDigests().includes(verified.digest), false);

    const healthy = createSkillPackageStore({ rootDir });
    assert.equal(healthy.publishPackage({ files, attestation: envelope, trustRoots, artifact: ARTIFACT }).packageDigestSha256, verified.digest);
  });

  test('a tampered index shape is refused', () => {
    const rootDir = makeTempDir();
    const store = createSkillPackageStore({ rootDir });
    const { verified } = publish(store, readBaselinePackages().REFLECT);
    const indexPath = path.join(rootDir, SKILL_STORE_LAYOUT.packages, verified.digest, 'package-index.json');
    const original = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    fs.writeFileSync(indexPath, JSON.stringify({ ...original, extra: 1 }));
    assert.throws(
      () => store.readPackage(ref(verified.packageId, verified.version, verified.digest), { artifact: ARTIFACT }),
      assertCode('SKILL_INTEGRITY_MISMATCH'),
    );
    assert.throws(() => validateStoredIndex({ format: 'skill-package-v1', files: [] }), assertCode('SKILL_INTEGRITY_MISMATCH'));
  });
});

describe('Approval and revocation (AC-02)', () => {
  const files = readBaselinePackages().REFLECT;

  test('bytes can be installed without an approval; admission then has none to verify', () => {
    const store = createSkillPackageStore({ rootDir: makeTempDir() });
    const verified = parseFiles(files);
    const digest = installRawPackage(store, files);
    assert.equal(digest, verified.digest);
    assert.equal(store.readAttestation(digest), null);
    assert.equal(store.readPackage(ref(verified.packageId, verified.version, digest), { artifact: ARTIFACT }).digest, digest);
  });

  test('an attestation signed by a key outside the trust roots is refused', () => {
    const store = createSkillPackageStore({ rootDir: makeTempDir() });
    const verified = parseFiles(files);
    const authorized = createSigningKey();
    const rogue = createSigningKey();
    const envelope = attestation(
      {
        packageId: verified.packageId,
        version: verified.version,
        digest: verified.digest,
        botRange: verified.manifest.compatibility.botVersionRange,
      },
      rogue,
    );
    assert.throws(
      () => store.publishPackage({ files, attestation: envelope, trustRoots: createTrustRoots(authorized), artifact: ARTIFACT }),
      assertCode('SKILL_NOT_APPROVED'),
    );
  });

  test('an attestation with the wrong digest, self-review, bad status or wrong range is refused', () => {
    const store = createSkillPackageStore({ rootDir: makeTempDir() });
    const verified = parseFiles(files);
    const key = createSigningKey();
    const trustRoots = createTrustRoots(key);
    const base = {
      packageId: verified.packageId,
      version: verified.version,
      digest: verified.digest,
      botRange: verified.manifest.compatibility.botVersionRange,
    };
    const attempt = (envelope) => () => store.publishPackage({ files, attestation: envelope, trustRoots, artifact: ARTIFACT });

    assert.throws(
      attempt(attestation({ ...base, digest: 'a'.repeat(64) }, key)),
      (error) => ['SKILL_INTEGRITY_MISMATCH', 'SKILL_NOT_APPROVED'].includes(error.code),
    );
    assert.throws(attempt(attestation(base, key, { authorId: 'same', reviewerId: 'same' })), assertCode('SKILL_NOT_APPROVED'));
    assert.throws(attempt(attestation({ ...base, botRange: '>=9.0.0 <10.0.0' }, key)), assertCode('SKILL_NOT_APPROVED'));
    assert.throws(attempt(attestation(base, key, { reviewStatus: 'REJECTED' })), assertCode('SKILL_NOT_APPROVED'));
    // A tampered signature never publishes.
    const envelope = attestation(base, key);
    assert.throws(
      attempt({ ...envelope, signatureBase64: Buffer.alloc(64).toString('base64') }),
      assertCode('SKILL_NOT_APPROVED'),
    );
  });

  test('a revocation is immutable and an unsigned one never lands', () => {
    const store = createSkillPackageStore({ rootDir: makeTempDir() });
    const { verified, key, trustRoots } = publish(store, files);
    const revocation = signEnvelope(
      {
        schemaVersion: 1,
        packageRef: { packageId: verified.packageId, version: verified.version, packageDigestSha256: verified.digest },
        revokedAt: '2026-10-30T00:00:00Z',
        operatorApprovalId: 'approval-1',
      },
      key,
    );
    store.publishRevocation(revocation, { trustRoots });
    assert.notEqual(store.readRevocation(verified.digest), null);

    assert.throws(
      () =>
        store.publishRevocation(
          signEnvelope(
            {
              ...revocation.payload,
              operatorApprovalId: 'approval-2',
            },
            key,
          ),
          { trustRoots },
        ),
      assertCode('SKILL_REVOKED'),
    );
    assert.throws(
      () => store.publishRevocation({ ...revocation, signatureBase64: Buffer.alloc(64).toString('base64') }, { trustRoots }),
      assertCode('SKILL_NOT_APPROVED'),
    );
  });
});

describe('Read-time integrity (AC-11)', () => {
  const files = readBaselinePackages().REFLECT;

  test('mutating a payload byte after publication is detected', () => {
    const rootDir = makeTempDir();
    const store = createSkillPackageStore({ rootDir });
    const { verified } = publish(store, files);
    fs.appendFileSync(path.join(rootDir, SKILL_STORE_LAYOUT.packages, verified.digest, 'payload', 'instructions.md'), '\nInjected after approval.\n');
    assert.throws(
      () => store.readPackage(ref(verified.packageId, verified.version, verified.digest), { artifact: ARTIFACT }),
      assertCode('SKILL_INTEGRITY_MISMATCH'),
    );
  });

  test('an unlisted extra payload file is detected', () => {
    const rootDir = makeTempDir();
    const store = createSkillPackageStore({ rootDir });
    const { verified } = publish(store, files);
    fs.writeFileSync(path.join(rootDir, SKILL_STORE_LAYOUT.packages, verified.digest, 'payload', 'extra.json'), '{"evil":true}');
    assert.throws(
      () => store.readPackage(ref(verified.packageId, verified.version, verified.digest), { artifact: ARTIFACT }),
      assertCode('SKILL_INTEGRITY_MISMATCH'),
    );
  });

  test('a missing payload file and a missing package are refused', () => {
    const rootDir = makeTempDir();
    const store = createSkillPackageStore({ rootDir });
    const { verified } = publish(store, files);
    fs.rmSync(path.join(rootDir, SKILL_STORE_LAYOUT.packages, verified.digest, 'payload', 'policy.json'));
    assert.throws(
      () => store.readPackage(ref(verified.packageId, verified.version, verified.digest), { artifact: ARTIFACT }),
      assertCode('SKILL_INTEGRITY_MISMATCH'),
    );
    assert.throws(() => store.readPackage(ref(verified.packageId, verified.version, 'b'.repeat(64)), { artifact: ARTIFACT }), assertCode('SKILL_MISSING'));
  });

  test('the requested reference identity must match the stored bytes', () => {
    const store = createSkillPackageStore({ rootDir: makeTempDir() });
    const { verified } = publish(store, files);
    assert.throws(
      () => store.readPackage(ref('trading.other', verified.version, verified.digest), { artifact: ARTIFACT }),
      assertCode('SKILL_INTEGRITY_MISMATCH'),
    );
    assert.throws(
      () => store.readPackage(ref(verified.packageId, '2.0.0', verified.digest), { artifact: ARTIFACT }),
      assertCode('SKILL_INTEGRITY_MISMATCH'),
    );
  });

  test('a symlink in the payload is refused', () => {
    const rootDir = makeTempDir();
    const store = createSkillPackageStore({ rootDir });
    const { verified } = publish(store, files);
    const payload = path.join(rootDir, SKILL_STORE_LAYOUT.packages, verified.digest, 'payload');
    fs.rmSync(path.join(payload, 'examples'), { recursive: true, force: true });
    fs.symlinkSync(path.join(payload, 'instructions.md'), path.join(payload, 'examples'));
    assert.throws(
      () => store.readPackage(ref(verified.packageId, verified.version, verified.digest), { artifact: ARTIFACT }),
      assertCode('SKILL_EXECUTABLE_FORBIDDEN'),
    );
  });

  test('a verified read owns an immutable snapshot', () => {
    const rootDir = makeTempDir();
    const store = createSkillPackageStore({ rootDir });
    const { verified } = publish(store, files);
    const read = store.readPackage(ref(verified.packageId, verified.version, verified.digest), { artifact: ARTIFACT });
    const before = read.instructions;
    fs.appendFileSync(path.join(rootDir, SKILL_STORE_LAYOUT.packages, verified.digest, 'payload', 'instructions.md'), 'tamper');
    assert.equal(read.instructions, before, 'the snapshot is unaffected by a later disk change');
    assert.throws(
      () => store.readPackage(ref(verified.packageId, verified.version, verified.digest), { artifact: ARTIFACT }),
      assertCode('SKILL_INTEGRITY_MISMATCH'),
      'a later verification refuses the mutated bytes',
    );
  });

  test('registry documents are verified against their address', () => {
    const rootDir = makeTempDir();
    const store = createSkillPackageStore({ rootDir });
    const baseline = readBaselinePackages();
    /** @type {Record<string, any>} */
    const operations = {};
    for (const [operation, files] of Object.entries(baseline)) {
      const { verified } = publish(store, files);
      operations[operation] = {
        packageId: verified.packageId,
        version: verified.version,
        packageDigestSha256: verified.digest,
      };
    }
    const published = store.publishSkillRegistry({ schemaVersion: 1, registryId: 'test-registry', operations });
    assert.equal(store.readRegistry(published.digest).registryId, 'test-registry');
    const file = path.join(rootDir, SKILL_STORE_LAYOUT.registries, `${published.digest}.json`);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...doc, registryId: 'swapped' }));
    assert.throws(() => store.readRegistry(published.digest), assertCode('SKILL_REGISTRY_INVALID'));
  });
});

describe('Store listing', () => {
  test('lists only committed digests, never staging directories', () => {
    const rootDir = makeTempDir();
    const store = createSkillPackageStore({ rootDir });
    const { verified } = publish(store, readBaselinePackages().REFLECT);
    assert.deepEqual(store.listPackageDigests(), [verified.digest]);
    fs.mkdirSync(path.join(rootDir, SKILL_STORE_LAYOUT.packages, '.staging-abc'), { recursive: true });
    assert.deepEqual(store.listPackageDigests(), [verified.digest]);
  });

  test('reading a source package directory is deterministic and order stable', () => {
    const dir = path.join(makeTempDir(), 'pkg');
    for (const file of readBaselinePackages().REFLECT) {
      const target = path.join(dir, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.bytes);
    }
    const first = readPackageFiles(dir);
    const second = readPackageFiles(dir);
    assert.deepEqual(first.map((file) => file.path), second.map((file) => file.path));
    assert.equal(parseSkillPackage(first, { artifact: ARTIFACT }).digest, parseSkillPackage(second, { artifact: ARTIFACT }).digest);
  });
});
