/**
 * Synthetic release fixtures for the unified single-mode protocol.
 *
 * Everything here is fake: artifacts are content-addressed strings, not built
 * bundles; approvals are invented identifiers; no provider, exchange or Telegram
 * call is possible. The fixtures exist so the state machine, store and guard can
 * be exercised deterministically and so cross-process tests can materialise a
 * real control directory on disk.
 *
 * @module test/fixtures/ai-release/factory
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from '../../../src/config/jcs.mjs';
import {
  createCapabilityProfile,
  capabilityProfileSha256,
} from '../../../src/ai/operation-profiles.mjs';
import {
  computeManifestDigest,
  validateModelIdentityManifest,
} from '../../../src/config/ai-identity-manifest.mjs';
import {
  createBinding,
  computeReleaseDescriptorDigest,
  computeInventoryDigest,
} from '../../../src/config/ai-release-schema.mjs';
import { createControlStore } from '../../../src/ai/coordination/control-store.mjs';
import { createGenerationGuard } from '../../../src/ai/coordination/generation-guard.mjs';
import { createGenerationRuntime } from '../../../src/ai/runtime.mjs';

/** Artifact digests are digests of the fake bundle contents. */
export function artifactDigest(name) {
  return sha256Hex(`artifact:${name}`);
}

/** Silent logger for guard fixtures. */
export const SILENT_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/**
 * Build the single-mode config a participant would receive at launch.
 *
 * @param {ReturnType<typeof buildReleaseFixture>} fixture
 * @param {string} slot
 */
export function guardConfigFor(fixture, slot) {
  const record = fixture.store.readRecord();
  return {
    mode: 'single',
    controlDir: fixture.controlDir,
    deploymentId: record.deploymentId,
    slot,
    expectedManifestVersion: fixture.manifest.manifestVersion,
    expectedManifestSha256: fixture.manifestSha256,
    artifactSha256: fixture.artifactMap[slot],
    hasApiKey: true,
  };
}

/**
 * A real generation guard with a fake runtime, used by tests that need live
 * participant semantics (admission, drain, staging, promotion) without a
 * provider.
 *
 * @param {ReturnType<typeof buildReleaseFixture>} fixture
 * @param {{ slot: string, instanceId: string, calls?: any[], artifactSha256?: string, invoke?: Function }} input
 */
export function buildTestGuard(fixture, input) {
  const calls = input.calls ?? [];
  const guard = createGenerationGuard({
    controlStore: fixture.store,
    config: input.artifactSha256
      ? { ...guardConfigFor(fixture, input.slot), artifactSha256: input.artifactSha256 }
      : guardConfigFor(fixture, input.slot),
    instanceId: input.instanceId,
    logger: SILENT_LOGGER,
    runtimeFactory: ({ binding, generation, manifest, profile, target, slot, instanceId }) => createGenerationRuntime({
      binding,
      generation,
      deploymentId: binding.manifestSha256 === '' ? 'unused' : fixture.store.readRecord().deploymentId,
      slot,
      instanceId,
      manifest,
      profile,
      operations: input.slot === 'core-analysis' ? ['ANALYZE'] : ['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT'],
      guard,
      invoke: async ({ operation, request }) => {
        calls.push({ operation, request, generation, target, instanceId, at: Date.now() });
        return typeof input.invoke === 'function'
          ? input.invoke({ operation, request, generation, target, instanceId })
          : { ok: true, operation };
      },
    }),
  });
  return guard;
}

export const DEFAULT_INVENTORY = Object.freeze([
  Object.freeze({ slot: 'core-analysis', operations: Object.freeze(['ANALYZE']), enabled: true }),
  Object.freeze({ slot: 'telegram', operations: Object.freeze(['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT']), enabled: true }),
]);

/**
 * @param {{ [slot: string]: string }} map
 * @param {readonly { slot: string, operations: readonly string[], enabled: boolean }[]} inventory
 * @returns {{ slot: string, artifactSha256: string }[]}
 */
export function artifactsFor(map, inventory = DEFAULT_INVENTORY) {
  return inventory
    .filter((entry) => entry.enabled)
    .map((entry) => ({ slot: entry.slot, artifactSha256: map[entry.slot] ?? artifactDigest(`${entry.slot}-v1`) }));
}

