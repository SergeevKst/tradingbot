/**
 * Pure release state machine (UAI-05B, amendment §9.3).
 *
 * Every legal phase edge is implemented here as a pure function of the previous
 * validated `ControlRecord` and an explicit command. Nothing in this module
 * reads or writes the filesystem, calls a clock or talks to a process: the store
 * supplies durability and compare-and-swap, the coordinator supplies evidence,
 * and the operator supplies fencing truth.
 *
 * Invariants enforced here, not by convention:
 *   - a generation is reserved (high-water + 1) before a transition starts and
 *     is never reused, including on rollback to the same digest;
 *   - every old member is quiesced or fenced before the barrier can advance;
 *   - every enabled target slot prepares exactly once before ARMED;
 *   - pause retains the entire transition; recovery starts a *fresh* generation
 *     and fresh acknowledgements while keeping every old and target obligation;
 *   - no edge other than the documented ones is accepted, and there is no
 *     quorum, timeout or majority shortcut.
 *
 * @module ai/coordination/release-state
 */
import {
  ACK_STATUS,
  OBSERVER_STATUS,
  PHASE,
  TRANSITION_PHASES,
  computeInventoryDigest,
  computeReleaseDescriptorDigest,
  validateAck,
  validateControlRecord,
  validateFenceEvidence,
  validateInventory,
  validateObserverReceipt,
  validateReleaseDescriptor,
} from '../../config/ai-release-schema.mjs';
import { COORDINATION_ERROR_CODE, CoordinationError } from '../../errors/coordination-error.mjs';

/** Commands accepted by {@link applyReleaseCommand}. */
export const RELEASE_ACTION = Object.freeze({
  QUIESCE: 'quiesce',
  PREPARE: 'prepare',
  ARM: 'arm',
  ACTIVATE: 'activate',
  PAUSE: 'pause',
  RECOVER: 'recover',
  REGISTER_TARGET: 'register-target',
  REMOVE_TARGET: 'remove-target',
  RETIRE: 'retire',
  PREPARE_ACK: 'prepare-ack',
  OBSERVER_EVIDENCE: 'observer-evidence',
  STAGE_GRANT: 'stage-grant',
});

/**
 * @param {string} message
 * @param {string} code
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
function reject(message, code, details) {
  throw new CoordinationError(message, { code, details });
}

/**
 * @param {any} record
 * @returns {number}
 */
function nextRevision(record) {
  const revision = record.revision + 1;
  if (!Number.isSafeInteger(revision)) {
    reject('control revision would overflow', COORDINATION_ERROR_CODE.INVALID_TRANSITION, { revision: record.revision });
  }
  return revision;
}

/**
 * @param {any} record
 * @param {string} action
 * @returns {never}
 */
function illegalPhase(record, action) {
  reject(`release action ${action} is not legal in phase ${record.phase}`, COORDINATION_ERROR_CODE.INVALID_TRANSITION, {
    action,
    phase: record.phase,
  });
}

/**
 * @param {Readonly<object>[]} members
 * @returns {Map<string, Readonly<object>>}
 */
function memberIndex(members) {
  const index = new Map();
  for (const member of members) index.set(`${member.slot}\u0000${member.instanceId}`, member);
  return index;
}

/**
 * Retirement state for one old member.
 *
 * @param {any} transition
 * @param {string} slot
 * @param {string} instanceId
 * @returns {{ quiesced: boolean, fenced: boolean, evidenceSha256: string | null }}
 */
export function retirementState(transition, slot, instanceId) {
  let quiesced = false;
  let fenced = false;
  let evidenceSha256 = null;
  for (const entry of transition?.retirementEvidence ?? []) {
    if (entry.slot !== slot || entry.instanceId !== instanceId) continue;
    if (entry.kind === 'QUIESCED') {
      quiesced = true;
      evidenceSha256 = entry.evidenceSha256;
    }
    if (entry.kind === 'FENCED') {
      fenced = true;
      evidenceSha256 = entry.evidenceSha256;
    }
  }
  return { quiesced, fenced, evidenceSha256 };
}

/**
 * True when a participant is retired from the old generation (drained or
 * operator-fenced).
 *
 * @param {any} transition
 * @param {string} slot
 * @param {string} instanceId
 * @returns {boolean}
 */
function isRetired(transition, slot, instanceId) {
  const state = retirementState(transition, slot, instanceId);
  return state.quiesced || state.fenced;
}

/**
 * @param {any} ack validated acknowledgement
 * @returns {string}
 */
function ackKey(ack) {
  return `${ack.slot}\u0000${ack.instanceId}`;
}

/**
 * Collect the target-side requirements that block ARMED, for the coordinator
 * and for `inspect --verbose`. Pure reporting, no mutation.
 *
 * @param {any} record
 * @param {any} descriptor
 * @param {{ observerReceipts?: readonly any[] }} [options]
 * @returns {{ blockers: string[], missingRetirement: string[], missingPrepare: string[], missingObservers: string[] }}
 */
