/**
 * Durable local control store (UAI-05B, amendment §4.2, §9.1–§9.3).
 *
 * One directory is the single control authority shared by every participant on
 * the host:
 *
 *   control.json                      current ControlRecord (canonical JSON)
 *   manifests/<sha256>.json           immutable content-addressed manifests
 *   profiles/<sha256>.json            immutable content-addressed profiles
 *   releases/<sha256>.json            immutable release descriptors
 *   acks/<transitionId>/<slot>.<instanceId>.<STATUS>.json
 *   observers/<transitionId>/<observerId>/<sha256>.json
 *   evidence/<transitionId>/<slot>.<instanceId>.fenced.json
 *   transitions/<transitionId>.json   archived transition evidence
 *   audit.jsonl                       append-only release audit (evidence, not authority)
 *   writer.lock/                      exclusive-writer lock directory
 *
 * Every control mutation is: acquire lock -> reread and validate the record ->
 * compare the expected revision -> apply a pure transition -> write a temp file
 * in the same directory -> fsync the file -> rename -> fsync the directory ->
 * release the lock. A crash before the rename leaves the old record valid; a
 * crash after it leaves the new record; an unreadable record is PAUSED
 * (`STORE_CORRUPT`), never reconstructed from the audit log.
 *
 * The store is deliberately synchronous: the barrier's ordering depends on
 * synchronous compare-and-swap and work counting, and a control-plane read on
 * this scale is a local file read.
 *
 * @module ai/coordination/control-store
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  PHASE,
  computeReleaseDescriptorDigest,
  validateAck,
  validateArtifactSet,
  validateControlRecord,
  validateFenceEvidence,
  validateInventory,
  validateObserverReceipt,
  validateReleaseDescriptor,
} from '../../config/ai-release-schema.mjs';
import {
  ACK_MAX_BYTES,
  CONTROL_RECORD_MAX_BYTES,
  MANIFEST_MAX_BYTES,
  RELEASE_DESCRIPTOR_MAX_BYTES,
} from '../../config/ai-identity-manifest.mjs';
import {
  canonicalizeJson,
  isPlainObject,
  parseStrictJsonBytes,
  sha256Hex,
} from '../../config/jcs.mjs';
import {
  assertProfileMatchesManifest,
  loadModelIdentityManifestFromBytes,
} from '../../config/ai-identity-manifest.mjs';
import { validateCapabilityProfile } from '../operation-profiles.mjs';
import { applyReleaseCommand } from './release-state.mjs';
import { COORDINATION_ERROR_CODE, CoordinationError } from '../../errors/coordination-error.mjs';

export { CONTROL_RECORD_MAX_BYTES };

/**
 * Non-identifying host label written to the audit trail and the writer lock. The
 * protocol supports one host only, so this exists to make that assumption
 * explicit (and to refuse a lock from an unexpected producer) rather than to
 * identify a machine.
 */
export const DEFAULT_HOST_LABEL = 'local-host';

/** Directory names used inside the control directory. */
export const CONTROL_LAYOUT = Object.freeze({
  record: 'control.json',
  manifests: 'manifests',
  profiles: 'profiles',
  releases: 'releases',
  acks: 'acks',
  observers: 'observers',
  evidence: 'evidence',
  transitions: 'transitions',
  migrations: 'migrations',
  audit: 'audit.jsonl',
  lock: 'writer.lock',
});

/**
 * Fault-injection sink (tests only). Recognized points:
 *   'before-lock', 'before-read', 'before-write', 'before-file-fsync',
 *   'before-rename', 'after-rename', 'before-dir-fsync', 'before-audit'
 * A value of `'throw'` makes the operation fail at that point.
 *
 * @typedef {Record<string, 'throw' | ((info: object) => void)>} StoreFaults
 */

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @param {unknown} [cause]
 * @returns {never}
 */
function fail(code, message, details, cause) {
  throw new CoordinationError(message, { code, details, cause });
}

/**
 * @param {StoreFaults} faults
 * @param {string} point
 * @param {Record<string, unknown>} [info]
 */
function hit(faults, point, info = {}) {
  const hook = faults?.[point];
  if (typeof hook === 'function') {
    hook({ point, ...info });
    return;
  }
  if (hook === 'throw') {
    throw new CoordinationError(`injected fault at ${point}`, {
      code: COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE,
      details: { point },
    });
  }
}

/**
 * Reject a path that traverses a symlink and (optionally) create it.
 *
 * @param {string} inputPath
 * @param {{ create?: boolean, label?: string }} [options]
 * @returns {string} realpath
 */
export function assertControlDirectory(inputPath, options = {}) {
  const label = options.label ?? 'control directory';
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new CoordinationError(`${label} must be a non-empty path`, {
      code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
      details: { field: 'controlDir' },
    });
  }
  if (!path.isAbsolute(inputPath)) {
    throw new CoordinationError(`${label} must be an absolute path`, {
      code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
      details: { field: 'controlDir' },
    });
  }
  const resolved = path.resolve(inputPath);
  if (options.create === true) {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (error) {
    throw new CoordinationError(`${label} is not accessible`, {
      code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
      details: { field: 'controlDir' },
      cause: error,
    });
  }
  // The control directory itself must not be a symlink. Ancestor symlinks such
  // as macOS `/var -> /private/var` are normal and are not a control-plane risk:
  // every path below is built from the resolved real directory.
  /** @type {fs.Stats} */
  let given;
  try {
    given = fs.lstatSync(resolved);
  } catch (error) {
    throw new CoordinationError(`${label} is not accessible`, {
      code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
      details: { field: 'controlDir' },
      cause: error,
    });
  }
  if (given.isSymbolicLink()) {
    throw new CoordinationError(`${label} must not be a symlink`, {
      code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
      details: { field: 'controlDir' },
    });
  }
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) {
    throw new CoordinationError(`${label} is not a directory`, {
      code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
      details: { field: 'controlDir' },
    });
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new CoordinationError(`${label} is not owned by the running user`, {
      code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
      details: { field: 'controlDir' },
    });
  }
  return real;
}