/**
 * @param {string} controlDir
 */
export function makeStore(controlDir, options = {}) {
  return createControlStore({ controlDir, ...options });
}

/**
 * Build (and optionally persist) one complete, consistent release descriptor.
 *
 * @param {{
 *   controlDir?: string,
 *   manifestVersion?: string,
 *   providerId?: 'deepseek' | 'kimi',
 *   modelId?: string,
 *   canonicalBaseUrl?: string,
 *   profileId?: string,
 *   inventory?: readonly { slot: string, operations: readonly string[], enabled: boolean }[],
 *   artifactMap?: { [slot: string]: string },
 *   observers?: readonly { observerId: string, artifactSha256: string, required: boolean }[],
 *   approvalId?: string,
 *   policy?: object,
 *   storeOptions?: object,
 * }} [options]
 */
export function buildReleaseFixture(options = {}) {
  const controlDir = options.controlDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ai-release-'));
  const manifestVersion = options.manifestVersion ?? 'release-1';
  const providerId = options.providerId ?? 'deepseek';
  const modelId = options.modelId ?? 'deepseek-chat';
  const canonicalBaseUrl = options.canonicalBaseUrl ?? 'https://api.deepseek.com/v1';
  const profileId = options.profileId ?? `${providerId}-unified-v1`;
  const inventory = options.inventory ?? DEFAULT_INVENTORY;
  const artifactMap = options.artifactMap ?? {
    'core-analysis': artifactDigest('core-analysis-v1'),
    telegram: artifactDigest('telegram-v1'),
  };
  const artifacts = artifactsFor(artifactMap, inventory);
  const observers = options.observers ?? [
    { observerId: 'core-bootstrap', artifactSha256: artifactMap['core-analysis'] ?? artifactDigest('core-analysis-v1'), required: true },
  ];

  const manifest = validateModelIdentityManifest(
    {
      schemaVersion: 1,
      manifestVersion,
      providerId,
      modelId,
      canonicalBaseUrl,
      capabilityProfileId: profileId,
      capabilityProfileSha256: capabilityProfileSha256(
        createCapabilityProfile({ profileId, providerId }),
      ),
    },
    { policy: options.policy },
  );
  const profile = createCapabilityProfile({ profileId, providerId });
  const manifestSha256 = computeManifestDigest(manifest, { policy: options.policy });
  const profileSha256 = capabilityProfileSha256(profile);
  const binding = createBinding({
    manifest,
    manifestSha256,
    profile,
    profileSha256,
    inventory,
    artifacts,
    observers,
  });
  const descriptor = {
    schemaVersion: 1,
    binding,
    inventory,
    artifacts,
    observers,
    approvalId: options.approvalId ?? 'approval-001',
  };
  const descriptorSha256 = computeReleaseDescriptorDigest(descriptor);

  const store = makeStore(controlDir, options.storeOptions);
  store.putManifest(manifest, { manifestSha256 });
  store.putProfile(profile, { profileSha256 });
  store.putReleaseDescriptor(descriptor);

  return {
    controlDir,
    manifest,
    manifestSha256,
    profile,
    profileSha256,
    inventory,
    artifacts,
    observers,
    artifactMap,
    binding,
    inventorySha256: computeInventoryDigest(inventory),
    descriptor,
    descriptorSha256,
    approvalId: descriptor.approvalId,
    store,
  };
}

/**
 * @param {{
 *   fixture: ReturnType<typeof buildReleaseFixture>,
 *   inventory?: readonly object[],
 *   artifactMap?: { [slot: string]: string },
 *   manifestVersion?: string,
 *   modelId?: string,
 *   profileId?: string,
 *   approvalId?: string,
 * }} input
 */
