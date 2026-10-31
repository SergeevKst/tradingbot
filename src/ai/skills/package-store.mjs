/**
 * Immutable, read-mostly Skill Package CAS (architecture v1.1 §7.2).
 *
 * Layout inside a control directory:
 *
 *   skill-packages/<digest>/payload/<payload files>
 *   skill-packages/<digest>/package-index.json
 *   skill-registries/<digest>.json
 *   model-registries/<digest>.json
 *   execution-plans/<digest>.json
 *   runtime-policies/<digest>.json
 *   capability-evidence/<digest>.json
 *   skill-attestations/<digest>.json
 *   skill-revocations/<digest>.json
 *
 * The runtime only ever *reads*: it verifies the stored index against the bytes
 * on disk and the requested reference, then returns an immutable snapshot that
 * execution uses instead of reopening mutable paths (no TOCTOU window).
 *
 * Administrative publication is a separate, explicit write path used by offline
 * tooling. It never activates anything: `control.json` is not touched here.
 *
 * @module ai/skills/package-store
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalizeJson, digestJson, isPlainObject, parseStrictJsonBytes, sha256Hex } from '../../config/jcs.mjs';
import { structuralError } from '../../errors/skill-error.mjs';
import {
  SKILL_PACKAGE_FORMAT,
  parseSkillPackage,
  validatePackageLayout,
} from '../../config/skill-package.mjs';
import {
  computeExecutionPlanDigest,
  computeRuntimePolicyDigest,
  computeSkillRegistryDigest,
  computeTrustRootsDigest,
  validateCapabilityEvidence,
  validateExecutionPlan,
  validateRevocationRecord,
  validateRuntimePolicy,
  validateSkillRef,
  validateSkillRegistry,
  validateTrustRoots,
  verifyPublicationAttestation,
  verifyRevocation,
} from '../../config/skill-release-contracts.mjs';
import { validateModelRegistry } from '../../config/ai-model-registry.mjs';

/** Directory names owned by the skill CAS. */
export const SKILL_STORE_LAYOUT = Object.freeze({
  packages: 'skill-packages',
  registries: 'skill-registries',
  modelRegistries: 'model-registries',
  plans: 'execution-plans',
  policies: 'runtime-policies',
  evidence: 'capability-evidence',
  attestations: 'skill-attestations',
  revocations: 'skill-revocations',
});

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PAYLOAD_DIR = 'payload';
const INDEX_FILE = 'package-index.json';
const MAX_INDEX_BYTES = 64 * 1024;

/**
 * @param {string} digest
 * @param {string} label
 * @returns {string}
 */
function assertDigestPath(digest, label) {
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
    throw structuralError('SKILL_INTEGRITY_MISMATCH', `${label} is not a lowercase SHA-256 digest`, { field: label });
  }
  return digest;
}

/**
 * Read a regular file, refusing symlinks, hardlinks, devices and executables.
 *
 * @param {string} filePath
 * @param {string} label
 * @returns {Buffer}
 */
function readRegularFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw structuralError('SKILL_MISSING', `${label} is not present in the package store`, { field: label });
  }
  if (stat.isSymbolicLink()) {
    throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `${label} is a symlink`, { field: label });
  }
  if (!stat.isFile()) {
    throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `${label} is not a regular file`, { field: label });
  }
  if (stat.nlink > 1) {
    throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `${label} is a hardlink`, { field: label });
  }
  if ((stat.mode & 0o111) !== 0) {
    throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `${label} carries an executable permission bit`, { field: label });
  }
  return fs.readFileSync(filePath);
}

/**
 * @param {string} filePath
 * @param {Uint8Array} bytes
 */
function writeDurableFile(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} dirPath
 */