/**
 * @param {string} filePath
 * @param {string} label
 * @returns {Buffer}
 */
function readRegularFile(filePath, label) {
  /** @type {fs.Stats} */
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code === 'ENOENT') {
      throw new CoordinationError(`${label} is missing`, {
        code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
        details: { kind: 'missing' },
      });
    }
    throw new CoordinationError(`${label} is not readable`, {
      code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
      details: { kind: 'unreadable' },
      cause: error,
    });
  }
  if (stat.isSymbolicLink()) {
    throw new CoordinationError(`${label} must not be a symlink`, {
      code: COORDINATION_ERROR_CODE.STORE_CORRUPT,
      details: { kind: 'symlink' },
    });
  }
  if (!stat.isFile()) {
    throw new CoordinationError(`${label} is not a regular file`, {
      code: COORDINATION_ERROR_CODE.STORE_CORRUPT,
      details: { kind: 'not-a-file' },
    });
  }
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    throw new CoordinationError(`${label} is not readable`, {
      code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
      details: { kind: 'unreadable' },
      cause: error,
    });
  }
}

/**
 * @param {Buffer} bytes
 * @param {{ label: string, maxBytes: number }} options
 * @returns {unknown}
 */
function parseStrict(bytes, options) {
  try {
    return parseStrictJsonBytes(bytes, options);
  } catch (error) {
    throw new CoordinationError(`${options.label} is not valid strict JSON`, {
      code: COORDINATION_ERROR_CODE.STORE_CORRUPT,
      details: { kind: 'invalid-json', reason: /** @type {any} */ (error)?.code ?? 'UNKNOWN' },
      cause: error,
    });
  }
}

/**
 * @param {string} filePath
 * @param {Buffer} bytes
 * @param {{ beforeFileFsync?: () => void }} [hooks]
 */
function writeFileDurable(filePath, bytes, hooks = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    if (hooks.beforeFileFsync) hooks.beforeFileFsync();
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return tmp;
}

/**
 * @param {string} dir
 * @param {StoreFaults} faults
 */
function fsyncDirectory(dir, faults) {
  hit(faults, 'before-dir-fsync', { dir });
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EISDIR') {
      throw new CoordinationError('this filesystem does not support durable directory fsync', {
        code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
        details: { kind: 'fsync-unsupported' },
        cause: error,
      });
    }
    throw new CoordinationError('directory fsync failed', {
      code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
      details: { kind: 'fsync-failed' },
      cause: error,
    });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {any} */ (error)?.code === 'EPERM';
  }
}

/**
 * Create a control store handle. Creation is cheap; the directory is validated
 * on first use so a participant can be constructed before the operator
 * provisions the store (and then fail closed).
 *
 * @param {{
 *   controlDir: string,
 *   deploymentId?: string,
 *   faults?: StoreFaults,
 *   hostLabel?: string,
 *   clock?: () => number,
 *   uuid?: () => string,
 *   logger?: { debug: Function, warn: Function, error: Function, info: Function },
 * }} options
 *
 * `hostLabel` is the non-identifying label written to the audit trail and the
 * writer lock. It defaults to `local-host`: the protocol supports one host only,
 * so the label exists to make the single-host assumption explicit rather than to
 * identify a machine.
 */
