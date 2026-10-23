/**
 * Runtime identity guard and whole-work fencing (UAI-05C, architecture §5–§7).
 *
 * The guard is what turns a control record into an enforceable runtime contract:
 *
 *   - startup validation happens before any admission, provider key load or
 *     lazy client construction;
 *   - every admission and every response/effect checkpoint rereads the control
 *     record and compares deployment, generation, binding, slot and instance;
 *   - outstanding work is counted synchronously and covers whole workflows
 *     (Scout -> Guard -> effect), not individual fetches, so a QUIESCED ack cannot
 *     be issued while a delayed response or pending approval could still act;
 *   - a pending human approval carries a generation sidecar and is consumed with
 *     a counted work token before its first await, then invalidated at quiescence
 *     and on restart.
 *
 * The guard never imports a provider, exchange or trading module. It only reads
 * the control store and asks the injected `runtimeFactory` for a runtime object.
 *
 * @module ai/coordination/generation-guard
 */
import { randomUUID } from 'node:crypto';
import {
  ACK_STATUS,
  OBSERVER_STATUS,
  PHASE,
  validateObserverReceipt,
} from '../../config/ai-release-schema.mjs';
import {
  assertProfileMatchesManifest,
  computeManifestDigest,
} from '../../config/ai-identity-manifest.mjs';
import { COORDINATION_ERROR_CODE, CoordinationError } from '../../errors/coordination-error.mjs';

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
function fail(code, message, details) {
  throw new CoordinationError(message, { code, details });
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function bindingEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.manifestVersion === b.manifestVersion &&
    a.manifestSha256 === b.manifestSha256 &&
    a.capabilityProfileSha256 === b.capabilityProfileSha256 &&
    a.inventorySha256 === b.inventorySha256 &&
    a.artifactSetSha256 === b.artifactSetSha256
  );
}

/**
 * Validate identity for a disabled observer or a pre-start check without
 * claiming a slot, loading a key or writing anything. This is the seam the
 * release CLI runs in a separate process to produce an observer receipt
 * (architecture §9.1).
 *
 * @param {{
 *   controlStore: any,
 *   deploymentId: string,
 *   expectedManifestVersion: string,
 *   expectedManifestSha256: string,
 *   artifactSha256?: string | null,
 *   transitionId?: string | null,
 *   observerId?: string | null,
 *   policy?: object,
 *   now?: () => number,
 * }} input
 * @returns {Readonly<object>}
 */
export function validateObserverIdentity(input) {
  const base = {
    identityValidated: false,
    inferenceEnabled: false,
    phase: null,
    generation: null,
    manifestVersion: null,
    manifestSha256: null,
    capabilityProfileSha256: null,
    artifactSha256: input.artifactSha256 ?? null,
    transitionId: input.transitionId ?? null,
    observerId: input.observerId ?? null,
    errorCode: null,
    checkedAt: typeof input.now === 'function' ? input.now() : Date.now(),
  };
  try {
    const record = input.controlStore.readRecord();
    base.phase = record.phase;
    base.generation = record.generation;
    if (record.deploymentId !== input.deploymentId) {
      return { ...base, errorCode: COORDINATION_ERROR_CODE.IDENTITY_MISMATCH };
    }
    /** @type {Readonly<object> | null} */
    let binding = null;
    /** @type {any} */
    let descriptor = null;
    if (input.transitionId) {
      if (record.phase !== PHASE.PREPARING || record.transitionId !== input.transitionId) {
        return { ...base, errorCode: COORDINATION_ERROR_CODE.ACTIVATION_PAUSED };
      }
      descriptor = input.controlStore.readReleaseDescriptor(record.transition.descriptorSha256).descriptor;
      binding = descriptor.binding;
      if (input.observerId) {
        const observer = descriptor.observers.find((entry) => entry.observerId === input.observerId);
        if (!observer) return { ...base, errorCode: COORDINATION_ERROR_CODE.IDENTITY_MISMATCH };
        if (observer.artifactSha256 !== input.artifactSha256) {
          return { ...base, errorCode: COORDINATION_ERROR_CODE.ARTIFACT_MISMATCH };
        }
      }
    } else {
      if (record.phase !== PHASE.ACTIVE) {
        return { ...base, errorCode: COORDINATION_ERROR_CODE.ACTIVATION_PAUSED };
      }
      binding = record.active;
    }
    if (binding.manifestVersion !== input.expectedManifestVersion || binding.manifestSha256 !== input.expectedManifestSha256) {
      return { ...base, errorCode: COORDINATION_ERROR_CODE.MANIFEST_STALE };
    }
    const loaded = input.controlStore.readManifest(binding.manifestSha256, { policy: input.policy });
    if (computeManifestDigest(loaded.manifest, { policy: input.policy }) !== binding.manifestSha256) {
      return { ...base, errorCode: COORDINATION_ERROR_CODE.IDENTITY_MISMATCH };
    }
    const profile = input.controlStore.readProfile(binding.capabilityProfileSha256);
    assertProfileMatchesManifest({ manifest: loaded.manifest, profile });
    return Object.freeze({
      ...base,
      identityValidated: true,
      generation: input.transitionId ? record.nextGeneration : record.generation,
      manifestVersion: loaded.manifest.manifestVersion,
      manifestSha256: loaded.manifestSha256,
      capabilityProfileSha256: binding.capabilityProfileSha256,
      errorCode: null,
    });
  } catch (error) {
    return {
      ...base,
      errorCode: error instanceof CoordinationError ? error.code : COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE,
    };
  }
}

/**
 * @typedef {object} GuardOptions
 * @property {any} controlStore
 * @property {{ mode: string, controlDir: string, deploymentId: string, slot: string | null, expectedManifestVersion: string, expectedManifestSha256: string, artifactSha256: string | null }} config
 * @property {string} [instanceId]
 * @property {(input: { manifest: object, profile: object, binding: object, generation: number, target: boolean, slot: string, instanceId: string }) => any} runtimeFactory
 * @property {object} [policy] test-only canonical URL policy
 * @property {() => number} [clock]
 * @property {() => string} [idFactory]
 * @property {{ debug: Function, info: Function, warn: Function, error: Function }} [logger]
 * @property {boolean} [observer] validate identity but never claim a slot or infer
 */