export function buildAlternateDescriptor(input) {
  const fixture = input.fixture;
  const inventory = input.inventory ?? fixture.inventory;
  const artifactMap = { ...fixture.artifactMap, ...(input.artifactMap ?? {}) };
  const artifacts = artifactsFor(artifactMap, inventory);
  const manifest = validateModelIdentityManifest({
    schemaVersion: 1,
    manifestVersion: input.manifestVersion ?? fixture.manifest.manifestVersion,
    providerId: fixture.manifest.providerId,
    modelId: input.modelId ?? fixture.manifest.modelId,
    canonicalBaseUrl: fixture.manifest.canonicalBaseUrl,
    capabilityProfileId: input.profileId ?? fixture.profile.profileId,
    capabilityProfileSha256: capabilityProfileSha256(
      createCapabilityProfile({
        profileId: input.profileId ?? fixture.profile.profileId,
        providerId: fixture.manifest.providerId,
      }),
    ),
  });
  const profile = createCapabilityProfile({
    profileId: input.profileId ?? fixture.profile.profileId,
    providerId: fixture.manifest.providerId,
  });
  const manifestSha256 = computeManifestDigest(manifest);
  const profileSha256 = capabilityProfileSha256(profile);
  const observers = inventory
    .filter((entry) => entry.slot === 'core-analysis' && entry.enabled)
    .map(() => ({
      observerId: 'core-bootstrap',
      artifactSha256: artifacts.find((artifact) => artifact.slot === 'core-analysis')?.artifactSha256
        ?? artifactDigest('core-analysis-v1'),
      required: true,
    }));
  const binding = createBinding({
    manifest,
    manifestSha256,
    profile,
    profileSha256,
    inventory,
    artifacts,
    observers,
  });
  const descriptor = {
    schemaVersion: 1,
    binding,
    inventory,
    artifacts,
    observers,
    approvalId: input.approvalId ?? fixture.approvalId,
  };
  fixture.store.putManifest(manifest, { manifestSha256 });
  fixture.store.putProfile(profile, { profileSha256 });
  const written = fixture.store.putReleaseDescriptor(descriptor);
  return {
    manifest,
    manifestSha256,
    profile,
    profileSha256,
    inventory,
    artifacts,
    observers,
    binding,
    descriptor,
    descriptorSha256: written.sha256,
  };
}

/**
 * @param {ReturnType<typeof buildReleaseFixture>} fixture
 * @param {{ generation: number, previousRevision: number }} input
 */
export function initializeFixture(fixture, input = { generation: 0, previousRevision: 0 }) {
  const { record } = fixture.store.initialize({
    inventory: fixture.inventory,
    approvalId: null,
  });
  return { ...fixture, record };
}

/**
 * Build an ack for the current record state.
 *
 * @param {{
 *   record: any,
 *   slot: string,
 *   instanceId: string,
 *   status: 'QUIESCED' | 'PREPARED' | 'ERROR',
 *   artifactSha256: string,
 *   binding: any,
 *   errorCode?: string | null,
 *   outstandingWork?: number,
 *   pendingAIApprovals?: number,
 * }} input
 */
export function buildAck(input) {
  const { record } = input;
  const binding = input.binding;
  return {
    schemaVersion: 1,
    deploymentId: record.deploymentId,
    transitionId: record.transitionId,
    targetGeneration: record.nextGeneration ?? record.generation,
    slot: input.slot,
    instanceId: input.instanceId,
    artifactSha256: input.artifactSha256,
    status: input.status,
    manifestVersion: binding.manifestVersion,
    manifestSha256: binding.manifestSha256,
    capabilityProfileSha256: binding.capabilityProfileSha256,
    inventorySha256: binding.inventorySha256,
    outstandingWork: input.outstandingWork ?? 0,
    pendingAIApprovals: input.pendingAIApprovals ?? 0,
    errorCode: input.errorCode ?? null,
  };
}

/**
 * Drive a full barrier with live participant guards (the cross-process and
 * fault-injection suites use this). Each participant is a real
 * `createGenerationGuard` result: it observes quiescence through `poll()`,
 * writes its own acknowledgement, stages through `prepareTarget()` and promotes
 * only after the committed ACTIVE record matches.
 *
 * @param {ReturnType<typeof buildReleaseFixture>} fixture
 * @param {{
 *   descriptor: any,
 *   participants: readonly { guard: any, slot: string, instanceId: string }[],
 *   fence?: readonly string[],
 *   operatorApprovalId?: string,
 *   transitionId?: string,
 * }} input
 */