function fsyncDir(dirPath) {
  let fd = null;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is advisory on some filesystems; the rename is still
    // atomic and a crash exposes either no object or a complete one.
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * @param {string} root
 * @param {string} name
 * @param {{ create?: boolean }} [options]
 * @returns {string}
 */
function subdir(root, name, options = {}) {
  const target = path.join(root, name);
  if (options.create === true) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  return target;
}

/**
 * Read every file under a directory tree, rejecting anything that is not a
 * plain regular file.
 *
 * @param {string} dirPath
 * @param {string} [prefix]
 * @returns {Array<{ path: string, bytes: Buffer }>}
 */
function readTree(dirPath, prefix = '') {
  /** @type {Array<{ path: string, bytes: Buffer }>} */
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    throw structuralError('SKILL_MISSING', 'package payload directory is not readable', { field: 'payload' });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = path.join(dirPath, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `payload entry ${relative} is a symlink`, { field: relative });
    }
    if (stat.isDirectory()) {
      out.push(...readTree(full, relative));
      continue;
    }
    out.push({ path: relative, bytes: readRegularFile(full, `payload ${relative}`) });
  }
  return out;
}

/**
 * Validate a stored package index document.
 *
 * @param {unknown} raw
 * @returns {Readonly<{ format: string, files: ReadonlyArray<{ path: string, size: number, sha256: string }> }>}
 */
export function validateStoredIndex(raw) {
  if (!isPlainObject(raw)) {
    throw structuralError('SKILL_INTEGRITY_MISMATCH', 'package-index.json must be an object', { field: INDEX_FILE });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'files' || keys[1] !== 'format') {
    throw structuralError('SKILL_INTEGRITY_MISMATCH', 'package-index.json has an unexpected shape', { field: INDEX_FILE });
  }
  if (input.format !== SKILL_PACKAGE_FORMAT) {
    throw structuralError('SKILL_INTEGRITY_MISMATCH', 'package-index.json declares an unsupported format', { field: INDEX_FILE });
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw structuralError('SKILL_INTEGRITY_MISMATCH', 'package-index.json has no files', { field: INDEX_FILE });
  }
  const files = input.files.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', `package-index.json file ${index} is not an object`, { field: INDEX_FILE });
    }
    const record = /** @type {Record<string, unknown>} */ (entry);
    const entryKeys = Object.keys(record).sort();
    if (entryKeys.length !== 3 || entryKeys[0] !== 'path' || entryKeys[1] !== 'sha256' || entryKeys[2] !== 'size') {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', `package-index.json file ${index} has an unexpected shape`, { field: INDEX_FILE });
    }
    if (typeof record.path !== 'string' || record.path === '') {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', `package-index.json file ${index} has no path`, { field: INDEX_FILE });
    }
    if (typeof record.sha256 !== 'string' || !DIGEST_PATTERN.test(record.sha256)) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', `package-index.json file ${index} has no valid digest`, { field: INDEX_FILE });
    }
    if (!Number.isSafeInteger(record.size) || /** @type {number} */ (record.size) < 0) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', `package-index.json file ${index} has no valid size`, { field: INDEX_FILE });
    }
    return Object.freeze({ path: record.path, size: /** @type {number} */ (record.size), sha256: record.sha256 });
  });
  return Object.freeze({ format: SKILL_PACKAGE_FORMAT, files: Object.freeze(files) });
}

/**
 * Read a source package directory (e.g. `skills/<packageId>/<version>/`) into
 * the payload-file list the validators consume. Administrative tooling only:
 * the runtime never reads a mutable source path.
 *
 * @param {string} dirPath
 * @returns {Array<{ path: string, bytes: Buffer }>}
 */
export function readPackageFiles(dirPath) {
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw structuralError('SKILL_MISSING', 'a source package path must be a real directory', { field: 'package' });
  }
  return readTree(dirPath);
}

/**
 * Parse and verify a source package directory.
 *
 * @param {string} dirPath
 * @param {{ artifact?: { botVersion: string, skillApiVersion: number }, expectedOperation?: string | null }} [options]
 * @returns {import('../../config/skill-package.mjs').VerifiedPackage}
 */
export function parseSourcePackage(dirPath, options = {}) {
  return parseSkillPackage(readPackageFiles(dirPath), options);
}

/**
 * Create a store rooted at a control directory.
 *
 * @param {{ rootDir: string, faultHooks?: Record<string, (info: object) => void> }} options
 */