export function describeBarrierBlockers(record, descriptor, options = {}) {
  const blockers = [];
  /** @type {string[]} */
  const missingRetirement = [];
  /** @type {string[]} */
  const missingPrepare = [];
  /** @type {string[]} */
  const missingObservers = [];
  if (record.transition === null) {
    return { blockers: ['phase has no retained transition'], missingRetirement, missingPrepare, missingObservers };
  }
  for (const member of record.transition.oldMembers) {
    if (!isRetired(record.transition, member.slot, member.instanceId)) {
      missingRetirement.push(`${member.slot}/${member.instanceId}`);
    }
  }
  if (missingRetirement.length > 0) blockers.push(`old members not retired: ${missingRetirement.join(', ')}`);

  for (const entry of descriptor.inventory) {
    if (!entry.enabled) continue;
    const candidates = targetCandidates(record, descriptor).get(entry.slot) ?? [];
    const prepared = record.transition.prepareEvidence.filter((evidence) => evidence.slot === entry.slot);
    if (candidates.length === 0) {
      missingPrepare.push(`${entry.slot} (no registered target member)`);
      continue;
    }
    if (candidates.length > 1) {
      blockers.push(`slot ${entry.slot} has ${candidates.length} target candidates`);
    }
    if (prepared.length === 0) {
      missingPrepare.push(`${entry.slot} (no PREPARED evidence)`);
    }
  }
  for (const slot of missingPrepare) blockers.push(`target slot not prepared: ${slot}`);

  const receipts = options.observerReceipts ?? [];
  for (const observer of descriptor.observers) {
    if (!observer.required) continue;
    const entry = record.transition.observerEvidence.find((evidence) => evidence.observerId === observer.observerId);
    if (!entry) {
      missingObservers.push(observer.observerId);
      continue;
    }
    const receipt = receipts.find((candidate) => candidate?.observerId === observer.observerId);
    if (!receipt || receipt.status !== OBSERVER_STATUS.VALIDATED) {
      missingObservers.push(`${observer.observerId} (no VALIDATED receipt)`);
    }
  }
  for (const observer of missingObservers) blockers.push(`required observer missing: ${observer}`);
  return { blockers, missingRetirement, missingPrepare, missingObservers };
}

/**
 * @param {any} descriptor
 * @returns {Map<string, string>} slot -> artifactSha256
 */
function descriptorArtifacts(descriptor) {
  const map = new Map();
  for (const artifact of descriptor.artifacts) map.set(artifact.slot, artifact.artifactSha256);
  return map;
}

/**
 * Every participant that can be admitted to the target generation: target-only
 * registrations plus retained instances holding a trusted stage grant.
 *
 * @param {any} record
 * @param {any} descriptor
 * @returns {Map<string, { instanceId: string, artifactSha256: string, kind: 'target' | 'retained' }[]>}
 */
function targetCandidates(record, descriptor) {
  const artifacts = descriptorArtifacts(descriptor);
  /** @type {Map<string, { instanceId: string, artifactSha256: string, kind: 'target' | 'retained' }[]>} */
  const bySlot = new Map();
  const push = (slot, candidate) => {
    const list = bySlot.get(slot) ?? [];
    list.push(candidate);
    bySlot.set(slot, list);
  };
  for (const member of record.transition.targetMembers) {
    push(member.slot, {
      instanceId: member.instanceId,
      artifactSha256: member.artifactSha256,
      kind: /** @type {'target'} */ ('target'),
    });
  }
  for (const grant of record.transition.stageGrants) {
    push(grant.slot, {
      instanceId: grant.instanceId,
      artifactSha256: artifacts.get(grant.slot) ?? '',
      kind: /** @type {'retained'} */ ('retained'),
    });
  }
  return bySlot;
}

/**
 * @param {any} record
 * @param {any} descriptor
 * @param {string} action
 */
function assertDescriptorMatchesTransition(record, descriptor, action) {
  if (record.transition === null) illegalPhase(record, action);
  const digest = computeReleaseDescriptorDigest(descriptor);
  if (digest !== record.transition.descriptorSha256) {
    reject(`descriptor digest does not match the reserved transition target`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE, {
      descriptorSha256: digest,
      expected: record.transition.descriptorSha256,
    });
  }
  if (record.target === null) illegalPhase(record, action);
  for (const key of ['manifestVersion', 'manifestSha256', 'capabilityProfileSha256', 'inventorySha256', 'artifactSetSha256']) {
    if (descriptor.binding[key] !== record.target[key]) {
      reject(`descriptor binding ${key} does not match the reserved target binding`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE, {
        field: key,
      });
    }
  }
  if (record.approvalId !== null && descriptor.approvalId !== record.approvalId) {
    reject('descriptor approval does not match the reserved approval', COORDINATION_ERROR_CODE.INVALID_EVIDENCE, {
      field: 'approvalId',
    });
  }
}

/**
 * `quiesce`: ACTIVE (or bootstrap PAUSED) -> QUIESCING.
 *
 * @param {any} record
 * @param {{ descriptor: any, transitionId: string }} command
 * @returns {{ record: Readonly<object>, event: object }}
 */