export function createControlStore(options) {
  if (options === null || typeof options !== 'object' || typeof options.controlDir !== 'string') {
    throw new CoordinationError('createControlStore requires { controlDir }', {
      code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
    });
  }
  const rawDir = options.controlDir;
  const faults = options.faults ?? {};
  const hostLabel = typeof options.hostLabel === 'string' && options.hostLabel !== '' ? options.hostLabel : DEFAULT_HOST_LABEL;
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const uuid = typeof options.uuid === 'function' ? options.uuid : () => randomUUID();
  const logger = options.logger ?? { debug() {}, info() {}, warn() {}, error() {} };

  /** @type {string | null} */
  let cachedDir = null;

  /**
   * @param {{ create?: boolean }} [init]
   * @returns {string}
   */
  function dir(init) {
    if (cachedDir !== null) return cachedDir;
    cachedDir = assertControlDirectory(rawDir, { create: init?.create === true, label: 'control directory' });
    return cachedDir;
  }

  /**
   * @param {string} name
   * @param {{ create?: boolean }} [init]
   * @returns {string}
   */
  function subdir(name, init) {
    const target = path.join(dir(init), name);
    if (init?.create === true) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return target;
  }

  /** @returns {string} */
  function recordPath() {
    return path.join(dir(), CONTROL_LAYOUT.record);
  }

  /** @returns {string} */
  function lockPath() {
    return path.join(dir(), CONTROL_LAYOUT.lock);
  }

  /** @returns {string} */
  function ownerPath() {
    return path.join(lockPath(), 'owner.json');
  }

  /**
   * Read the current record.
   *
   * @param {{ allowMissing?: boolean }} [readOptions]
   * @returns {Readonly<object> | null}
   */
  function readRecord(readOptions = {}) {
    hit(faults, 'before-read', {});
    const file = recordPath();
    let bytes;
    try {
      bytes = readRegularFile(file, 'control record');
    } catch (error) {
      const details = error instanceof CoordinationError ? error.details : {};
      if (
        readOptions.allowMissing === true &&
        error instanceof CoordinationError &&
        error.code === COORDINATION_ERROR_CODE.STORE_UNAVAILABLE &&
        details.kind === 'missing'
      ) {
        return null;
      }
      throw error;
    }
    if (bytes.byteLength > CONTROL_RECORD_MAX_BYTES) {
      fail(COORDINATION_ERROR_CODE.STORE_CORRUPT, 'control record exceeds the size limit', {
        bytes: bytes.byteLength,
      });
    }
    const parsed = parseStrict(bytes, { label: 'control record', maxBytes: CONTROL_RECORD_MAX_BYTES });
    try {
      return validateControlRecord(parsed);
    } catch (error) {
      throw new CoordinationError('control record violates the release schema', {
        code: COORDINATION_ERROR_CODE.STORE_CORRUPT,
        details: { kind: 'schema' },
        cause: error,
      });
    }
  }

  /**
   * @param {unknown} record
   * @param {number} expectedRevision
   * @param {{ archive?: object, transitionId?: string, event?: object }} [extra]
   * @returns {Readonly<object>}
   */
  function writeRecord(record, expectedRevision, extra = {}) {
    const validated = validateControlRecord(record);
    if (validated.revision !== expectedRevision + 1) {
      fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'control revision must advance by exactly one', {
        expectedRevision,
        nextRevision: validated.revision,
      });
    }
    const bytes = Buffer.from(canonicalizeJson(validated, { label: 'control record' }), 'utf8');
    if (bytes.byteLength > CONTROL_RECORD_MAX_BYTES) {
      fail(COORDINATION_ERROR_CODE.STORE_CORRUPT, 'control record would exceed the size limit', {
        bytes: bytes.byteLength,
      });
    }
    if (extra.archive !== undefined) {
      const archiveId = extra.transitionId;
      if (typeof archiveId !== 'string' || !/^[0-9a-f-]{36}$/.test(archiveId)) {
        fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'transition archive requires the transition id it belongs to');
      }
      writeContentAddressed(
        path.join(subdir(CONTROL_LAYOUT.transitions, { create: true }), `${archiveId}.json`),
        extra.archive,
        { label: 'transition archive' },
      );
    }
    hit(faults, 'before-write', { revision: validated.revision });
    const tmp = writeFileDurable(recordPath(), bytes, {
      beforeFileFsync: () => hit(faults, 'before-file-fsync', { revision: validated.revision }),
    });
    hit(faults, 'before-rename', { tmp, revision: validated.revision });
    fs.renameSync(tmp, recordPath());
    hit(faults, 'after-rename', { revision: validated.revision });
    fsyncDirectory(dir(), faults);
    return validated;
  }

  /**
   * Atomic durable write: temp file in the same directory -> fsync -> rename ->
   * fsync directory. Used for every evidence file and every immutable object.
   *
   * @param {string} file
   * @param {Buffer} bytes
   * @returns {string} final path
   */
  function atomicWrite(file, bytes) {
    const tmp = writeFileDurable(file, bytes, {
      beforeFileFsync: () => hit(faults, 'before-file-fsync', { file }),
    });
    hit(faults, 'before-rename', { tmp, file });
    fs.renameSync(tmp, file);
    hit(faults, 'after-rename', { file });
    fsyncDirectory(path.dirname(file), faults);
    return file;
  }

  /**
   * @param {string} file
   * @param {unknown} value
   * @param {{ label: string, maxBytes?: number }} meta
   * @returns {{ path: string, sha256: string }}
   */
  function writeContentAddressed(file, value, meta) {
    const bytes = Buffer.from(canonicalizeJson(value, { label: meta.label }), 'utf8');
    if (meta.maxBytes !== undefined && bytes.byteLength > meta.maxBytes) {
      fail(COORDINATION_ERROR_CODE.STORE_CORRUPT, `${meta.label} exceeds the size limit`, { bytes: bytes.byteLength });
    }
    const digest = sha256Hex(bytes);
    if (fs.existsSync(file)) {
      const existing = readRegularFile(file, meta.label);
      if (sha256Hex(existing) !== digest) {
        fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, `${meta.label} already exists with different content`, {
          field: meta.label,
        });
      }
      return { path: file, sha256: digest };
    }
    atomicWrite(file, bytes);
    return { path: file, sha256: digest };
  }

  /**
   * @param {unknown} event
   */
  function appendAudit(event) {
    const line = `${canonicalizeJson({ ...event, at: clock(), host: hostLabel, pid: process.pid }, { label: 'audit event' })}\n`;
    if (Buffer.byteLength(line, 'utf8') > 64 * 1024) {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'audit event is too large');
    }
    hit(faults, 'before-audit', {});
    const file = path.join(dir({ create: true }), CONTROL_LAYOUT.audit);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * @param {{ instanceId?: string, purpose?: string }} [owner]
   * @returns {Readonly<{ instanceId: string, pid: number, host: string, purpose: string, acquiredAt: number }>}
   */
  function acquireLock(owner = {}) {
    hit(faults, 'before-lock', {});
    const lock = lockPath();
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'EEXIST') {
        const holder = readLockOwner();
        fail(COORDINATION_ERROR_CODE.STORE_LOCKED, 'the release writer lock is held; no automatic takeover is allowed', {
          holder: holder
            ? { pid: holder.pid, host: holder.host, instanceId: holder.instanceId, acquiredAt: holder.acquiredAt }
            : null,
        });
      }
      throw new CoordinationError('cannot acquire the release writer lock', {
        code: COORDINATION_ERROR_CODE.STORE_UNAVAILABLE,
        cause: error,
      });
    }
    const record = Object.freeze({
      instanceId: typeof owner.instanceId === 'string' ? owner.instanceId : uuid(),
      pid: process.pid,
      host: hostLabel,
      purpose: typeof owner.purpose === 'string' ? owner.purpose : 'release-writer',
      acquiredAt: clock(),
    });
    fs.writeFileSync(ownerPath(), canonicalizeJson(record), { mode: 0o600 });
    return record;
  }

  /** @returns {Readonly<object> | null} */
  function readLockOwner() {
    const file = ownerPath();
    if (!fs.existsSync(file)) return null;
    try {
      const bytes = fs.readFileSync(file);
      const parsed = parseStrictJsonBytes(bytes, { label: 'lock owner', maxBytes: 4096 });
      if (!isPlainObject(parsed)) return null;
      return Object.freeze(/** @type {any} */ (parsed));
    } catch {
      return null;
    }
  }

  function releaseLock(owner) {
    const current = readLockOwner();
    if (current && current.instanceId !== owner.instanceId) {
      // Do not remove a lock we do not own: that would be a silent takeover.
      fail(COORDINATION_ERROR_CODE.STORE_LOCKED, 'refusing to release a lock owned by another writer');
    }
    try {
      fs.unlinkSync(ownerPath());
    } catch {
      /* already gone */
    }
    try {
      fs.rmdirSync(lockPath());
    } catch {
      /* already gone */
    }
  }

  /**
   * @template T
   * @param {(context: { dir: string, record: Readonly<object> | null }) => T} fn
   * @param {{ purpose?: string, instanceId?: string, create?: boolean }} [lockOptions]
   * @returns {T}
   */
  function withWriterLock(fn, lockOptions = {}) {
    dir({ create: lockOptions.create === true });
    const owner = acquireLock({ purpose: lockOptions.purpose, instanceId: lockOptions.instanceId });
    try {
      // The authority is re-read *inside* the lock: a caller's cached copy is
      // never trusted for a mutation.
      const record = readRecord({ allowMissing: true });
      return fn({ dir: dir(), record });
    } finally {
      releaseLock(owner);
    }
  }

  /**
   * Initialize a brand-new deployment: PAUSED, generation 0, empty rosters.
   * Never infers state and never replaces an existing control record.
   *
   * @param {{ deploymentId?: string, inventory: unknown, approvalId?: string | null }} input
   * @returns {{ record: Readonly<object>, deploymentId: string }}
   */
  function initialize(input) {
    if (input === null || typeof input !== 'object') {
      fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'initialize requires an options object');
    }
    dir({ create: true });
    const inventory = validateInventory(input.inventory);
    const deploymentId = typeof input.deploymentId === 'string' ? input.deploymentId : uuid();
    return withWriterLock(({ record }) => {
      if (record !== null) {
        fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'control store is already initialized; refusing to replace it');
      }
      const candidate = validateControlRecord({
        schemaVersion: 1,
        deploymentId,
        revision: 0,
        generation: 0,
        nextGeneration: null,
        phase: PHASE.PAUSED,
        active: null,
        target: null,
        transitionId: null,
        inventory,
        members: [],
        highWaterGeneration: 0,
        approvalId: input.approvalId ?? null,
        releaseDescriptorSha256: null,
        transition: null,
      });
      const bytes = Buffer.from(canonicalizeJson(candidate), 'utf8');
      const tmp = writeFileDurable(recordPath(), bytes, {
        beforeFileFsync: () => hit(faults, 'before-file-fsync', { revision: 0 }),
      });
      hit(faults, 'before-rename', { tmp, revision: 0 });
      fs.renameSync(tmp, recordPath());
      hit(faults, 'after-rename', { revision: 0 });
      fsyncDirectory(dir(), faults);
      appendAudit({ kind: 'control.initialized', deploymentId, inventorySha256: null, revision: 0 });
      logger.info('control store initialized', { deploymentId, phase: PHASE.PAUSED });
      return { record: candidate, deploymentId };
    }, { purpose: 'initialize', create: true });
  }

  /**
   * Apply the offline administrative schema migration (architecture v1.1 §10
   * Phase C).
   *
   * Only a paused or quiescing v1 record may be converted, and conversion lands
   * PAUSED and unbound: no inference, no activation, no silent replacement of
   * the active generation. The exact pre-migration bytes are retained as an
   * immutable forensic backup; they are never copied back over a running store.
   * This is the only writer allowed to change `control.json` schemaVersion.
   *
   * @param {{ record: Readonly<object>, expectedRevision: number, operatorApprovalId: string }} input
   * @returns {{ record: Readonly<object>, backupSha256: string, revision: number }}
   */
  function migrateRecord(input) {
    if (
      input === null ||
      typeof input !== 'object' ||
      input.record === null ||
      typeof input.record !== 'object' ||
      !Number.isSafeInteger(input.expectedRevision) ||
      typeof input.operatorApprovalId !== 'string' ||
      input.operatorApprovalId === ''
    ) {
      fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'migrateRecord requires { record, expectedRevision, operatorApprovalId }');
    }
    return withWriterLock(({ record }) => {
      if (record === null) {
        fail(COORDINATION_ERROR_CODE.STORE_UNAVAILABLE, 'control store is not initialized');
      }
      if (record.revision !== input.expectedRevision) {
        fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'control revision changed since it was read', {
          expectedRevision: input.expectedRevision,
          actualRevision: record.revision,
        });
      }
      if (record.schemaVersion !== 1) {
        fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'only a schemaVersion 1 control record can be migrated');
      }
      if (record.phase !== PHASE.PAUSED && record.phase !== PHASE.QUIESCING) {
        fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'a v1 record must be paused or quiescing before migration', {
          phase: record.phase,
        });
      }
      const converted = validateControlRecord(input.record);
      if (converted.schemaVersion !== 2) {
        fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'the migrated record must use schemaVersion 2');
      }
      if (converted.phase !== PHASE.PAUSED || converted.active !== null || converted.target !== null) {
        fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'the migrated record must land PAUSED and unbound');
      }
      if (converted.deploymentId !== record.deploymentId) {
        fail(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH, 'the migrated record belongs to another deployment');
      }
      if (converted.revision !== record.revision + 1) {
        fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'the migrated record must advance the revision by exactly one');
      }
      if (converted.generation !== record.generation || converted.highWaterGeneration < record.highWaterGeneration) {
        fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'the migrated record must preserve the generation high-water mark');
      }
      const backup = writeContentAddressed(
        path.join(subdir(CONTROL_LAYOUT.migrations, { create: true }), `control-before-v2-r${record.revision}.json`),
        record,
        { label: 'pre-migration control record' },
      );
      writeRecord(converted, record.revision, {});
      appendAudit({
        kind: 'control.migrated_v2',
        deploymentId: record.deploymentId,
        revision: converted.revision,
        operatorApprovalId: input.operatorApprovalId,
        backupSha256: backup.sha256,
      });
      logger.info('control store migrated to schemaVersion 2', { deploymentId: record.deploymentId, revision: converted.revision });
      return { record: converted, backupSha256: backup.sha256, revision: converted.revision };
    }, { purpose: 'migrate-schema' });
  }

  /**
   * Apply one release command under the writer lock with compare-and-swap on the
   * expected revision.
   *
   * @param {{ action: string } & Record<string, unknown>} command
   * @param {{ expectedRevision: number, purpose?: string, instanceId?: string }} options
   * @returns {{ record: Readonly<object>, event: object, archive?: object, revision: number }}
   */
  function transact(command, options) {
    if (options === null || typeof options !== 'object' || !Number.isSafeInteger(options.expectedRevision)) {
      fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'transact requires an explicit expectedRevision');
    }
    return withWriterLock(({ record }) => {
      if (record === null) {
        fail(COORDINATION_ERROR_CODE.STORE_UNAVAILABLE, 'control store is not initialized');
      }
      if (record.revision !== options.expectedRevision) {
        fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'control revision changed since it was read', {
          expectedRevision: options.expectedRevision,
          actualRevision: record.revision,
        });
      }
      // Barrier advances are re-verified against the *retained* evidence on
      // disk, not against whatever the caller remembers passing earlier.
      let effective = command;
      if (command.action === 'arm' || command.action === 'activate' || command.action === 'prepare-ack') {
        if (typeof record.transitionId !== 'string' || record.transition === null) {
          fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, `${command.action} requires a reserved transition`);
        }
        const resolved = readReleaseDescriptor(record.transition.descriptorSha256);
        effective = {
          ...command,
          descriptor: command.descriptor ?? resolved.descriptor,
          observerReceipts: listObserverReceipts(record.transitionId).map((entry) => entry.receipt),
        };
      }
      const result = applyReleaseCommand(record, effective);
      const persisted = writeRecord(result.record, record.revision, {
        archive: result.archive,
        transitionId: /** @type {any} */ (record).transitionId ?? undefined,
      });
      appendAudit({
        kind: 'control.transition',
        action: command.action,
        deploymentId: persisted.deploymentId,
        revision: persisted.revision,
        generation: persisted.generation,
        phase: persisted.phase,
        event: result.event ?? null,
      });
      return {
        record: persisted,
        event: result.event,
        ...(result.archive ? { archive: result.archive } : {}),
        revision: persisted.revision,
      };
    }, { purpose: options.purpose ?? `release:${command.action}`, instanceId: options.instanceId });
  }

  /**
   * Read + revalidate, returning null when the store is absent.
   *
   * @returns {Readonly<object> | null}
   */
  function tryReadRecord() {
    try {
      return readRecord({ allowMissing: true });
    } catch (error) {
      if (error instanceof CoordinationError) return null;
      throw error;
    }
  }

  /**
   * Put an immutable manifest and return its digest.
   *
   * @param {unknown} manifest
   * @param {{ manifestSha256: string }} meta
   * @returns {{ path: string, sha256: string }}
   */
  function putManifest(manifest, meta) {
    const bytes = Buffer.from(canonicalizeJson(manifest, { label: 'manifest' }), 'utf8');
    const digest = sha256Hex(bytes);
    if (meta?.manifestSha256 !== undefined && meta.manifestSha256 !== digest) {
      fail(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH, 'manifest bytes do not hash to the declared digest');
    }
    if (bytes.byteLength > MANIFEST_MAX_BYTES) {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'manifest exceeds the size limit');
    }
    const file = path.join(subdir(CONTROL_LAYOUT.manifests, { create: true }), `${digest}.json`);
    return writeContentAddressed(file, manifest, { label: 'manifest', maxBytes: MANIFEST_MAX_BYTES });
  }

  /**
   * @param {unknown} profile
   * @param {{ profileSha256: string }} meta
   * @returns {{ path: string, sha256: string }}
   */
  function putProfile(profile, meta) {
    const validated = validateCapabilityProfile(profile);
    const digest = sha256Hex(canonicalizeJson(validated, { label: 'capability profile' }));
    if (meta?.profileSha256 !== undefined && meta.profileSha256 !== digest) {
      fail(COORDINATION_ERROR_CODE.PROFILE_MISMATCH, 'profile bytes do not hash to the declared digest');
    }
    const file = path.join(subdir(CONTROL_LAYOUT.profiles, { create: true }), `${digest}.json`);
    return writeContentAddressed(file, validated, { label: 'capability profile', maxBytes: MANIFEST_MAX_BYTES });
  }

  /**
   * @param {string} manifestSha256
   * @param {{ policy?: object }} [readOptions]
   * @returns {Readonly<{ manifest: Readonly<object>, manifestSha256: string }>}
   */
  function readManifest(manifestSha256, readOptions = {}) {
    if (typeof manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifestSha256)) {
      fail(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH, 'manifest reference is not a SHA-256 digest');
    }
    const file = path.join(subdir(CONTROL_LAYOUT.manifests), `${manifestSha256}.json`);
    const bytes = readRegularFile(file, 'manifest');
    const loaded = loadModelIdentityManifestFromBytes(bytes, {
      expectedSha256: manifestSha256,
      policy: readOptions.policy,
      label: `manifest ${manifestSha256.slice(0, 12)}`,
    });
    return loaded;
  }

  /**
   * @param {string} profileSha256
   * @returns {Readonly<object>}
   */
  function readProfile(profileSha256) {
    if (typeof profileSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(profileSha256)) {
      fail(COORDINATION_ERROR_CODE.PROFILE_MISMATCH, 'profile reference is not a SHA-256 digest');
    }
    const file = path.join(subdir(CONTROL_LAYOUT.profiles), `${profileSha256}.json`);
    const bytes = readRegularFile(file, 'capability profile');
    if (bytes.byteLength > MANIFEST_MAX_BYTES) {
      fail(COORDINATION_ERROR_CODE.STORE_CORRUPT, 'capability profile exceeds the size limit');
    }
    const parsed = parseStrict(bytes, { label: 'capability profile', maxBytes: MANIFEST_MAX_BYTES });
    const profile = validateCapabilityProfile(parsed);
    const digest = sha256Hex(canonicalizeJson(profile, { label: 'capability profile' }));
    if (digest !== profileSha256) {
      fail(COORDINATION_ERROR_CODE.PROFILE_MISMATCH, 'capability profile content does not match its address');
    }
    return profile;
  }

  /**
   * Write an immutable release descriptor and return its digest.
   *
   * @param {unknown} descriptor
   * @returns {{ path: string, sha256: string }}
   */
  function putReleaseDescriptor(descriptor) {
    const validated = validateReleaseDescriptor(descriptor);
    const digest = computeReleaseDescriptorDigest(validated);
    const file = path.join(subdir(CONTROL_LAYOUT.releases, { create: true }), `${digest}.json`);
    return writeContentAddressed(file, validated, {
      label: 'release descriptor',
      maxBytes: RELEASE_DESCRIPTOR_MAX_BYTES,
    });
  }

  /**
   * Read and validate a descriptor by digest, including the immutable
   * manifest/profile files it references.
   *
   * @param {string} descriptorSha256
   * @param {{ policy?: object }} [readOptions]
   * @returns {Readonly<{ descriptor: Readonly<object>, manifest: Readonly<object>, profile: Readonly<object>, manifestSha256: string }>}
   */
  function readReleaseDescriptor(descriptorSha256, readOptions = {}) {
    if (typeof descriptorSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(descriptorSha256)) {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'descriptor reference is not a SHA-256 digest');
    }
    const file = path.join(subdir(CONTROL_LAYOUT.releases), `${descriptorSha256}.json`);
    const bytes = readRegularFile(file, 'release descriptor');
    const parsed = parseStrict(bytes, {
      label: 'release descriptor',
      maxBytes: RELEASE_DESCRIPTOR_MAX_BYTES,
    });
    let descriptor;
    try {
      descriptor = validateReleaseDescriptor(parsed);
    } catch (error) {
      throw new CoordinationError('release descriptor violates the release schema', {
        code: COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
        cause: error,
      });
    }
    const digest = computeReleaseDescriptorDigest(descriptor);
    if (digest !== descriptorSha256) {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'release descriptor content does not match its address');
    }
    const manifest = readManifest(descriptor.binding.manifestSha256, readOptions);
    const profile = readProfile(descriptor.binding.capabilityProfileSha256);
    try {
      assertProfileMatchesManifest({ manifest: manifest.manifest, profile });
    } catch (error) {
      throw new CoordinationError('descriptor profile does not match its manifest', {
        code: COORDINATION_ERROR_CODE.PROFILE_MISMATCH,
        cause: error,
      });
    }
    if (manifest.manifest.manifestVersion !== descriptor.binding.manifestVersion) {
      fail(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH, 'descriptor manifestVersion does not match the manifest file');
    }
    // The artifact set must be internally consistent with the descriptor
    // inventory; validateReleaseDescriptor already proved that, and the
    // manifest/profile digests are now proven against their files.
    validateArtifactSet(descriptor.artifacts, descriptor.observers, descriptor.inventory);
    return Object.freeze({
      descriptor,
      manifest: manifest.manifest,
      manifestSha256: manifest.manifestSha256,
      profile,
    });
  }

  /**
   * @param {string} transitionId
   * @param {string} slot
   * @param {string} instanceId
   * @param {string} status
   * @param {unknown} ack
   * @returns {{ path: string, sha256: string, idempotent: boolean }}
   */
  function writeAck(transitionId, slot, instanceId, status, ack) {
    const validated = validateAck(ack, { label: `${status} ack` });
    if (validated.transitionId !== transitionId || validated.slot !== slot || validated.instanceId !== instanceId || validated.status !== status) {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'ack content disagrees with its destination');
    }
    const dirName = path.join(subdir(CONTROL_LAYOUT.acks, { create: true }), transitionId);
    fs.mkdirSync(dirName, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(canonicalizeJson(validated, { label: 'ack' }), 'utf8');
    if (bytes.byteLength > ACK_MAX_BYTES) {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'ack exceeds the size limit');
    }
    const digest = sha256Hex(bytes);
    const base = path.join(dirName, `${slot}.${instanceId}.${status}.json`);
    if (fs.existsSync(base)) {
      const existing = readRegularFile(base, 'ack');
      if (sha256Hex(existing) === digest) return { path: base, sha256: digest, idempotent: true };
      // A different ack for the same phase/instance is a new attempt; its path
      // carries its digest so earlier evidence is never overwritten.
      const attempt = path.join(dirName, `${slot}.${instanceId}.${status}.${digest.slice(0, 16)}.json`);
      if (fs.existsSync(attempt)) return { path: attempt, sha256: digest, idempotent: true };
      atomicWrite(attempt, bytes);
      return { path: attempt, sha256: digest, idempotent: false };
    }
    atomicWrite(base, bytes);
    return { path: base, sha256: digest, idempotent: false };
  }

  /**
   * @param {string} transitionId
   * @returns {{ name: string, path: string, sha256: string, ack: Readonly<object> }[]}
   */
  function listAcks(transitionId) {
    const dirName = path.join(subdir(CONTROL_LAYOUT.acks), transitionId);
    if (!fs.existsSync(dirName)) return [];
    /** @type {{ name: string, path: string, sha256: string, ack: Readonly<object> }[]} */
    const out = [];
    for (const name of fs.readdirSync(dirName)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const file = path.join(dirName, name);
      let bytes;
      try {
        bytes = readRegularFile(file, `ack ${name}`);
      } catch {
        continue;
      }
      if (bytes.byteLength > ACK_MAX_BYTES) continue;
      try {
        const parsed = parseStrict(bytes, { label: `ack ${name}`, maxBytes: ACK_MAX_BYTES });
        const ack = validateAck(parsed, { label: `ack ${name}` });
        out.push({ name, path: file, sha256: sha256Hex(bytes), ack });
      } catch {
        // A malformed ack is not evidence; the coordinator simply does not see
        // it and the barrier stays blocked.
      }
    }
    return out;
  }

  /**
   * Collect acknowledgements for one status, resolving the "same phase, several
   * attempts" case explicitly: exactly one candidate is used; more than one
   * requires the coordinator to name the digest it accepts.
   *
   * @param {string} transitionId
   * @param {{ status: string, selection?: Readonly<Record<string, string>> }} options
   * @returns {{ slot: string, instanceId: string, sha256: string, ack: Readonly<object> }[]}
   */
  function collectAcks(transitionId, options) {
    const selection = options.selection ?? {};
    /** @type {Map<string, { slot: string, instanceId: string, sha256: string, ack: Readonly<object> }[]>} */
    const byInstance = new Map();
    for (const entry of listAcks(transitionId)) {
      if (entry.ack.status !== options.status) continue;
      const key = `${entry.ack.slot}/${entry.ack.instanceId}`;
      const list = byInstance.get(key) ?? [];
      list.push({ slot: entry.ack.slot, instanceId: entry.ack.instanceId, sha256: entry.sha256, ack: entry.ack });
      byInstance.set(key, list);
    }
    /** @type {{ slot: string, instanceId: string, sha256: string, ack: Readonly<object> }[]} */
    const collected = [];
    for (const [key, candidates] of byInstance) {
      const chosen = selection[key];
      if (chosen !== undefined) {
        const match = candidates.find((candidate) => candidate.sha256 === chosen);
        if (!match) {
          fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, `no ${options.status} ack ${key} with the selected digest`, {
            key,
          });
        }
        collected.push(match);
        continue;
      }
      if (candidates.length > 1) {
        fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, `ambiguous ${options.status} evidence for ${key}; select a digest`, {
          key,
          candidates: candidates.map((candidate) => candidate.sha256),
        });
      }
      collected.push(candidates[0]);
    }
    return collected;
  }

  /**
   * @param {string} transitionId
   * @param {string} observerId
   * @param {unknown} receipt
   * @returns {{ path: string, sha256: string }}
   */
  function writeObserverReceipt(transitionId, observerId, receipt) {
    const validated = validateObserverReceipt(receipt, { label: 'observer receipt' });
    if (validated.transitionId !== transitionId || validated.observerId !== observerId) {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'observer receipt disagrees with its destination');
    }
    const dirName = path.join(subdir(CONTROL_LAYOUT.observers, { create: true }), transitionId, observerId);
    fs.mkdirSync(dirName, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(canonicalizeJson(validated, { label: 'observer receipt' }), 'utf8');
    const digest = sha256Hex(bytes);
    const file = path.join(dirName, `${digest}.json`);
    if (fs.existsSync(file)) return { path: file, sha256: digest };
    atomicWrite(file, bytes);
    return { path: file, sha256: digest };
  }

  /**
   * @param {string} transitionId
   * @returns {{ observerId: string, sha256: string, receipt: Readonly<object> }[]}
   */
  function listObserverReceipts(transitionId) {
    const root = path.join(subdir(CONTROL_LAYOUT.observers), transitionId);
    if (!fs.existsSync(root)) return [];
    /** @type {{ observerId: string, sha256: string, receipt: Readonly<object> }[]} */
    const out = [];
    for (const observerId of fs.readdirSync(root)) {
      const dirName = path.join(root, observerId);
      let stat;
      try {
        stat = fs.lstatSync(dirName);
      } catch {
        continue;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      for (const name of fs.readdirSync(dirName)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(dirName, name);
        try {
          const bytes = readRegularFile(file, `observer receipt ${observerId}`);
          const receipt = validateObserverReceipt(parseStrict(bytes, { label: 'observer receipt', maxBytes: ACK_MAX_BYTES }));
          if (receipt.observerId !== observerId) continue;
          out.push({ observerId, sha256: sha256Hex(bytes), receipt });
        } catch {
          /* not evidence */
        }
      }
    }
    return out.sort((a, b) => (a.observerId < b.observerId ? -1 : a.observerId > b.observerId ? 1 : 0));
  }

  /**
   * @param {string} transitionId
   * @param {string} slot
   * @param {string} instanceId
   * @param {unknown} evidence
   * @returns {{ path: string, sha256: string }}
   */
  function writeFenceEvidence(transitionId, slot, instanceId, evidence) {
    const validated = validateFenceEvidence(evidence, { label: 'fence evidence' });
    if (validated.transitionId !== transitionId || validated.slot !== slot || validated.instanceId !== instanceId) {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'fence evidence disagrees with its destination');
    }
    const dirName = path.join(subdir(CONTROL_LAYOUT.evidence, { create: true }), transitionId);
    fs.mkdirSync(dirName, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(canonicalizeJson(validated, { label: 'fence evidence' }), 'utf8');
    const digest = sha256Hex(bytes);
    const file = path.join(dirName, `${slot}.${instanceId}.fenced.${digest.slice(0, 16)}.json`);
    if (!fs.existsSync(file)) {
      atomicWrite(file, bytes);
    }
    return { path: file, sha256: digest };
  }

  /**
   * Resolve a digest reference to retained evidence (ack, receipt or fence).
   *
   * @param {string} transitionId
   * @param {string} digest
   * @returns {{ kind: 'ack' | 'observer' | 'fence', sha256: string } | null}
   */
  function findEvidence(transitionId, digest) {
    for (const entry of listAcks(transitionId)) {
      if (entry.sha256 === digest) return { kind: 'ack', sha256: digest };
    }
    for (const entry of listObserverReceipts(transitionId)) {
      if (entry.sha256 === digest) return { kind: 'observer', sha256: digest };
    }
    const dirName = path.join(subdir(CONTROL_LAYOUT.evidence), transitionId);
    if (fs.existsSync(dirName)) {
      for (const name of fs.readdirSync(dirName)) {
        if (!name.endsWith('.json')) continue;
        try {
          const bytes = readRegularFile(path.join(dirName, name), 'fence evidence');
          if (sha256Hex(bytes) === digest) return { kind: 'fence', sha256: digest };
        } catch {
          /* ignore */
        }
      }
    }
    return null;
  }

  /**
   * Operator-verified writer-lock recovery. Never time-based: the caller must
   * prove the owner cannot resume and supply reconciliation references.
   *
   * @param {{ operatorApprovalId: string, processFenceEvidenceRef: string, outcomeReconciliationRef: string }} evidence
   * @returns {{ recovered: boolean, previous: object | null }}
   */
  function recoverLock(evidence) {
    if (
      evidence === null ||
      typeof evidence !== 'object' ||
      typeof evidence.operatorApprovalId !== 'string' ||
      typeof evidence.processFenceEvidenceRef !== 'string' ||
      typeof evidence.outcomeReconciliationRef !== 'string'
    ) {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'lock recovery requires operator approval and fencing references');
    }
    const holder = readLockOwner();
    if (holder) {
      if (holder.host !== hostLabel) {
        // A lock written under a different host label cannot be proven dead from
        // here. Refuse instead of stealing it: the protocol is single-host only.
        fail(COORDINATION_ERROR_CODE.STORE_LOCKED, 'lock owner belongs to a different host label; single-host topology is required', {
          host: holder.host,
        });
      }
      if (isProcessAlive(Number(holder.pid))) {
        fail(COORDINATION_ERROR_CODE.STORE_LOCKED, 'lock owner is still alive on this host; fencing was not proven', {
          pid: holder.pid,
        });
      }
    }
    if (fs.existsSync(lockPath())) {
      fs.rmSync(lockPath(), { recursive: true, force: true });
    }
    appendAudit({
      kind: 'control.lock_recovered',
      previous: holder ? { pid: holder.pid, host: holder.host, instanceId: holder.instanceId } : null,
      evidence,
    });
    return { recovered: true, previous: holder ? { ...holder } : null };
  }

  /**
   * Diagnostics for `inspect`: no secrets, no environment dump.
   *
   * @returns {Readonly<object>}
   */
  function inspect() {
    const owner = readLockOwner();
    /** @type {Readonly<object> | null} */
    let record = null;
    /** @type {string | null} */
    let errorCode = null;
    try {
      record = readRecord();
    } catch (error) {
      errorCode = error instanceof CoordinationError ? error.code : COORDINATION_ERROR_CODE.INTERNAL_ERROR;
    }
    return Object.freeze({
      controlDir: rawDir,
      lockHeld: fs.existsSync(lockPath()),
      lockOwner: owner,
      errorCode,
      record,
      acks: record?.transitionId ? listAcks(record.transitionId).length : 0,
    });
  }

  return Object.freeze({
    controlDir: rawDir,
    deploymentId: options.deploymentId ?? null,
    initialize,
    migrateRecord,
    transact,
    readRecord,
    tryReadRecord,
    withWriterLock,
    readLockOwner,
    recoverLock,
    putManifest,
    putProfile,
    readManifest,
    readProfile,
    putReleaseDescriptor,
    readReleaseDescriptor,
    writeAck,
    listAcks,
    collectAcks,
    writeObserverReceipt,
    listObserverReceipts,
    writeFenceEvidence,
    findEvidence,
    appendAudit,
    inspect,
    assertControlDirectory: () => dir(),
  });
}

/** @typedef {ReturnType<typeof createControlStore>} ControlStore */