/**
 * @param {GuardOptions} options
 */
export function createGenerationGuard(options) {
  if (options === null || typeof options !== 'object' || !options.controlStore || !options.config) {
    fail(COORDINATION_ERROR_CODE.INTERNAL_ERROR, 'createGenerationGuard requires { controlStore, config }');
  }
  const config = options.config;
  if (config.mode !== 'single') {
    fail(COORDINATION_ERROR_CODE.INTERNAL_ERROR, 'the generation guard only exists in single mode');
  }
  const store = options.controlStore;
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => randomUUID();
  const logger = options.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  const slot = options.observer === true ? null : config.slot;
  if (options.observer !== true && (slot === null || typeof slot !== 'string')) {
    fail(COORDINATION_ERROR_CODE.INTERNAL_ERROR, 'a participant guard requires a slot');
  }
  if (options.observer !== true && typeof options.runtimeFactory !== 'function') {
    fail(COORDINATION_ERROR_CODE.INTERNAL_ERROR, 'a participant guard requires a runtimeFactory');
  }
  const instanceId = typeof options.instanceId === 'string' && options.instanceId !== ''
    ? options.instanceId
    : idFactory();

  /** @type {{ binding: any, generation: number, manifest: any, profile: any, runtime: any, descriptorSha256: string, operations: readonly string[] } | null} */
  let current = null;
  /** @type {{ binding: any, generation: number, manifest: any, profile: any, runtime: any, descriptorSha256: string, grant: any | null } | null} */
  let prepared = null;
  let admissionOpen = false;
  let identityReady = false;
  let inferenceEnabled = false;
  let phase = null;
  let lastErrorCode = null;
  let lastCheckAt = 0;
  let ackWrittenFor = null;
  let workSequence = 0;
  /** @type {Map<number, any>} */
  const work = new Map();
  /**
   * AI-derived dispatches whose outcome is unknown. The counted token stays
   * outstanding, so a QUIESCED acknowledgement cannot be written until an
   * operator reconciles the exchange state (architecture §5).
   *
   * @type {Map<number, Readonly<{ workId: number, operation: string, reason: string, generation: number, at: number }>>}
   */
  const unresolved = new Map();
  /** @type {Map<string, { generation: number, binding: any, operation: string, purpose: string, createdAt: number }>} */
  const approvals = new Map();
  /** @type {Set<() => void>} */
  const drainWaiters = new Set();
  /** @type {NodeJS.Timeout | null} */
  let pollTimer = null;

  function notReady(code) {
    identityReady = false;
    inferenceEnabled = false;
    admissionOpen = false;
    lastErrorCode = code;
    return status();
  }

  function closeAdmission(code) {
    if (admissionOpen) {
      logger.info('ai admission closed', { slot, instanceId, phase, code: code ?? null });
    }
    admissionOpen = false;
    inferenceEnabled = false;
    lastErrorCode = code ?? lastErrorCode;
    // A pending approval whose generation is no longer admitted must never be
    // consumable: retire the sidecars with the admission.
    invalidatePendingApprovals();
  }

  function invalidatePendingApprovals() {
    const count = approvals.size;
    approvals.clear();
    if (count > 0) logger.info('pending AI approvals invalidated', { slot, instanceId, count });
    return count;
  }

  function status() {
    return Object.freeze({
      deploymentId: config.deploymentId,
      slot,
      instanceId,
      phase,
      generation: current?.generation ?? prepared?.generation ?? null,
      manifestVersion: current?.binding.manifestVersion ?? prepared?.binding.manifestVersion ?? null,
      manifestSha256: current?.binding.manifestSha256 ?? prepared?.binding.manifestSha256 ?? null,
      capabilityProfileSha256: current?.binding.capabilityProfileSha256 ?? prepared?.binding.capabilityProfileSha256 ?? null,
      artifactSha256: config.artifactSha256,
      identityReady,
      inferenceEnabled: inferenceEnabled && admissionOpen,
      admissionOpen,
      outstandingWork: work.size,
      unresolvedEffects: unresolved.size,
      pendingAIApprovals: approvals.size,
      errorCode: lastErrorCode,
      lastCheckAt,
    });
  }

  /**
   * @param {any} record
   * @param {any} binding
   * @param {string} expectedOperation
   */
  function slotOperations(record, scope) {
    const entry = record.inventory.find((candidate) => candidate.slot === slot);
    if (!entry) return null;
    if (!entry.enabled) return null;
    return entry.operations;
  }

  /**
   * Compare the observed record with the runtime's own identity.
   *
   * @param {any} record
   */
  function assertActiveBinding(record) {
    if (record.phase !== PHASE.ACTIVE) {
      fail(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, `AI is not active (phase ${record.phase})`, {
        phase: record.phase,
      });
    }
    if (record.deploymentId !== config.deploymentId) {
      fail(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH, 'control record belongs to another deployment');
    }
    if (current === null) {
      fail(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, 'the runtime has no committed generation');
    }
    if (record.generation !== current.generation) {
      fail(COORDINATION_ERROR_CODE.GENERATION_RETIRED, 'the runtime generation has been retired', {
        expected: current.generation,
        observed: record.generation,
      });
    }
    if (!bindingEqual(record.active, current.binding)) {
      fail(COORDINATION_ERROR_CODE.GENERATION_RETIRED, 'the committed binding no longer matches this runtime');
    }
    if (record.releaseDescriptorSha256 !== current.descriptorSha256) {
      fail(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH, 'the committed release descriptor does not match this runtime');
    }
  }

  /**
   * @param {any} record
   * @param {any} binding
   * @param {string | null} descriptorSha256
   * @param {{ skipLaunchExpectations?: boolean, inventory?: readonly any[] }} [opts]
   * @returns {{ manifest: any, profile: any, binding: any, operations: readonly string[], descriptorSha256: string }}
   */
  function resolveBinding(record, binding, descriptorSha256, opts = {}) {
    if (!binding) fail(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, 'no binding is available to validate');
    if (
      opts.skipLaunchExpectations !== true &&
      (binding.manifestVersion !== config.expectedManifestVersion ||
        binding.manifestSha256 !== config.expectedManifestSha256)
    ) {
      fail(COORDINATION_ERROR_CODE.MANIFEST_STALE, 'the launch expectations do not match the approved binding', {
        expectedVersion: config.expectedManifestVersion,
        observedVersion: binding.manifestVersion,
      });
    }
    const loaded = store.readManifest(binding.manifestSha256, { policy: options.policy });
    const manifest = loaded.manifest;
    if (manifest.manifestVersion !== binding.manifestVersion) {
      fail(COORDINATION_ERROR_CODE.MANIFEST_STALE, 'manifest version does not match the binding');
    }
    const profile = store.readProfile(binding.capabilityProfileSha256);
    assertProfileMatchesManifest({ manifest, profile });
    let operations = Object.freeze([]);
    if (slot !== null) {
      const inventory = opts.inventory ?? record.inventory;
      const entry = inventory.find((candidate) => candidate.slot === slot);
      if (!entry) {
        fail(COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED, `slot ${slot} is not in the committed inventory`, { slot });
      }
      if (!entry.enabled) {
        fail(COORDINATION_ERROR_CODE.SLOT_DISABLED, `slot ${slot} is disabled in the committed inventory`, { slot });
      }
      operations = entry.operations;
    }
    return {
      manifest,
      profile,
      binding,
      operations,
      descriptorSha256: descriptorSha256 ?? record.releaseDescriptorSha256,
    };
  }

  /**
   * @param {any} record
   * @param {string} bindingSha
   * @returns {string}
   */
  function assertArtifactAssignment(record, binding) {
    const descriptorSha = record.phase === PHASE.ACTIVE ? record.releaseDescriptorSha256 : record.transition?.descriptorSha256;
    if (!descriptorSha) fail(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, 'no release descriptor is bound');
    const { descriptor } = store.readReleaseDescriptor(descriptorSha, { policy: options.policy });
    const artifact = descriptor.artifacts.find((entry) => entry.slot === slot);
    if (!artifact) {
      fail(COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED, `slot ${slot} has no artifact assignment in the release descriptor`, { slot });
    }
    if (config.artifactSha256 !== null && artifact.artifactSha256 !== config.artifactSha256) {
      fail(COORDINATION_ERROR_CODE.ARTIFACT_MISMATCH, `slot ${slot} must run the artifact assigned by the release`, {
        slot,
      });
    }
    return descriptorSha;
  }

  /**
   * Retry a CAS mutation after a concurrent revision bump; never after a
   * semantic rejection.
   *
   * @param {(record: any) => { action: string } & Record<string, unknown>} build
   * @param {{ attempts?: number, purpose?: string }} [opts]
   */
  function retryingTransact(build, opts = {}) {
    const attempts = opts.attempts ?? 4;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const record = store.readRecord();
      const command = build(record);
      try {
        return store.transact(command, { expectedRevision: record.revision, purpose: opts.purpose, instanceId });
      } catch (error) {
        lastError = error;
        const details = error instanceof CoordinationError ? error.details : {};
        if (details && details.actualRevision !== undefined) continue;
        throw error;
      }
    }
    throw lastError;
  }

  /**
   * Startup validation (architecture §5 steps 1–5).
   *
   * @returns {Readonly<object>} redacted status
   */
  function start() {
    lastCheckAt = clock();
    /** @type {any} */
    let record;
    try {
      record = store.readRecord();
    } catch (error) {
      return notReady(error instanceof CoordinationError ? error.code : COORDINATION_ERROR_CODE.STORE_UNAVAILABLE);
    }
    phase = record.phase;
    if (record.deploymentId !== config.deploymentId) {
      return notReady(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
    }

    if (options.observer === true) {
      // A disabled bootstrap observer validates identity only: no slot claim,
      // no key, no runtime, no inference.
      try {
        if (record.phase !== PHASE.ACTIVE) {
          return notReady(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED);
        }
        const resolved = resolveBinding(record, record.active, record.releaseDescriptorSha256);
        identityReady = true;
        lastErrorCode = null;
        logger.info('observer identity validated', {
          slot: null,
          manifestVersion: resolved.manifest.manifestVersion,
          generation: record.generation,
        });
        return status();
      } catch (error) {
        return notReady(error instanceof CoordinationError ? error.code : COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
      }
    }

    try {
      if (record.phase === PHASE.ACTIVE) {
        const resolved = resolveBinding(record, record.active, record.releaseDescriptorSha256);
        const member = record.members.find((candidate) => candidate.slot === slot);
        if (!member) {
          fail(COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED, `slot ${slot} has no committed membership`, { slot });
        }
        if (config.artifactSha256 !== null && member.artifactSha256 !== config.artifactSha256) {
          fail(COORDINATION_ERROR_CODE.ARTIFACT_MISMATCH, 'this process is not running the committed artifact', { slot });
        }
        // An occupied slot never expires automatically (architecture §5 step 3).
        // Replacing a committed member is a membership change: §9.3 allows no
        // ACTIVE self-transition for it, and UAI-05B requires explicit operator
        // fencing evidence for a member replacement. A restart therefore fails
        // closed; the operator must run a transition (quiesce → retire/fence the
        // old instance → register the new one → arm → activate).
        if (member.instanceId !== instanceId) {
          logger.warn('slot is held by another instance; operator fencing is required', {
            slot,
            instanceId,
            committedInstanceId: member.instanceId,
            generation: record.generation,
          });
          return notReady(COORDINATION_ERROR_CODE.SLOT_CONFLICT);
        }
        const runtime = options.runtimeFactory({
          manifest: resolved.manifest,
          profile: resolved.profile,
          binding: resolved.binding,
          generation: record.generation,
          target: false,
          slot,
          instanceId,
        });
        current = {
          binding: resolved.binding,
          generation: record.generation,
          manifest: resolved.manifest,
          profile: resolved.profile,
          runtime,
          descriptorSha256: resolved.descriptorSha256,
          operations: resolved.operations,
        };
        // Step 5: immediately before reporting readiness, reread the authority.
        // Compare identity, not the revision: adopting this process's own slot
        // membership is a legitimate revision bump.
        const recheck = store.readRecord();
        if (
          recheck.phase !== PHASE.ACTIVE ||
          recheck.generation !== record.generation ||
          !bindingEqual(recheck.active, resolved.binding) ||
          recheck.releaseDescriptorSha256 !== resolved.descriptorSha256
        ) {
          current = null;
          return notReady(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
        }
        if (!recheck.members.some((candidate) => candidate.slot === slot && candidate.instanceId === instanceId)) {
          current = null;
          return notReady(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
        }
        admissionOpen = true;
        identityReady = true;
        inferenceEnabled = true;
        lastErrorCode = null;
        logger.info('AI identity validated', {
          slot,
          instanceId,
          generation: record.generation,
          manifestVersion: resolved.manifest.manifestVersion,
        });
        return status();
      }

      if (record.phase === PHASE.PREPARING) {
        const targetDescriptor = store.readReleaseDescriptor(record.transition.descriptorSha256, {
          policy: options.policy,
        }).descriptor;
        const resolved = resolveBinding(record, record.target, record.transition.descriptorSha256, {
          inventory: targetDescriptor.inventory,
        });
        const descriptorSha = assertArtifactAssignment(record, record.target);
        const targetMember = record.transition.targetMembers.find(
          (candidate) => candidate.slot === slot && candidate.instanceId === instanceId,
        );
        if (!targetMember) {
          retryingTransact((observed) => ({
            action: 'register-target',
            descriptor: store.readReleaseDescriptor(observed.transition.descriptorSha256, { policy: options.policy }).descriptor,
            slot,
            instanceId,
            artifactSha256: config.artifactSha256,
          }), { purpose: 'register-target' });
        }
        prepared = {
          binding: resolved.binding,
          generation: record.nextGeneration,
          manifest: resolved.manifest,
          profile: resolved.profile,
          runtime: null,
          descriptorSha256: descriptorSha,
          grant: null,
        };
        identityReady = true;
        inferenceEnabled = false;
        admissionOpen = false;
        lastErrorCode = null;
        logger.info('AI identity validated for a staging target', {
          slot,
          instanceId,
          generation: record.nextGeneration,
        });
        return status();
      }

      // QUIESCING / ARMED / PAUSED: a participant must not serve new work.
      return notReady(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED);
    } catch (error) {
      return notReady(error instanceof CoordinationError ? error.code : COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
    }
  }

  /**
   * Synchronous admission. Increments the whole-work counter before the caller
   * can await anything.
   *
   * @param {string} operation
   * @returns {Readonly<object>} work token
   */
  function beginWork(operation) {
    if (options.observer === true) {
      fail(COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED, 'an observer cannot perform AI work');
    }
    if (!admissionOpen || current === null) {
      fail(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, 'AI admission is closed', { phase });
    }
    if (!current.operations.includes(operation)) {
      fail(COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED, `operation ${operation} is not admitted for slot ${slot}`, {
        operation,
      });
    }
    /** @type {any} */
    let record;
    try {
      record = store.readRecord();
    } catch (error) {
      closeAdmission(COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE);
      fail(
        COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE,
        'the control record is not readable; AI work is gated',
        { cause: error instanceof CoordinationError ? error.code : null },
      );
    }
    lastCheckAt = clock();
    try {
      assertActiveBinding(record);
    } catch (error) {
      closeAdmission(error instanceof CoordinationError ? error.code : COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
      throw error;
    }
    if (!record.members.some((member) => member.slot === slot && member.instanceId === instanceId)) {
      closeAdmission(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
      fail(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH, 'this instance is not the admitted member of its slot');
    }
    const token = Object.freeze({
      id: ++workSequence,
      operation,
      generation: current.generation,
      binding: current.binding,
      deploymentId: config.deploymentId,
      slot,
      instanceId,
      startedAt: lastCheckAt,
    });
    work.set(token.id, token);
    return token;
  }

  /**
   * @param {any} token
   */
  function check(token) {
    if (!token || !work.has(token.id)) {
      fail(COORDINATION_ERROR_CODE.GENERATION_RETIRED, 'work token is not active');
    }
    if (!admissionOpen) {
      fail(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, 'AI admission closed while work was outstanding');
    }
    /** @type {any} */
    let record;
    try {
      record = store.readRecord();
    } catch {
      closeAdmission(COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE);
      fail(COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE, 'the control record became unreadable; result discarded');
    }
    lastCheckAt = clock();
    try {
      assertActiveBinding(record);
    } catch (error) {
      closeAdmission(error instanceof CoordinationError ? error.code : COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
      throw error;
    }
    if (token.generation !== record.generation) {
      closeAdmission(COORDINATION_ERROR_CODE.GENERATION_RETIRED);
      fail(COORDINATION_ERROR_CODE.GENERATION_RETIRED, 'the generation changed while work was in flight');
    }
    const operations = slotOperations(record, slot);
    if (!operations || !operations.includes(token.operation)) {
      closeAdmission(COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED);
      fail(COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED, 'the slot no longer admits this operation');
    }
    if (!record.members.some((member) => member.slot === slot && member.instanceId === instanceId)) {
      closeAdmission(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
      fail(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH, 'this instance is no longer the admitted member of its slot');
    }
  }

  /**
   * Retain a counted token whose effect outcome is unknown. The token stays
   * outstanding on purpose: `endWork` refuses to release it, so drain and the
   * QUIESCED acknowledgement cannot complete until the outcome is reconciled.
   *
   * @param {any} token
   * @param {string} reason
   * @returns {Readonly<object>}
   */
  function retainWork(token, reason) {
    if (!token || !work.has(token.id)) {
      fail(COORDINATION_ERROR_CODE.GENERATION_RETIRED, 'work token is not active');
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      fail(COORDINATION_ERROR_CODE.INTERNAL_ERROR, 'retaining an unresolved effect requires a reason');
    }
    const entry = Object.freeze({
      workId: token.id,
      operation: token.operation,
      reason: reason.trim(),
      generation: token.generation,
      at: clock(),
    });
    unresolved.set(token.id, entry);
    logger.warn('AI-derived effect outcome is unknown; the work scope is retained', {
      slot,
      instanceId,
      workId: token.id,
      operation: token.operation,
    });
    return entry;
  }

  /**
   * Release a retained token after an operator reconciled the exchange outcome.
   * Requires the operator's reference and writes it to the durable audit before
   * the token is released: without durable evidence nothing is released.
   *
   * @param {{ workId: number | string, reference: string }} input
   * @returns {Readonly<object>}
   */
  function reconcileUnresolved(input = {}) {
    const workId = Number(input.workId);
    const reference = input.reference;
    const entry = unresolved.get(workId);
    if (!entry) {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'no unresolved AI effect carries that work id', { workId });
    }
    if (typeof reference !== 'string' || reference.trim() === '') {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'reconciling an unresolved AI effect requires an operator reference', {
        workId,
      });
    }
    store.appendAudit({
      kind: 'effect.reconciled',
      deploymentId: config.deploymentId,
      slot,
      instanceId,
      workId,
      operation: entry.operation,
      generation: entry.generation,
      reference: reference.trim(),
    });
    unresolved.delete(workId);
    work.delete(workId);
    if (work.size === 0 && approvals.size === 0) {
      for (const waiter of drainWaiters) waiter();
      drainWaiters.clear();
    }
    logger.info('unresolved AI effect reconciled', { slot, instanceId, workId, reference: reference.trim() });
    return Object.freeze({ workId, reference: reference.trim() });
  }

  /**
   * @param {any} token
   */
  function endWork(token) {
    if (!token || !work.has(token.id)) return;
    // A retained token is the durable statement that an exchange outcome is
    // unknown; releasing it here would let a QUIESCED ack hide an open order.
    if (unresolved.has(token.id)) return;
    work.delete(token.id);
    if (work.size === 0 && approvals.size === 0) {
      for (const waiter of drainWaiters) waiter();
      drainWaiters.clear();
    }
  }

  /**
   * Resolves once no counted work and no pending approval remain.
   *
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<boolean>}
   */
  function drain(opts = {}) {
    if (work.size === 0 && approvals.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      /** @type {NodeJS.Timeout | null} */
      let timer = null;
      const waiter = () => {
        if (timer) clearTimeout(timer);
        drainWaiters.delete(waiter);
        resolve(work.size === 0 && approvals.size === 0);
      };
      drainWaiters.add(waiter);
      if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          drainWaiters.delete(waiter);
          resolve(false);
        }, opts.timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
    });
  }

  /**
   * Write a QUIESCED acknowledgement. Refuses while work or pending approvals
   * remain: that is the whole-work fence.
   *
   * @returns {Readonly<object>}
   */
  function acknowledgeQuiesced() {
    if (options.observer === true) {
      fail(COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED, 'an observer does not acknowledge quiescence');
    }
    /** @type {any} */
    let record;
    try {
      record = store.readRecord();
    } catch {
      fail(COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE, 'cannot read the control record to acknowledge quiescence');
    }
    if (record.phase !== PHASE.QUIESCING && record.phase !== PHASE.PREPARING) {
      fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, `cannot acknowledge quiescence in phase ${record.phase}`);
    }
    if (!record.transitionId || record.nextGeneration === null) {
      fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, 'the barrier has no transition or reservation');
    }
    if (current === null) {
      fail(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH, 'this process has no committed generation to retire');
    }
    if (unresolved.size > 0) {
      fail(
        COORDINATION_ERROR_CODE.WORK_OUTSTANDING,
        'an unknown AI-derived effect outcome prevents a QUIESCED acknowledgement until it is reconciled',
        { unresolvedEffects: unresolved.size },
      );
    }
    if (work.size > 0) {
      fail(COORDINATION_ERROR_CODE.WORK_OUTSTANDING, 'outstanding AI work prevents a QUIESCED acknowledgement', {
        outstandingWork: work.size,
      });
    }
    if (approvals.size > 0) {
      fail(COORDINATION_ERROR_CODE.APPROVAL_PENDING, 'pending AI approvals prevent a QUIESCED acknowledgement', {
        pendingAIApprovals: approvals.size,
      });
    }
    const member = record.transition.oldMembers.find(
      (candidate) => candidate.slot === slot && candidate.instanceId === instanceId,
    );
    if (!member && !record.members.some((candidate) => candidate.slot === slot && candidate.instanceId === instanceId)) {
      fail(COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED, 'this instance is not an old member of the barrier');
    }
    admissionOpen = false;
    inferenceEnabled = false;
    const ack = Object.freeze({
      schemaVersion: 1,
      deploymentId: config.deploymentId,
      transitionId: record.transitionId,
      targetGeneration: record.nextGeneration,
      slot,
      instanceId,
      artifactSha256: config.artifactSha256 ?? current.binding.artifactSetSha256,
      status: ACK_STATUS.QUIESCED,
      manifestVersion: current.binding.manifestVersion,
      manifestSha256: current.binding.manifestSha256,
      capabilityProfileSha256: current.binding.capabilityProfileSha256,
      inventorySha256: current.binding.inventorySha256,
      outstandingWork: 0,
      pendingAIApprovals: 0,
      errorCode: null,
    });
    const written = store.writeAck(record.transitionId, slot, instanceId, ACK_STATUS.QUIESCED, ack);
    ackWrittenFor = record.transitionId;
    phase = record.phase;
    logger.info('quiescence acknowledged', { slot, instanceId, transitionId: record.transitionId });
    return Object.freeze({ ack, path: written.path, sha256: written.sha256 });
  }

  /**
   * Stage the exact approved target runtime for this instance. Requires either a
   * trusted stageGrant (retained instance) or a target-only registration.
   *
   * @param {{ descriptorSha256: string, approvalId: string } | null} [grant]
   * @returns {Readonly<object>}
   */
  function prepareTarget(grant = null) {
    if (options.observer === true) {
      fail(COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED, 'an observer does not stage an inference runtime');
    }
    /** @type {any} */
    let record;
    try {
      record = store.readRecord();
    } catch {
      fail(COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE, 'cannot read the control record to prepare');
    }
    if (record.phase !== PHASE.PREPARING) {
      fail(COORDINATION_ERROR_CODE.INVALID_TRANSITION, `staging is only legal in PREPARING (phase ${record.phase})`);
    }
    const transition = record.transition;
    const targetMember = transition.targetMembers.find(
      (candidate) => candidate.slot === slot && candidate.instanceId === instanceId,
    );
    const trustedGrant = transition.stageGrants.find(
      (candidate) => candidate.slot === slot && candidate.instanceId === instanceId,
    );
    if (!targetMember && !trustedGrant) {
      fail(COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED, 'this instance holds no target slot and no stage grant');
    }
    if (grant !== null) {
      if (
        !trustedGrant ||
        trustedGrant.descriptorSha256 !== grant.descriptorSha256 ||
        trustedGrant.approvalId !== grant.approvalId ||
        grant.descriptorSha256 !== transition.descriptorSha256 ||
        grant.approvalId !== record.approvalId
      ) {
        fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'stage grant does not match the trusted control record');
      }
    } else if (!trustedGrant) {
      // A target-only instance registered during PREPARING may stage without a
      // grant; a retained old instance needs one.
      const isOld = transition.oldMembers.some(
        (candidate) => candidate.slot === slot && candidate.instanceId === instanceId,
      );
      if (isOld) {
        fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'a retained instance requires a stage grant before staging');
      }
    }
    const targetDescriptor = store.readReleaseDescriptor(transition.descriptorSha256, { policy: options.policy }).descriptor;
    const resolved = resolveBinding(record, record.target, transition.descriptorSha256, {
      inventory: targetDescriptor.inventory,
      // Only a trusted grant bound to this exact descriptor and approval may
      // install staged expectations that differ from the launch environment.
      skipLaunchExpectations: Boolean(
        trustedGrant &&
        trustedGrant.descriptorSha256 === transition.descriptorSha256 &&
        trustedGrant.approvalId === record.approvalId,
      ),
    });
    assertArtifactAssignment(record, record.target);
    if (targetMember && targetMember.artifactSha256 !== config.artifactSha256) {
      fail(COORDINATION_ERROR_CODE.ARTIFACT_MISMATCH, 'target membership artifact does not match this build');
    }
    const runtime = options.runtimeFactory({
      manifest: resolved.manifest,
      profile: resolved.profile,
      binding: resolved.binding,
      generation: record.nextGeneration,
      target: true,
      slot,
      instanceId,
    });
    prepared = {
      binding: resolved.binding,
      generation: record.nextGeneration,
      manifest: resolved.manifest,
      profile: resolved.profile,
      runtime,
      descriptorSha256: transition.descriptorSha256,
      grant: trustedGrant ?? null,
    };
    const ack = Object.freeze({
      schemaVersion: 1,
      deploymentId: config.deploymentId,
      transitionId: record.transitionId,
      targetGeneration: record.nextGeneration,
      slot,
      instanceId,
      artifactSha256: config.artifactSha256,
      status: ACK_STATUS.PREPARED,
      manifestVersion: resolved.binding.manifestVersion,
      manifestSha256: resolved.binding.manifestSha256,
      capabilityProfileSha256: resolved.binding.capabilityProfileSha256,
      inventorySha256: resolved.binding.inventorySha256,
      outstandingWork: 0,
      pendingAIApprovals: 0,
      errorCode: null,
    });
    const written = store.writeAck(record.transitionId, slot, instanceId, ACK_STATUS.PREPARED, ack);
    phase = record.phase;
    logger.info('target runtime prepared', { slot, instanceId, generation: record.nextGeneration });
    return Object.freeze({ ack, path: written.path, sha256: written.sha256, generation: record.nextGeneration });
  }

  /**
   * Promote the staged runtime only after the committed ACTIVE record matches it
   * exactly (activation linearization point).
   *
   * @returns {Readonly<object>}
   */
  function activateFromControl() {
    if (prepared === null) {
      fail(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, 'no staged runtime exists to activate');
    }
    /** @type {any} */
    const record = store.readRecord();
    if (record.phase !== PHASE.ACTIVE) {
      fail(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, `the committed phase is ${record.phase}, not ACTIVE`);
    }
    if (record.generation !== prepared.generation) {
      fail(COORDINATION_ERROR_CODE.GENERATION_RETIRED, 'the committed generation differs from the staged generation');
    }
    if (!bindingEqual(record.active, prepared.binding)) {
      fail(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH, 'the committed binding differs from the staged binding');
    }
    if (record.releaseDescriptorSha256 !== prepared.descriptorSha256) {
      fail(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH, 'the committed descriptor differs from the staged descriptor');
    }
    const member = record.members.find((candidate) => candidate.slot === slot);
    if (!member || member.instanceId !== instanceId) {
      fail(COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED, 'the committed roster does not admit this instance');
    }
    if (config.artifactSha256 !== null && member.artifactSha256 !== config.artifactSha256) {
      fail(COORDINATION_ERROR_CODE.ARTIFACT_MISMATCH, 'the committed roster does not authorize this artifact');
    }
    current = {
      binding: prepared.binding,
      generation: prepared.generation,
      manifest: prepared.manifest,
      profile: prepared.profile,
      runtime: prepared.runtime,
      descriptorSha256: prepared.descriptorSha256,
      operations: slotOperations(record, slot) ?? [],
    };
    prepared = null;
    phase = PHASE.ACTIVE;
    ackWrittenFor = null;
    admissionOpen = true;
    identityReady = true;
    inferenceEnabled = true;
    lastErrorCode = null;
    lastCheckAt = clock();
    logger.info('generation activated', { slot, instanceId, generation: record.generation });
    return status();
  }

  /**
   * Diagnostic poll. Not a lease: safety never depends on it. It exists so an
   * idle participant still observes quiescence, writes its ack and promotes a
   * staged runtime.
   *
   * @returns {Readonly<object>}
   */
  function poll() {
    /** @type {any} */
    let record;
    try {
      record = store.readRecord();
    } catch (error) {
      closeAdmission(COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE);
      identityReady = false;
      lastErrorCode = COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE;
      return status();
    }
    lastCheckAt = clock();
    phase = record.phase;
    if (record.deploymentId !== config.deploymentId) {
      return notReady(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
    }
    if (options.observer === true) {
      identityReady = record.phase === PHASE.ACTIVE;
      inferenceEnabled = false;
      admissionOpen = false;
      return status();
    }
    if (record.phase === PHASE.ACTIVE) {
      if (current !== null && record.generation === current.generation && bindingEqual(record.active, current.binding)) {
        const member = record.members.find((candidate) => candidate.slot === slot);
        if (!member || member.instanceId !== instanceId) {
          return notReady(COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
        }
        identityReady = true;
        if (!admissionOpen) {
          admissionOpen = true;
          logger.info('AI admission reopened for the committed generation', { slot, generation: record.generation });
        }
        inferenceEnabled = true;
        lastErrorCode = null;
        return status();
      }
      if (
        prepared !== null &&
        prepared.runtime !== null &&
        record.generation === prepared.generation &&
        bindingEqual(record.active, prepared.binding)
      ) {
        try {
          return activateFromControl();
        } catch (error) {
          return notReady(error instanceof CoordinationError ? error.code : COORDINATION_ERROR_CODE.INTERNAL_ERROR);
        }
      }
      if (current === null) {
        return notReady(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED);
      }
      closeAdmission(COORDINATION_ERROR_CODE.GENERATION_RETIRED);
      return status();
    }

    // Any non-ACTIVE phase closes admission immediately.
    closeAdmission(record.phase === PHASE.PAUSED ? COORDINATION_ERROR_CODE.ACTIVATION_PAUSED : COORDINATION_ERROR_CODE.GENERATION_RETIRED);
    identityReady = record.phase !== PHASE.PAUSED && (current !== null || prepared !== null);
    if (
      current !== null &&
      (record.phase === PHASE.QUIESCING || record.phase === PHASE.PREPARING) &&
      record.transitionId &&
      ackWrittenFor !== record.transitionId &&
      work.size === 0 &&
      approvals.size === 0
    ) {
      try {
        acknowledgeQuiesced();
      } catch (error) {
        // A refusal here is expected while work is draining; the coordinator
        // will see no ack and the barrier stays blocked.
        lastErrorCode = error instanceof CoordinationError ? error.code : lastErrorCode;
      }
    }
    return status();
  }

  /**
   * @param {{ intervalMs?: number }} [opts]
   */
  function startPolling(opts = {}) {
    if (pollTimer !== null) return;
    const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 1000;
    pollTimer = setInterval(() => {
      try {
        poll();
      } catch (error) {
        logger.warn('AI control poll failed', {
          slot,
          code: error instanceof CoordinationError ? error.code : null,
        });
      }
    }, intervalMs);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function stopPolling() {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
  }

  /**
   * Register a pending human AI approval. Only an admitted generation may hold
   * one; the sidecar is process-local and dies with the process.
   *
   * @param {string} approvalId
   * @param {{ operation?: string }} [meta]
   * @returns {Readonly<object>}
   */
  function registerPendingApproval(approvalId, meta = {}) {
    if (typeof approvalId !== 'string' || approvalId === '') {
      fail(COORDINATION_ERROR_CODE.INTERNAL_ERROR, 'approval id must be a non-empty string');
    }
    if (!admissionOpen || current === null) {
      fail(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, 'cannot register an AI approval while AI is paused');
    }
    if (approvals.has(approvalId)) {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'approval id is already pending');
    }
    approvals.set(approvalId, {
      generation: current.generation,
      binding: current.binding,
      operation: typeof meta.operation === 'string' ? meta.operation : 'GUARD',
      purpose: 'approval',
      createdAt: clock(),
    });
    return Object.freeze({ approvalId, generation: current.generation });
  }

  /**
   * Bind a *pending effect* sidecar: convert a counted work token whose AI
   * analysis is finished into the durable, process-local provenance for the
   * effect that will follow (a preview ticket, an exit proposal). The sidecar is
   * registered before the counted token is released, so there is no accounting
   * gap: the drain barrier is never satisfied between the two.
   *
   * Refused when the generation/binding moved in between — the analysis no
   * longer belongs to the running generation, so no effect may be derived from
   * it.
   *
   * @param {string} approvalId
   * @param {any} token counted work token
   * @param {{ operation?: string, purpose?: string }} [meta]
   * @returns {Readonly<object>}
   */
  function holdApprovalForEffect(approvalId, token, meta = {}) {
    if (typeof approvalId !== 'string' || approvalId === '') {
      fail(COORDINATION_ERROR_CODE.INTERNAL_ERROR, 'effect approval id must be a non-empty string');
    }
    if (!token || !work.has(token.id)) {
      fail(COORDINATION_ERROR_CODE.GENERATION_RETIRED, 'the counted work token is not active');
    }
    if (unresolved.has(token.id)) {
      fail(COORDINATION_ERROR_CODE.WORK_OUTSTANDING, 'an unresolved effect cannot become a pending approval');
    }
    if (!admissionOpen || current === null) {
      fail(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, 'cannot hold an AI effect while AI is paused');
    }
    if (approvals.has(approvalId)) {
      fail(COORDINATION_ERROR_CODE.INVALID_EVIDENCE, 'approval id is already pending');
    }
    if (token.generation !== current.generation || !bindingEqual(token.binding, current.binding)) {
      fail(COORDINATION_ERROR_CODE.GENERATION_RETIRED, 'the generation changed before the AI effect could be bound');
    }
    approvals.set(approvalId, {
      generation: token.generation,
      binding: token.binding,
      operation: typeof meta.operation === 'string' ? meta.operation : token.operation,
      purpose: typeof meta.purpose === 'string' ? meta.purpose : 'effect',
      createdAt: clock(),
    });
    work.delete(token.id);
    return Object.freeze({ approvalId, generation: token.generation, purpose: typeof meta.purpose === 'string' ? meta.purpose : 'effect' });
  }

  /**
   * Consume a pending approval or pending effect: synchronously acquires a
   * counted work token for the same ACTIVE generation and atomically removes the
   * sidecar before the caller's first await. Duplicate or stale callbacks are
   * rejected.
   *
   * The returned handle is the whole effect lifecycle:
   *   `check()`  — reread the control record immediately before the dispatch;
   *   `settle()` — the dispatch outcome is known (placed or definitely refused);
   *   `retain()` — the outcome is unknown; keep the scope counted until an
   *                operator reconciles it;
   *   `rearm()`  — the effect definitely did not happen; keep the provenance in
   *                place so the operator can retry without a new analysis.
   *
   * @param {string} approvalId
   * @returns {Readonly<{ approvalId: string, token: any, operation: string, check: Function, settle: Function, retain: Function, rearm: Function }>}
   */
  function beginApprovalConsumption(approvalId) {
    if (!admissionOpen || current === null) {
      fail(COORDINATION_ERROR_CODE.ACTIVATION_PAUSED, 'AI is not active; the pending approval cannot be consumed');
    }
    const entry = approvals.get(approvalId);
    if (!entry) {
      fail(COORDINATION_ERROR_CODE.APPROVAL_INVALID, 'no pending AI approval carries this id for the current generation');
    }
    if (entry.generation !== current.generation || !bindingEqual(entry.binding, current.binding)) {
      approvals.delete(approvalId);
      fail(COORDINATION_ERROR_CODE.GENERATION_RETIRED, 'the pending approval belongs to a retired generation');
    }
    const token = beginWork(entry.operation);
    approvals.delete(approvalId);
    let settled = false;
    return Object.freeze({
      approvalId,
      token,
      operation: entry.operation,
      generation: entry.generation,
      purpose: entry.purpose,
      check: () => check(token),
      settle: () => {
        if (settled) return;
        settled = true;
        endWork(token);
      },
      retain: (reason) => {
        if (settled) {
          fail(COORDINATION_ERROR_CODE.INTERNAL_ERROR, 'a settled effect cannot be retained as unresolved');
        }
        settled = true;
        return retainWork(token, reason);
      },
      rearm: (nextApprovalId = approvalId, meta = {}) => {
        if (settled) {
          fail(COORDINATION_ERROR_CODE.INTERNAL_ERROR, 'a settled effect cannot be re-armed');
        }
        const held = holdApprovalForEffect(
          typeof nextApprovalId === 'string' && nextApprovalId !== '' ? nextApprovalId : approvalId,
          token,
          {
            operation: entry.operation,
            purpose: entry.purpose,
            ...meta,
          },
        );
        settled = true;
        return held;
      },
    });
  }

  /**
   * @returns {number}
   */
  function pendingApprovalCount() {
    return approvals.size;
  }

  /**
   * Drop one pending approval without consuming it (decline, cancel, restart of
   * the card flow). Returns true when something was dropped.
   *
   * @param {string} approvalId
   * @returns {boolean}
   */
  function dropPendingApproval(approvalId) {
    return approvals.delete(approvalId);
  }

  /**
   * Liveness/diagnostic read of the control record; never opens admission.
   *
   * @returns {Readonly<object> | null}
   */
  function peekControl() {
    try {
      return store.readRecord();
    } catch {
      return null;
    }
  }

  return Object.freeze({
    deploymentId: config.deploymentId,
    slot,
    instanceId,
    start,
    beginWork,
    check,
    endWork,
    retainWork,
    reconcileUnresolved,
    drain,
    acknowledgeQuiesced,
    prepareTarget,
    activateFromControl,
    poll,
    startPolling,
    stopPolling,
    status,
    closeAdmission,
    registerPendingApproval,
    holdApprovalForEffect,
    beginApprovalConsumption,
    invalidatePendingApprovals,
    pendingApprovalCount,
    dropPendingApproval,
    peekControl,
    getRuntime: () => current?.runtime ?? null,
    getBinding: () => current?.binding ?? null,
    getGeneration: () => current?.generation ?? null,
    getPhase: () => phase,
    getPrepared: () => (prepared === null ? null : Object.freeze({
      generation: prepared.generation,
      binding: prepared.binding,
      descriptorSha256: prepared.descriptorSha256,
    })),
  });
}

/**
 * Build a closed observer receipt from a validation result.
 *
 * @param {Readonly<object>} validation output of {@link validateObserverIdentity}
 * @param {{ deploymentId: string, transitionId: string, observerId: string, artifactSha256: string }} context
 * @returns {Readonly<object>}
 */
export function buildObserverReceipt(validation, context) {
  const receipt = {
    schemaVersion: 1,
    deploymentId: context.deploymentId,
    transitionId: context.transitionId,
    observerId: context.observerId,
    artifactSha256: context.artifactSha256,
    manifestVersion: validation.manifestVersion ?? 'unknown',
    manifestSha256: validation.manifestSha256 ?? '0'.repeat(64),
    capabilityProfileSha256: validation.capabilityProfileSha256 ?? '0'.repeat(64),
    status: validation.identityValidated ? OBSERVER_STATUS.VALIDATED : OBSERVER_STATUS.ERROR,
    errorCode: validation.identityValidated ? null : validation.errorCode ?? COORDINATION_ERROR_CODE.IDENTITY_MISMATCH,
  };
  return validateObserverReceipt(receipt, { label: 'observer receipt' });
}