function quiesce(record, command) {
  const allowed = record.phase === PHASE.ACTIVE || (record.phase === PHASE.PAUSED && record.transition === null);
  if (!allowed) illegalPhase(record, RELEASE_ACTION.QUIESCE);

  const descriptor = validateReleaseDescriptor(command.descriptor);
  const targetBinding = descriptor.binding;
  if (targetBinding.inventorySha256 !== computeInventoryDigest(descriptor.inventory)) {
    reject('descriptor inventory digest mismatch', COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }

  const reserved = record.highWaterGeneration + 1;
  if (!Number.isSafeInteger(reserved)) {
    reject('generation counter would overflow', COORDINATION_ERROR_CODE.INVALID_TRANSITION);
  }

  const transition = {
    descriptorSha256: computeReleaseDescriptorDigest(descriptor),
    // Snapshot of the last admitted generation. The initial barrier is
    // explicitly valid with an empty roster.
    oldMembers: record.members.map((member) => ({ ...member })),
    targetMembers: [],
    retirementEvidence: [],
    prepareEvidence: [],
    observerEvidence: [],
    stageGrants: [],
    abandonedTransitionId: command.abandonedTransitionId ?? null,
  };

  const next = validateControlRecord({
    ...record,
    revision: nextRevision(record),
    nextGeneration: reserved,
    phase: PHASE.QUIESCING,
    target: targetBinding,
    transitionId: command.transitionId,
    highWaterGeneration: reserved,
    approvalId: descriptor.approvalId,
    transition,
  });

  return {
    record: next,
    event: {
      action: RELEASE_ACTION.QUIESCE,
      fromPhase: record.phase,
      toPhase: PHASE.QUIESCING,
      fromGeneration: record.generation,
      toGeneration: reserved,
      oldMembers: transition.oldMembers.length,
      descriptorSha256: transition.descriptorSha256,
      approvalId: descriptor.approvalId,
    },
  };
}

/**
 * `prepare`: QUIESCING -> PREPARING once every old member is retired.
 *
 * @param {any} record
 * @returns {{ record: Readonly<object>, event: object }}
 */
function prepare(record) {
  if (record.phase !== PHASE.QUIESCING) illegalPhase(record, RELEASE_ACTION.PREPARE);
  const transition = record.transition;
  const missing = [];
  for (const member of transition.oldMembers) {
    if (!isRetired(transition, member.slot, member.instanceId)) {
      missing.push(`${member.slot}/${member.instanceId}`);
    }
  }
  if (missing.length > 0) {
    reject(
      `quiescence barrier incomplete: ${missing.length} old member(s) have no QUIESCED or FENCED evidence`,
      COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
      { missing },
    );
  }
  const next = validateControlRecord({
    ...record,
    revision: nextRevision(record),
    phase: PHASE.PREPARING,
  });
  return {
    record: next,
    event: { action: RELEASE_ACTION.PREPARE, fromPhase: record.phase, toPhase: PHASE.PREPARING, members: transition.oldMembers.length },
  };
}

/**
 * `arm`: PREPARING -> ARMED once every enabled target slot prepared and every
 * required observer receipt is valid. Membership and grants are frozen by the
 * phase itself: registration is only accepted in PREPARING.
 *
 * @param {any} record
 * @param {{ descriptor: any, observerReceipts?: readonly any[] }} command
 * @returns {{ record: Readonly<object>, event: object }}
 */
function arm(record, command) {
  if (record.phase !== PHASE.PREPARING) illegalPhase(record, RELEASE_ACTION.ARM);
  const descriptor = validateReleaseDescriptor(command.descriptor);
  assertDescriptorMatchesTransition(record, descriptor, RELEASE_ACTION.ARM);
  const transition = record.transition;

  for (const member of transition.oldMembers) {
    if (!isRetired(transition, member.slot, member.instanceId)) {
      reject(`old member ${member.slot}/${member.instanceId} lost its retirement evidence`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
    }
  }

  const artifacts = descriptorArtifacts(descriptor);
  const candidates = targetCandidates(record, descriptor);
  /** @type {Map<string, { instanceId: string, artifactSha256: string }>} */
  const chosen = new Map();
  for (const entry of descriptor.inventory) {
    if (!entry.enabled) continue;
    const list = candidates.get(entry.slot) ?? [];
    if (list.length === 0) {
      reject(`enabled target slot ${entry.slot} has no registered or granted participant`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE, {
        slot: entry.slot,
      });
    }
    if (list.length > 1) {
      reject(`enabled target slot ${entry.slot} has ${list.length} candidate participants`, COORDINATION_ERROR_CODE.SLOT_CONFLICT, {
        slot: entry.slot,
      });
    }
    const candidate = list[0];
    const expectedArtifact = artifacts.get(entry.slot);
    if (candidate.artifactSha256 !== expectedArtifact) {
      reject(`target participant ${entry.slot} has an artifact that does not match the descriptor`, COORDINATION_ERROR_CODE.ARTIFACT_MISMATCH, {
        slot: entry.slot,
      });
    }
    const prepared = transition.prepareEvidence.find(
      (evidence) => evidence.slot === entry.slot && evidence.instanceId === candidate.instanceId,
    );
    if (!prepared) {
      reject(`enabled target slot ${entry.slot} has no PREPARED acknowledgement`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE, {
        slot: entry.slot,
      });
    }
    chosen.set(entry.slot, candidate);
  }
  for (const slot of candidates.keys()) {
    const entry = descriptor.inventory.find((candidate) => candidate.slot === slot);
    if (!entry || !entry.enabled) {
      reject(`slot ${slot} has a target participant but is not enabled in the target inventory`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE, {
        slot,
      });
    }
  }

  const receipts = command.observerReceipts ?? [];
  for (const observer of descriptor.observers) {
    const recorded = transition.observerEvidence.find((evidence) => evidence.observerId === observer.observerId);
    if (!recorded) {
      if (observer.required) {
        reject(`required observer ${observer.observerId} has no validation receipt`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE, {
          observerId: observer.observerId,
        });
      }
      continue;
    }
    const receipt = receipts.find((candidate) => candidate?.observerId === observer.observerId);
    if (!receipt) {
      reject(`observer evidence for ${observer.observerId} cannot be re-read`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
    }
    if (receipt.status !== OBSERVER_STATUS.VALIDATED) {
      reject(`required observer ${observer.observerId} did not validate`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE, {
        observerId: observer.observerId,
      });
    }
    if (receipt.artifactSha256 !== observer.artifactSha256) {
      reject(`observer ${observer.observerId} receipt artifact does not match the descriptor`, COORDINATION_ERROR_CODE.ARTIFACT_MISMATCH);
    }
    for (const key of ['manifestVersion', 'manifestSha256', 'capabilityProfileSha256']) {
      if (receipt[key] !== record.target[key]) {
        reject(`observer ${observer.observerId} receipt ${key} does not match the target binding`, COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
      }
    }
  }

  const next = validateControlRecord({
    ...record,
    revision: nextRevision(record),
    phase: PHASE.ARMED,
  });
  return {
    record: next,
    event: {
      action: RELEASE_ACTION.ARM,
      fromPhase: record.phase,
      toPhase: PHASE.ARMED,
      targetMembers: transition.targetMembers.length,
      observers: transition.observerEvidence.length,
    },
  };
}

/**
 * `activate`: ARMED -> ACTIVE. The atomic commit of the reserved generation,
 * target binding, target inventory and target roster. Transition evidence is
 * returned as an archive so the store can persist it before the record that
 * clears those fields is durable (amendment §9.3).
 *
 * @param {any} record
 * @param {{ descriptor: any, observerReceipts?: readonly any[] }} command
 * @returns {{ record: Readonly<object>, archive: object, event: object }}
 */
function activate(record, command) {
  if (record.phase !== PHASE.ARMED) illegalPhase(record, RELEASE_ACTION.ACTIVATE);
  const descriptor = validateReleaseDescriptor(command.descriptor);
  assertDescriptorMatchesTransition(record, descriptor, RELEASE_ACTION.ACTIVATE);

  // Revalidate the exact same evidence; nothing may change between arm and
  // activate, and no late registration can slip in.
  arm({ ...record, phase: PHASE.PREPARING }, command);

  // The committed roster is every enabled target slot's single participant,
  // whether it arrived as a target-only registration or as a retained instance
  // under a trusted stage grant.
  const candidates = targetCandidates(record, descriptor);
  const chosen = new Map();
  for (const entry of descriptor.inventory) {
    if (!entry.enabled) continue;
    const list = candidates.get(entry.slot) ?? [];
    if (list.length !== 1) {
      reject(`enabled target slot ${entry.slot} does not have exactly one participant`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE, {
        slot: entry.slot,
      });
    }
    chosen.set(entry.slot, list[0]);
  }

  const transition = record.transition;
  const generation = record.nextGeneration;
  if (generation !== record.highWaterGeneration) {
    reject('reserved generation is not the high-water mark', COORDINATION_ERROR_CODE.INVALID_TRANSITION);
  }

  const archive = {
    schemaVersion: 1,
    deploymentId: record.deploymentId,
    transitionId: record.transitionId,
    descriptorSha256: transition.descriptorSha256,
    fromGeneration: record.generation,
    toGeneration: generation,
    phase: record.phase,
    oldMembers: transition.oldMembers,
    targetMembers: transition.targetMembers,
    retirementEvidence: transition.retirementEvidence,
    prepareEvidence: transition.prepareEvidence,
    observerEvidence: transition.observerEvidence,
    stageGrants: transition.stageGrants,
    approvalId: record.approvalId,
  };

  const next = validateControlRecord({
    schemaVersion: 1,
    deploymentId: record.deploymentId,
    revision: nextRevision(record),
    generation,
    nextGeneration: null,
    phase: PHASE.ACTIVE,
    active: record.target,
    target: null,
    transitionId: null,
    inventory: descriptor.inventory,
    members: [...chosen.entries()].map(([slot, candidate]) => ({
      slot,
      instanceId: candidate.instanceId,
      artifactSha256: candidate.artifactSha256,
    })),
    highWaterGeneration: record.highWaterGeneration,
    approvalId: record.approvalId,
    releaseDescriptorSha256: transition.descriptorSha256,
    transition: null,
  });

  return {
    record: next,
    archive,
    event: {
      action: RELEASE_ACTION.ACTIVATE,
      fromPhase: record.phase,
      toPhase: PHASE.ACTIVE,
      fromGeneration: record.generation,
      toGeneration: generation,
      members: next.members.length,
      descriptorSha256: transition.descriptorSha256,
    },
  };
}

/**
 * `pause`: any transition phase -> PAUSED, retaining the entire transition.
 *
 * @param {any} record
 * @param {{ reason?: string }} [command]
 * @returns {{ record: Readonly<object>, event: object }}
 */
function pause(record, command = {}) {
  if (!TRANSITION_PHASES.includes(record.phase)) illegalPhase(record, RELEASE_ACTION.PAUSE);
  const next = validateControlRecord({
    ...record,
    revision: nextRevision(record),
    phase: PHASE.PAUSED,
  });
  return {
    record: next,
    event: {
      action: RELEASE_ACTION.PAUSE,
      fromPhase: record.phase,
      toPhase: PHASE.PAUSED,
      reason: typeof command.reason === 'string' ? command.reason.slice(0, 200) : null,
      retainedTransitionId: record.transitionId,
    },
  };
}

/**
 * `recover`: PAUSED with a retained transition -> QUIESCING under a fresh,
 * higher generation, retaining the union of every old and target instance as
 * the new old roster and discarding all prior grants/acknowledgements.
 *
 * @param {any} record
 * @param {{ descriptor: any, transitionId: string }} command
 * @returns {{ record: Readonly<object>, event: object }}
 */
function recover(record, command) {
  if (record.phase !== PHASE.PAUSED) illegalPhase(record, RELEASE_ACTION.RECOVER);
  if (record.transition === null || record.transitionId === null) {
    reject('recovery requires a retained transition', COORDINATION_ERROR_CODE.INVALID_TRANSITION);
  }
  const descriptor = validateReleaseDescriptor(command.descriptor);
  const reserved = record.highWaterGeneration + 1;
  if (!Number.isSafeInteger(reserved)) {
    reject('generation counter would overflow', COORDINATION_ERROR_CODE.INVALID_TRANSITION);
  }

  /** @type {Map<string, any>} */
  const union = new Map();
  for (const member of [...record.transition.oldMembers, ...record.transition.targetMembers, ...record.members]) {
    union.set(`${member.slot}\u0000${member.instanceId}`, { ...member });
  }
  const oldMembers = [...union.values()].sort((a, b) => {
    if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
    return a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0;
  });

  const next = validateControlRecord({
    ...record,
    revision: nextRevision(record),
    nextGeneration: reserved,
    phase: PHASE.QUIESCING,
    target: descriptor.binding,
    transitionId: command.transitionId,
    highWaterGeneration: reserved,
    approvalId: descriptor.approvalId,
    transition: {
      descriptorSha256: computeReleaseDescriptorDigest(descriptor),
      oldMembers,
      targetMembers: [],
      retirementEvidence: [],
      prepareEvidence: [],
      observerEvidence: [],
      stageGrants: [],
      abandonedTransitionId: record.transitionId,
    },
  });

  return {
    record: next,
    event: {
      action: RELEASE_ACTION.RECOVER,
      fromPhase: record.phase,
      toPhase: PHASE.QUIESCING,
      fromGeneration: record.generation,
      toGeneration: reserved,
      retainedInstances: oldMembers.length,
      abandonedTransitionId: record.transitionId,
    },
  };
}

/**
 * `register-target`: a target-only process claims an enabled slot during
 * PREPARING. It cannot infer before ACTIVE.
 *
 * @param {any} record
 * @param {{ descriptor: any, slot: string, instanceId: string, artifactSha256: string }} command
 * @returns {{ record: Readonly<object>, event: object }}
 */
function registerTarget(record, command) {
  if (record.phase !== PHASE.PREPARING) {
    reject(`target registration is only legal in PREPARING (phase ${record.phase})`, COORDINATION_ERROR_CODE.INVALID_TRANSITION, {
      phase: record.phase,
    });
  }
  const descriptor = validateReleaseDescriptor(command.descriptor);
  assertDescriptorMatchesTransition(record, descriptor, RELEASE_ACTION.REGISTER_TARGET);
  const entry = descriptor.inventory.find((candidate) => candidate.slot === command.slot);
  if (!entry) {
    reject(`slot ${command.slot} is not in the target inventory`, COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED);
  }
  if (!entry.enabled) {
    reject(`slot ${command.slot} is disabled in the target inventory`, COORDINATION_ERROR_CODE.SLOT_DISABLED);
  }
  const expectedArtifact = descriptorArtifacts(descriptor).get(command.slot);
  if (command.artifactSha256 !== expectedArtifact) {
    reject(`slot ${command.slot} must run the artifact assigned by the descriptor`, COORDINATION_ERROR_CODE.ARTIFACT_MISMATCH);
  }
  const transition = record.transition;
  const existing = transition.targetMembers.find((member) => member.slot === command.slot);
  if (existing) {
    if (existing.instanceId === command.instanceId && existing.artifactSha256 === command.artifactSha256) {
      return { record, event: { action: RELEASE_ACTION.REGISTER_TARGET, idempotent: true, slot: command.slot } };
    }
    reject(`slot ${command.slot} is already claimed by another instance`, COORDINATION_ERROR_CODE.SLOT_CONFLICT, {
      slot: command.slot,
    });
  }
  // A replacement of a still-running old instance is not a registration; the old
  // process must be quiesced or fenced first.
  const old = transition.oldMembers.find((member) => member.slot === command.slot);
  if (old && old.instanceId !== command.instanceId && !isRetired(transition, old.slot, old.instanceId)) {
    reject(
      `slot ${command.slot} is still held by ${old.instanceId}; retire or fence it before registering a replacement`,
      COORDINATION_ERROR_CODE.SLOT_CONFLICT,
      { slot: command.slot },
    );
  }

  const next = validateControlRecord({
    ...record,
    revision: nextRevision(record),
    transition: {
      ...transition,
      targetMembers: [...transition.targetMembers, {
        slot: command.slot,
        instanceId: command.instanceId,
        artifactSha256: command.artifactSha256,
      }],
    },
  });
  return {
    record: next,
    event: {
      action: RELEASE_ACTION.REGISTER_TARGET,
      slot: command.slot,
      instanceId: command.instanceId,
      revision: next.revision,
    },
  };
}

/**
 * `remove-target`: the coordinator retracts a target claim (never the old
 * retirement obligation).
 *
 * @param {any} record
 * @param {{ slot: string, instanceId: string }} command
 * @returns {{ record: Readonly<object>, event: object }}
 */
function removeTarget(record, command) {
  if (record.phase !== PHASE.PREPARING) illegalPhase(record, RELEASE_ACTION.REMOVE_TARGET);
  const transition = record.transition;
  const member = transition.targetMembers.find(
    (candidate) => candidate.slot === command.slot && candidate.instanceId === command.instanceId,
  );
  if (!member) {
    reject(`no target claim for ${command.slot}/${command.instanceId}`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  const next = validateControlRecord({
    ...record,
    revision: nextRevision(record),
    transition: {
      ...transition,
      targetMembers: transition.targetMembers.filter(
        (candidate) => !(candidate.slot === command.slot && candidate.instanceId === command.instanceId),
      ),
      prepareEvidence: transition.prepareEvidence.filter(
        (evidence) => !(evidence.slot === command.slot && evidence.instanceId === command.instanceId),
      ),
      stageGrants: transition.stageGrants.filter(
        (grant) => !(grant.slot === command.slot && grant.instanceId === command.instanceId),
      ),
    },
  });
  return {
    record: next,
    event: { action: RELEASE_ACTION.REMOVE_TARGET, slot: command.slot, instanceId: command.instanceId },
  };
}

/**
 * `retire`: collect QUIESCED or FENCED evidence for one old member.
 *
 * @param {any} record
 * @param {{ slot: string, instanceId: string, kind: 'QUIESCED' | 'FENCED', evidenceSha256: string }} command
 * @returns {{ record: Readonly<object>, event: object }}
 */
function retire(record, command) {
  if (record.phase !== PHASE.QUIESCING && record.phase !== PHASE.PREPARING) {
    reject(`retirement evidence is only collected in QUIESCING or PREPARING (phase ${record.phase})`, COORDINATION_ERROR_CODE.INVALID_TRANSITION, {
      phase: record.phase,
    });
  }
  const transition = record.transition;
  const member = transition.oldMembers.find(
    (candidate) => candidate.slot === command.slot && candidate.instanceId === command.instanceId,
  );
  if (!member) {
    reject(`${command.slot}/${command.instanceId} is not an old member of this transition`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  if (command.kind !== 'QUIESCED' && command.kind !== 'FENCED') {
    reject('retirement kind must be QUIESCED or FENCED', COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  if (typeof command.evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(command.evidenceSha256)) {
    reject('retirement evidence reference must be a SHA-256 digest', COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  const others = transition.retirementEvidence.filter(
    (entry) => !(entry.slot === command.slot && entry.instanceId === command.instanceId && entry.kind === command.kind),
  );
  const entry = {
    slot: command.slot,
    instanceId: command.instanceId,
    kind: command.kind,
    evidenceSha256: command.evidenceSha256,
  };
  const next = validateControlRecord({
    ...record,
    revision: nextRevision(record),
    transition: { ...transition, retirementEvidence: [...others, entry] },
  });
  return {
    record: next,
    event: { action: RELEASE_ACTION.RETIRE, ...entry, revision: next.revision },
  };
}

/**
 * `prepare-ack`: record PREPARED evidence for a target member.
 *
 * @param {any} record
 * @param {{ ack: unknown }} command
 * @returns {{ record: Readonly<object>, event: object }}
 */
function prepareAck(record, command) {
  if (record.phase !== PHASE.PREPARING) illegalPhase(record, RELEASE_ACTION.PREPARE_ACK);
  const descriptor = validateReleaseDescriptor(command.descriptor);
  assertDescriptorMatchesTransition(record, descriptor, RELEASE_ACTION.PREPARE_ACK);
  const ack = validateAck(command.ack, { label: 'PREPARED ack' });
  const transition = record.transition;
  if (ack.deploymentId !== record.deploymentId) {
    reject('ack belongs to another deployment', COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  if (ack.transitionId !== record.transitionId) {
    reject('ack belongs to another transition', COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  if (ack.targetGeneration !== record.nextGeneration) {
    reject('ack generation does not match the reserved generation', COORDINATION_ERROR_CODE.GENERATION_RETIRED);
  }
  const member = transition.targetMembers.find(
    (candidate) => candidate.slot === ack.slot && candidate.instanceId === ack.instanceId,
  );
  const grant = transition.stageGrants.find(
    (candidate) => candidate.slot === ack.slot && candidate.instanceId === ack.instanceId,
  );
  if (!member && !grant) {
    reject(`ack is from an unregistered target instance ${ack.slot}/${ack.instanceId}`, COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED);
  }
  if (ack.status !== ACK_STATUS.PREPARED) {
    reject(`only PREPARED acks can be collected as prepare evidence (got ${ack.status})`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  const expectedArtifact = member?.artifactSha256 ?? descriptorArtifacts(descriptor).get(ack.slot);
  if (ack.artifactSha256 !== expectedArtifact) {
    reject('ack artifact does not match the target assignment', COORDINATION_ERROR_CODE.ARTIFACT_MISMATCH);
  }
  if (record.target === null) illegalPhase(record, RELEASE_ACTION.PREPARE_ACK);
  for (const key of ['manifestVersion', 'manifestSha256', 'capabilityProfileSha256', 'inventorySha256']) {
    if (ack[key] !== record.target[key]) {
      reject(`ack ${key} does not match the target binding`, COORDINATION_ERROR_CODE.IDENTITY_MISMATCH, { field: key });
    }
  }
  const evidenceSha256 = command.evidenceSha256;
  if (typeof evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceSha256)) {
    reject('prepare evidence reference must be a SHA-256 digest', COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  const others = transition.prepareEvidence.filter(
    (evidence) => !(evidence.slot === ack.slot && evidence.instanceId === ack.instanceId),
  );
  const next = validateControlRecord({
    ...record,
    revision: nextRevision(record),
    transition: {
      ...transition,
      prepareEvidence: [...others, { slot: ack.slot, instanceId: ack.instanceId, evidenceSha256 }],
    },
  });
  return {
    record: next,
    event: {
      action: RELEASE_ACTION.PREPARE_ACK,
      slot: ack.slot,
      instanceId: ack.instanceId,
      generation: ack.targetGeneration,
      revision: next.revision,
    },
  };
}

/**
 * `observer-evidence`: record a disabled-observer validation receipt.
 *
 * @param {any} record
 * @param {{ descriptor: any, receipt: unknown, evidenceSha256: string }} command
 * @returns {{ record: Readonly<object>, event: object }}
 */
function observerEvidence(record, command) {
  if (record.phase !== PHASE.PREPARING) illegalPhase(record, RELEASE_ACTION.OBSERVER_EVIDENCE);
  const descriptor = validateReleaseDescriptor(command.descriptor);
  assertDescriptorMatchesTransition(record, descriptor, RELEASE_ACTION.OBSERVER_EVIDENCE);
  const receipt = validateObserverReceipt(command.receipt, { label: 'observer receipt' });
  const observer = descriptor.observers.find((candidate) => candidate.observerId === receipt.observerId);
  if (!observer) {
    reject(`observer ${receipt.observerId} is not declared by the target descriptor`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  if (receipt.deploymentId !== record.deploymentId || receipt.transitionId !== record.transitionId) {
    reject('observer receipt belongs to another deployment or transition', COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  if (receipt.artifactSha256 !== observer.artifactSha256) {
    reject('observer receipt artifact does not match the descriptor', COORDINATION_ERROR_CODE.ARTIFACT_MISMATCH);
  }
  for (const key of ['manifestVersion', 'manifestSha256', 'capabilityProfileSha256']) {
    if (receipt[key] !== record.target[key]) {
      reject(`observer receipt ${key} does not match the target binding`, COORDINATION_ERROR_CODE.IDENTITY_MISMATCH);
    }
  }
  if (typeof command.evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(command.evidenceSha256)) {
    reject('observer evidence reference must be a SHA-256 digest', COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  const transition = record.transition;
  const others = transition.observerEvidence.filter((evidence) => evidence.observerId !== receipt.observerId);
  const next = validateControlRecord({
    ...record,
    revision: nextRevision(record),
    transition: {
      ...transition,
      observerEvidence: [...others, { observerId: receipt.observerId, evidenceSha256: command.evidenceSha256 }],
    },
  });
  return {
    record: next,
    event: {
      action: RELEASE_ACTION.OBSERVER_EVIDENCE,
      observerId: receipt.observerId,
      status: receipt.status,
      revision: next.revision,
    },
  };
}

/**
 * `stage-grant`: authorize an exact retained instance to stage the target
 * runtime. Legal only after that instance's QUIESCED/FENCED evidence exists and
 * only when the target artifact equals its current artifact (a different binary
 * requires a fenced replacement, which a grant cannot waive).
 *
 * @param {any} record
 * @param {{ descriptor: any, slot: string, instanceId: string }} command
 * @returns {{ record: Readonly<object>, event: object }}
 */
function stageGrant(record, command) {
  if (record.phase !== PHASE.PREPARING) illegalPhase(record, RELEASE_ACTION.STAGE_GRANT);
  const descriptor = validateReleaseDescriptor(command.descriptor);
  assertDescriptorMatchesTransition(record, descriptor, RELEASE_ACTION.STAGE_GRANT);
  const transition = record.transition;
  const member = transition.oldMembers.find(
    (candidate) => candidate.slot === command.slot && candidate.instanceId === command.instanceId,
  );
  if (!member) {
    reject(`stage grant is only for a retained old instance (${command.slot}/${command.instanceId})`, COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  if (!isRetired(transition, command.slot, command.instanceId)) {
    reject('stage grant requires the instance to be quiesced or fenced first', COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  const entry = descriptor.inventory.find((candidate) => candidate.slot === command.slot);
  if (!entry || !entry.enabled) {
    reject(`slot ${command.slot} is not enabled in the target inventory`, COORDINATION_ERROR_CODE.SLOT_DISABLED);
  }
  const expectedArtifact = descriptorArtifacts(descriptor).get(command.slot);
  if (member.artifactSha256 !== expectedArtifact) {
    reject(
      'target artifact differs from the running instance; a grant cannot waive artifact compatibility',
      COORDINATION_ERROR_CODE.ARTIFACT_MISMATCH,
      { slot: command.slot },
    );
  }
  const grant = {
    slot: command.slot,
    instanceId: command.instanceId,
    descriptorSha256: transition.descriptorSha256,
    approvalId: descriptor.approvalId,
  };
  const others = transition.stageGrants.filter(
    (candidate) => !(candidate.slot === command.slot && candidate.instanceId === command.instanceId),
  );
  const next = validateControlRecord({
    ...record,
    revision: nextRevision(record),
    transition: { ...transition, stageGrants: [...others, grant] },
  });
  return {
    record: next,
    event: { action: RELEASE_ACTION.STAGE_GRANT, ...grant, revision: next.revision },
  };
}

/**
 * There is deliberately no ACTIVE self-transition that replaces a member. §9.3
 * permits self-transitions only for registration/evidence collection in the
 * phases listed above, and UAI-05B requires explicit operator fencing evidence
 * for a member replacement. A restarted process therefore fails closed
 * (`SLOT_CONFLICT`) and the operator replaces the member through a transition:
 * quiesce → retire (QUIESCED or FENCED evidence) → register the new instance →
 * arm → activate.
 */

const HANDLERS = Object.freeze({
  [RELEASE_ACTION.QUIESCE]: quiesce,
  [RELEASE_ACTION.PREPARE]: prepare,
  [RELEASE_ACTION.ARM]: arm,
  [RELEASE_ACTION.ACTIVATE]: activate,
  [RELEASE_ACTION.PAUSE]: pause,
  [RELEASE_ACTION.RECOVER]: recover,
  [RELEASE_ACTION.REGISTER_TARGET]: registerTarget,
  [RELEASE_ACTION.REMOVE_TARGET]: removeTarget,
  [RELEASE_ACTION.RETIRE]: retire,
  [RELEASE_ACTION.PREPARE_ACK]: prepareAck,
  [RELEASE_ACTION.OBSERVER_EVIDENCE]: observerEvidence,
  [RELEASE_ACTION.STAGE_GRANT]: stageGrant,
});

/**
 * Apply one command to a validated control record.
 *
 * @param {unknown} record
 * @param {{ action: string } & Record<string, unknown>} command
 * @returns {{ record: Readonly<object>, event: object, archive?: object }}
 */
export function applyReleaseCommand(record, command) {
  const validated = validateControlRecord(record);
  if (command === null || typeof command !== 'object' || typeof command.action !== 'string') {
    reject('release command must be an object with an action', COORDINATION_ERROR_CODE.INVALID_TRANSITION);
  }
  const handler = HANDLERS[command.action];
  if (!handler) {
    reject(`unknown release action ${JSON.stringify(command.action)}`, COORDINATION_ERROR_CODE.INVALID_TRANSITION, {
      action: command.action,
    });
  }
  return handler(validated, command);
}

/**
 * Validate an operator FENCED evidence object against a transition.
 *
 * @param {unknown} raw
 * @param {{ record: any, slot: string, instanceId: string }} context
 * @returns {Readonly<object>}
 */
export function validateFenceEvidenceForTransition(raw, context) {
  const evidence = validateFenceEvidence(raw, { label: 'fence evidence' });
  const { record, slot, instanceId } = context;
  if (evidence.deploymentId !== record.deploymentId) {
    reject('fence evidence belongs to another deployment', COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  if (evidence.transitionId !== record.transitionId) {
    reject('fence evidence belongs to another transition', COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  if (evidence.slot !== slot || evidence.instanceId !== instanceId) {
    reject('fence evidence names another participant', COORDINATION_ERROR_CODE.INVALID_EVIDENCE);
  }
  return evidence;
}

/**
 * @param {unknown} inventory
 * @returns {readonly Readonly<object>[]}
 */
export function normalizeInventory(inventory) {
  return validateInventory(inventory);
}