export function createSkillPackageStore(options) {
  if (options === null || typeof options !== 'object' || typeof options.rootDir !== 'string') {
    throw new TypeError('createSkillPackageStore requires { rootDir }');
  }
  const root = path.resolve(options.rootDir);
  const faultHooks = options.faultHooks ?? {};

  /** @param {string} point */
  function hit(point) {
    const hook = faultHooks[point];
    if (typeof hook === 'function') hook({});
  }

  /**
   * @param {string} digest
   * @returns {string}
   */
  function packageDir(digest) {
    return path.join(subdir(root, SKILL_STORE_LAYOUT.packages), assertDigestPath(digest, 'packageDigestSha256'));
  }

  /**
   * Read and fully verify a package by reference.
   *
   * @param {{ packageId: string, version: string, packageDigestSha256: string }} rawRef
   * @param {{ artifact?: { botVersion: string, skillApiVersion: number }, expectedOperation?: string | null }} [readOptions]
   * @returns {import('../../config/skill-package.mjs').VerifiedPackage & { index: Readonly<object> }}
   */
  function readPackage(rawRef, readOptions = {}) {
    const ref = validateSkillRef(rawRef, 'package ref');
    const dir = packageDir(ref.packageDigestSha256);
    const indexPath = path.join(dir, INDEX_FILE);
    const indexBytes = readRegularFile(indexPath, 'package-index.json');
    if (indexBytes.byteLength > MAX_INDEX_BYTES) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', 'package-index.json exceeds the size limit', { field: INDEX_FILE });
    }
    const index = validateStoredIndex(parseStrictJsonBytes(indexBytes, { label: INDEX_FILE, maxBytes: MAX_INDEX_BYTES }));
    const computed = digestJson(index, { label: 'skill package index' });
    if (computed !== ref.packageDigestSha256) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', 'stored package index does not hash to the requested digest', {
        field: INDEX_FILE,
      });
    }
    const payloadRoot = path.join(dir, PAYLOAD_DIR);
    const files = readTree(payloadRoot);
    const byPath = new Map(files.map((file) => [file.path, file.bytes]));
    /** @type {Record<string, number>} */
    const seen = {};
    for (const entry of index.files) {
      const bytes = byPath.get(entry.path);
      if (!bytes) {
        throw structuralError('SKILL_INTEGRITY_MISMATCH', `payload file ${JSON.stringify(entry.path)} is missing from the store`, {
          field: entry.path,
        });
      }
      if (bytes.byteLength !== entry.size || sha256Hex(bytes) !== entry.sha256) {
        throw structuralError('SKILL_INTEGRITY_MISMATCH', `payload file ${JSON.stringify(entry.path)} does not match its index entry`, {
          field: entry.path,
        });
      }
      seen[entry.path] = 1;
    }
    for (const file of files) {
      if (seen[file.path] !== 1) {
        throw structuralError('SKILL_INTEGRITY_MISMATCH', `payload contains unlisted file ${JSON.stringify(file.path)}`, {
          field: file.path,
        });
      }
    }
    const verified = parseSkillPackage(files, readOptions);
    if (verified.digest !== ref.packageDigestSha256) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', 'verified package digest differs from the requested reference', {
        field: 'packageDigestSha256',
      });
    }
    if (verified.packageId !== ref.packageId || verified.version !== ref.version) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', 'verified package identity differs from the requested reference', {
        field: 'packageRef',
      });
    }
    return Object.freeze({ ...verified, index });
  }

  /**
   * @param {string} kind layout directory name
   * @param {string} digest
   * @returns {unknown | null}
   */
  function readDocument(kind, digest) {
    const file = path.join(subdir(root, kind), `${assertDigestPath(digest, `${kind} digest`)}.json`);
    if (!fs.existsSync(file)) return null;
    const bytes = readRegularFile(file, `${kind} document`);
    return parseStrictJsonBytes(bytes, { label: `${kind} document`, maxBytes: 512 * 1024 });
  }

  /**
   * @param {string} digest
   * @returns {Readonly<object>}
   */
  function readRegistry(digest) {
    const doc = readDocument(SKILL_STORE_LAYOUT.registries, digest);
    if (doc === null) {
      throw structuralError('SKILL_REGISTRY_INVALID', 'skill registry snapshot is not present in the store', {
        field: 'skillRegistrySha256',
      });
    }
    const registry = validateSkillRegistry(doc);
    if (computeSkillRegistryDigest(registry) !== digest) {
      throw structuralError('SKILL_REGISTRY_INVALID', 'skill registry bytes do not hash to their address', {
        field: 'skillRegistrySha256',
      });
    }
    return registry;
  }

  /**
   * @param {string} digest
   * @returns {Readonly<object>}
   */
  function readModelRegistry(digest) {
    const file = path.join(subdir(root, SKILL_STORE_LAYOUT.modelRegistries), `${assertDigestPath(digest, 'modelRegistrySha256')}.json`);
    const bytes = readRegularFile(file, 'model registry');
    const registry = validateModelRegistry(parseStrictJsonBytes(bytes, { label: 'model registry', maxBytes: 64 * 1024 }));
    if (registry.digestSha256 !== digest) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', 'model registry bytes do not hash to their address', {
        field: 'modelRegistrySha256',
      });
    }
    return registry;
  }

  /**
   * @param {string} digest
   * @returns {Readonly<object>}
   */
  function readExecutionPlan(digest) {
    const doc = readDocument(SKILL_STORE_LAYOUT.plans, digest);
    if (doc === null) {
      throw structuralError('SKILL_MISSING', 'execution plan is not present in the store', { field: 'executionPlanSha256' });
    }
    const plan = validateExecutionPlan(doc);
    if (computeExecutionPlanDigest(plan) !== digest) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', 'execution plan bytes do not hash to their address', {
        field: 'executionPlanSha256',
      });
    }
    return plan;
  }

  /**
   * @param {string} digest
   * @returns {Readonly<object>}
   */
  function readRuntimePolicy(digest) {
    const doc = readDocument(SKILL_STORE_LAYOUT.policies, digest);
    if (doc === null) {
      throw structuralError('SKILL_MISSING', 'runtime policy is not present in the store', { field: 'runtimePolicySha256' });
    }
    const policy = validateRuntimePolicy(doc);
    if (computeRuntimePolicyDigest(policy) !== digest) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', 'runtime policy bytes do not hash to their address', {
        field: 'runtimePolicySha256',
      });
    }
    return policy;
  }

  /**
   * @param {string} digest
   * @returns {Readonly<object> | null}
   */
  function readTrustRoots(digest) {
    const doc = readDocument(SKILL_STORE_LAYOUT.policies, digest);
    if (doc === null) return null;
    const roots = validateTrustRoots(doc, { label: 'trust roots' });
    if (computeTrustRootsDigest(roots) !== digest) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', 'trust roots bytes do not hash to their address', {
        field: 'trustRootsSha256',
      });
    }
    return roots;
  }

  /**
   * @param {string} digest
   * @returns {Readonly<object> | null}
   */
  function readCapabilityEvidence(digest) {
    const doc = readDocument(SKILL_STORE_LAYOUT.evidence, digest);
    if (doc === null) return null;
    return validateCapabilityEvidence(doc);
  }

  /**
   * @param {string} packageDigest
   * @returns {unknown | null}
   */
  function readAttestation(packageDigest) {
    return readDocument(SKILL_STORE_LAYOUT.attestations, packageDigest);
  }

  /**
   * @param {string} packageDigest
   * @returns {unknown | null}
   */
  function readRevocation(packageDigest) {
    return readDocument(SKILL_STORE_LAYOUT.revocations, packageDigest);
  }

  /**
   * Administrative publication of immutable package bytes plus their signed
   * approval. Idempotent for identical content; conflicting content under an
   * existing digest is an integrity error and is never overwritten.
   *
   * @param {{
   *   files: ReadonlyArray<{ path: string, bytes: Uint8Array }>,
   *   attestation: unknown,
   *   trustRoots: unknown,
   *   artifact?: { botVersion: string, skillApiVersion: number },
   * }} input
   * @returns {{ packageDigestSha256: string, path: string, republished: boolean }}
   */
  function publishPackage(input) {
    const layout = validatePackageLayout(input.files);
    const verified = parseSkillPackage(layout, { artifact: input.artifact });
    const payload = verifyPublicationAttestation(input.attestation, {
      trustRoots: input.trustRoots,
      packageRef: { packageId: verified.packageId, version: verified.version, packageDigestSha256: verified.digest },
    });
    if (payload.approvedBotRange !== verified.manifest.compatibility.botVersionRange) {
      throw structuralError('SKILL_NOT_APPROVED', 'attestation approves a different bot version range than the package declares', {
        field: 'approvedBotRange',
      });
    }
    hit('before-publish');
    const digest = verified.digest;
    const target = packageDir(digest);
    const payloadTarget = path.join(target, PAYLOAD_DIR);
    const indexBytes = Buffer.from(canonicalizeJson(verified.index, { label: 'skill package index' }), 'utf8');
    const attestationBytes = Buffer.from(canonicalizeJson(input.attestation, { label: 'attestation' }), 'utf8');

    if (fs.existsSync(target)) {
      // Same digest => same content by construction; verify and return.
      const existing = readPackage({ packageId: verified.packageId, version: verified.version, packageDigestSha256: digest });
      if (existing.digest !== digest) {
        throw structuralError('SKILL_INTEGRITY_MISMATCH', 'the store holds different bytes under this digest', {
          field: 'packageDigestSha256',
        });
      }
      writeAttestation(digest, attestationBytes);
      return Object.freeze({ packageDigestSha256: digest, path: target, republished: true });
    }

    const staging = path.join(
      subdir(root, SKILL_STORE_LAYOUT.packages, { create: true }),
      `.staging-${digest.slice(0, 12)}-${randomBytes(6).toString('hex')}`,
    );
    fs.mkdirSync(path.join(staging, PAYLOAD_DIR), { recursive: true, mode: 0o700 });
    for (const file of layout) {
      const destination = path.join(staging, PAYLOAD_DIR, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      writeDurableFile(destination, file.bytes);
    }
    writeDurableFile(path.join(staging, INDEX_FILE), indexBytes);
    fsyncDir(path.join(staging, PAYLOAD_DIR));
    fsyncDir(staging);
    hit('before-rename');
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      const code = /** @type {any} */ (error).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        throw structuralError('SKILL_INTEGRITY_MISMATCH', 'a concurrent publication claimed this digest', {
          field: 'packageDigestSha256',
        });
      }
      throw error;
    }
    fsyncDir(path.dirname(target));
    hit('after-rename');
    writeAttestation(digest, attestationBytes);
    return Object.freeze({ packageDigestSha256: digest, path: target, republished: false });
  }

  /**
   * @param {string} digest
   * @param {Uint8Array} bytes
   */
  function writeAttestation(digest, bytes) {
    const file = path.join(subdir(root, SKILL_STORE_LAYOUT.attestations, { create: true }), `${digest}.json`);
    if (fs.existsSync(file)) {
      const existing = readRegularFile(file, 'attestation');
      if (sha256Hex(existing) === sha256Hex(bytes)) return;
      throw structuralError('SKILL_INTEGRITY_MISMATCH', 'a different attestation is already published for this package', {
        field: 'attestation',
      });
    }
    writeDurableFile(file, bytes);
    fsyncDir(path.dirname(file));
  }

  /**
   * @param {string} kind
   * @param {string} digest
   * @param {unknown} document
   */
  function publishDocument(kind, digest, document) {
    const bytes = Buffer.from(canonicalizeJson(document, { label: kind }), 'utf8');
    const file = path.join(subdir(root, kind, { create: true }), `${assertDigestPath(digest, `${kind} digest`)}.json`);
    if (fs.existsSync(file)) {
      const existing = readRegularFile(file, kind);
      if (sha256Hex(existing) !== sha256Hex(bytes)) {
        throw structuralError('SKILL_INTEGRITY_MISMATCH', `a different ${kind} document is published under this digest`, {
          field: `${kind}.json`,
        });
      }
      return Object.freeze({ path: file, digest, republished: true });
    }
    writeDurableFile(file, bytes);
    fsyncDir(path.dirname(file));
    return Object.freeze({ path: file, digest, republished: false });
  }

  /** @param {unknown} registry */
  function publishSkillRegistry(registry) {
    const validated = validateSkillRegistry(registry);
    const digest = computeSkillRegistryDigest(validated);
    return publishDocument(SKILL_STORE_LAYOUT.registries, digest, validated);
  }

  /** @param {unknown} registry */
  function publishModelRegistry(registry) {
    const validated = validateModelRegistry(registry);
    const document = {
      schemaVersion: validated.schemaVersion,
      registryId: validated.registryId,
      models: validated.models,
      routingTable: validated.routingTable,
      fallbacks: validated.fallbacks,
    };
    const digest = digestJson(document, { label: 'model registry' });
    if (digest !== validated.digestSha256) {
      // Preserve the digest the registry itself computed; never silently
      // re-address a registry whose canonical form differs.
      throw structuralError('SKILL_INTEGRITY_MISMATCH', 'model registry canonical form does not match its digest', {
        field: 'modelRegistrySha256',
      });
    }
    return publishDocument(SKILL_STORE_LAYOUT.modelRegistries, digest, document);
  }

  /** @param {unknown} plan */
  function publishExecutionPlan(plan) {
    const validated = validateExecutionPlan(plan);
    return publishDocument(SKILL_STORE_LAYOUT.plans, computeExecutionPlanDigest(validated), validated);
  }

  /** @param {unknown} policy */
  function publishRuntimePolicy(policy) {
    const validated = validateRuntimePolicy(policy);
    return publishDocument(SKILL_STORE_LAYOUT.policies, computeRuntimePolicyDigest(validated), validated);
  }

  /** @param {unknown} roots */
  function publishTrustRoots(roots) {
    const validated = validateTrustRoots(roots);
    return publishDocument(SKILL_STORE_LAYOUT.policies, computeTrustRootsDigest(validated), validated);
  }

  /** @param {unknown} evidence */
  function publishCapabilityEvidence(evidence) {
    const validated = validateCapabilityEvidence(evidence);
    return publishDocument(
      SKILL_STORE_LAYOUT.evidence,
      digestJson(validated, { label: 'capability evidence' }),
      validated,
    );
  }

  /**
   * @param {unknown} envelope
   * @param {{ trustRoots: unknown }} options
   * @returns {{ path: string, packageDigestSha256: string }}
   */
  function publishRevocation(envelope, revocationOptions) {
    const record = verifyRevocation(envelope, revocationOptions);
    validateRevocationRecord(record);
    const digest = record.packageRef.packageDigestSha256;
    const file = path.join(subdir(root, SKILL_STORE_LAYOUT.revocations, { create: true }), `${digest}.json`);
    const bytes = Buffer.from(canonicalizeJson(envelope, { label: 'revocation' }), 'utf8');
    if (fs.existsSync(file)) {
      const existing = readRegularFile(file, 'revocation record');
      if (sha256Hex(existing) === sha256Hex(bytes)) {
        return Object.freeze({ path: file, packageDigestSha256: digest });
      }
      throw structuralError('SKILL_REVOKED', 'a different revocation is already recorded for this package', {
        field: 'revocation',
      });
    }
    writeDurableFile(file, bytes);
    fsyncDir(path.dirname(file));
    return Object.freeze({ path: file, packageDigestSha256: digest });
  }

  /**
   * @returns {ReadonlyArray<string>}
   */
  function listPackageDigests() {
    const dir = subdir(root, SKILL_STORE_LAYOUT.packages);
    if (!fs.existsSync(dir)) return Object.freeze([]);
    return Object.freeze(
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && DIGEST_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort(),
    );
  }

  return Object.freeze({
    rootDir: root,
    readPackage,
    readRegistry,
    readModelRegistry,
    readExecutionPlan,
    readRuntimePolicy,
    readTrustRoots,
    readCapabilityEvidence,
    readAttestation,
    readRevocation,
    publishPackage,
    publishSkillRegistry,
    publishModelRegistry,
    publishExecutionPlan,
    publishRuntimePolicy,
    publishTrustRoots,
    publishCapabilityEvidence,
    publishRevocation,
    listPackageDigests,
  });
}

/** @typedef {ReturnType<typeof createSkillPackageStore>} SkillPackageStore */