export function advanceBarrier(fixture, input) {
  const store = fixture.store;
  const descriptor = input.descriptor;
  const transitionId = input.transitionId ?? '22222222-2222-4222-8222-222222222222';
  let record = store.readRecord();
  if (record.phase === 'PAUSED' || record.phase === 'ACTIVE') {
    record = store.transact({ action: 'quiesce', descriptor, transitionId }, { expectedRevision: record.revision }).record;
  }
  if (record.phase !== 'QUIESCING') throw new Error(`advanceBarrier expected QUIESCING, got ${record.phase}`);
  const fenced = new Set(input.fence ?? []);

  // 1. Every old member closes admission, drains and acknowledges; a member with
  // no live participant must be operator-fenced instead.
  for (const member of record.transition.oldMembers) {
    const participant = input.participants.find(
      (candidate) => candidate.slot === member.slot && candidate.instanceId === member.instanceId,
    );
    if (participant && !fenced.has(member.slot)) {
      participant.guard.poll();
      const ack = participant.guard.acknowledgeQuiesced();
      record = store.transact({
        action: 'retire',
        slot: member.slot,
        instanceId: member.instanceId,
        kind: 'QUIESCED',
        evidenceSha256: ack.sha256,
      }, { expectedRevision: record.revision }).record;
      continue;
    }
    if (!fenced.has(member.slot)) {
      throw new Error(`advanceBarrier: no live participant for old member ${member.slot}/${member.instanceId}`);
    }
    const evidence = {
      schemaVersion: 1,
      deploymentId: record.deploymentId,
      transitionId: record.transitionId,
      slot: member.slot,
      instanceId: member.instanceId,
      operatorApprovalId: input.operatorApprovalId ?? 'approval-fence-001',
      processFenceEvidenceRef: 'evidence/fencing/process-exit.txt',
      outcomeReconciliationRef: 'evidence/reconciliation/orders.txt',
    };
    const written = store.writeFenceEvidence(record.transitionId, member.slot, member.instanceId, evidence);
    record = store.transact({
      action: 'retire',
      slot: member.slot,
      instanceId: member.instanceId,
      kind: 'FENCED',
      evidenceSha256: written.sha256,
    }, { expectedRevision: record.revision }).record;
  }

  record = store.transact({ action: 'prepare' }, { expectedRevision: record.revision }).record;

  // 3. Stage grants for retained instances, then stage and acknowledge.
  for (const participant of input.participants) {
    const isOld = record.transition.oldMembers.some(
      (member) => member.slot === participant.slot && member.instanceId === participant.instanceId,
    );
    const entry = descriptor.inventory.find((candidate) => candidate.slot === participant.slot);
    if (!entry || !entry.enabled) continue;
    if (isOld) {
      record = store.transact({
        action: 'stage-grant',
        descriptor,
        slot: participant.slot,
        instanceId: participant.instanceId,
      }, { expectedRevision: record.revision }).record;
    } else {
      const artifact = descriptor.artifacts.find((candidate) => candidate.slot === participant.slot).artifactSha256;
      record = store.transact({
        action: 'register-target',
        descriptor,
        slot: participant.slot,
        instanceId: participant.instanceId,
        artifactSha256: artifact,
      }, { expectedRevision: record.revision }).record;
    }
    const staged = participant.guard.prepareTarget(
      isOld
        ? { descriptorSha256: computeReleaseDescriptorDigest(descriptor), approvalId: record.approvalId }
        : null,
    );
    record = store.transact({
      action: 'prepare-ack',
      ack: staged.ack,
      evidenceSha256: staged.sha256,
    }, { expectedRevision: record.revision }).record;
  }

  // 4. Required observer receipts.
  for (const observer of descriptor.observers) {
    const receipt = {
      schemaVersion: 1,
      deploymentId: record.deploymentId,
      transitionId: record.transitionId,
      observerId: observer.observerId,
      artifactSha256: observer.artifactSha256,
      manifestVersion: descriptor.binding.manifestVersion,
      manifestSha256: descriptor.binding.manifestSha256,
      capabilityProfileSha256: descriptor.binding.capabilityProfileSha256,
      status: 'VALIDATED',
      errorCode: null,
    };
    const written = store.writeObserverReceipt(record.transitionId, observer.observerId, receipt);
    record = store.transact({
      action: 'observer-evidence',
      descriptor,
      receipt,
      evidenceSha256: written.sha256,
    }, { expectedRevision: record.revision }).record;
  }

  record = store.transact({ action: 'arm', descriptor }, { expectedRevision: record.revision }).record;
  record = store.transact({ action: 'activate', descriptor }, { expectedRevision: record.revision }).record;
  for (const participant of input.participants) {
    const entry = descriptor.inventory.find((candidate) => candidate.slot === participant.slot);
    if (!entry || !entry.enabled) continue;
    participant.guard.poll();
  }
  return { ...fixture, record: store.readRecord() };
}

/**
 * Drive a full barrier to ACTIVE with two participants and one observer.
 * Individual tests that need a partial barrier use the granular store calls.
 *
 * @param {ReturnType<typeof buildReleaseFixture>} fixture
 * @param {{
 *   instances?: { 'core-analysis': string, telegram: string },
 *   descriptor?: any,
 *   targetDescriptor?: any,
 *   skipPrepare?: string[],
 *   skipObserver?: boolean,
 *   fence?: string[],
 * }} [options]
 */
export function activateFixture(fixture, options = {}) {
  const store = fixture.store;
  const descriptor = options.targetDescriptor ?? fixture.descriptor;
  const instances = options.instances ?? { 'core-analysis': 'inst-core-1', telegram: 'inst-tg-1' };
  let record = store.tryReadRecord();
  if (record === null) {
    record = store.initialize({ inventory: fixture.inventory }).record;
  }

  if (record.phase === 'PAUSED' && record.generation === 0 && record.transition === null) {
    record = store.transact({ action: 'quiesce', descriptor, transitionId: '11111111-1111-4111-8111-111111111111' }, {
      expectedRevision: record.revision,
    }).record;
  }
  if (record.phase === 'QUIESCING') {
    record = store.transact({ action: 'prepare' }, { expectedRevision: record.revision }).record;
  }
  if (record.phase !== 'PREPARING') {
    throw new Error(`activateFixture expected PREPARING, got ${record.phase}`);
  }

  for (const entry of descriptor.inventory) {
    if (!entry.enabled) continue;
    if ((options.skipPrepare ?? []).includes(entry.slot)) continue;
    const artifact = descriptor.artifacts.find((candidate) => candidate.slot === entry.slot).artifactSha256;
    record = store.transact({
      action: 'register-target',
      descriptor,
      slot: entry.slot,
      instanceId: instances[entry.slot] ?? `inst-${entry.slot}`,
      artifactSha256: artifact,
    }, { expectedRevision: record.revision }).record;
  }

  if (!options.skipObserver) {
    for (const observer of descriptor.observers) {
      const receipt = {
        schemaVersion: 1,
        deploymentId: record.deploymentId,
        transitionId: record.transitionId,
        observerId: observer.observerId,
        artifactSha256: observer.artifactSha256,
        manifestVersion: descriptor.binding.manifestVersion,
        manifestSha256: descriptor.binding.manifestSha256,
        capabilityProfileSha256: descriptor.binding.capabilityProfileSha256,
        status: 'VALIDATED',
        errorCode: null,
      };
      const written = store.writeObserverReceipt(record.transitionId, observer.observerId, receipt);
      record = store.transact({
        action: 'observer-evidence',
        descriptor,
        receipt,
        evidenceSha256: written.sha256,
      }, { expectedRevision: record.revision }).record;
    }
  }

  for (const entry of descriptor.inventory) {
    if (!entry.enabled) continue;
    if ((options.skipPrepare ?? []).includes(entry.slot)) continue;
    const instanceId = instances[entry.slot] ?? `inst-${entry.slot}`;
    const artifact = descriptor.artifacts.find((candidate) => candidate.slot === entry.slot).artifactSha256;
    const ack = buildAck({
      record,
      slot: entry.slot,
      instanceId,
      status: 'PREPARED',
      artifactSha256: artifact,
      binding: descriptor.binding,
    });
    const written = store.writeAck(record.transitionId, entry.slot, instanceId, 'PREPARED', ack);
    record = store.transact({ action: 'prepare-ack', ack, evidenceSha256: written.sha256 }, {
      expectedRevision: record.revision,
    }).record;
  }
  record = store.transact({ action: 'arm', descriptor }, { expectedRevision: record.revision }).record;
  record = store.transact({ action: 'activate', descriptor }, { expectedRevision: record.revision }).record;
  return { ...fixture, record, instances };
}
