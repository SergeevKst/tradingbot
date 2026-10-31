/**
 * One complete, committed v2 deployment for the production-wiring tests.
 *
 * Builds a real release control directory that also holds the skill CAS, a v2
 * release descriptor whose binding commits the six package digests, the model
 * registry, the execution plan and the runtime policy, and drives the real
 * release barrier to a committed ACTIVE v2 generation.
 *
 * Nothing here contacts a provider: transports are injected per test.
 *
 * @module test/fixtures/skills/deployment
 */
import fs from 'node:fs';

import { AI_OPERATIONS } from '../../../src/ai/operation-profiles.mjs';
import {
  createBindingV2,
  validateReleaseDescriptor,
} from '../../../src/config/ai-release-schema.mjs';
import { buildMigratedRecord } from '../../../src/ai/skills/migration.mjs';
import { sha256Hex } from '../../../src/config/jcs.mjs';
import { buildFixture, signEnvelope } from './factory.mjs';
import { buildReleaseFixture } from '../ai-release/factory.mjs';

/**
 * @param {{ revokeOperation?: string | null }} [options]
 */
export function deployV2(options = {}) {
  const fx = buildFixture();
  const plan = fx.preparePlan();
  if (options.revokeOperation) {
    // Publish the authorization revocation *after* the healthy plan was
    // approved: the binding still commits the plan the release accepted, and
    // the resolver must discover the revocation when it prepares the pair.
    const operation = options.revokeOperation;
    const revocation = signEnvelope(
      {
        schemaVersion: 1,
        packageRef: fx.packages[operation].ref,
        revokedAt: '2026-10-31T00:00:00Z',
        operatorApprovalId: 'operator-approval-1',
      },
      fx.signingKey,
    );
    fx.store.publishRevocation(revocation, { trustRoots: fx.trustRoots });
  }
  const fixture = buildReleaseFixture({ controlDir: fx.rootDir });
  // The capability profiles the packaged skills are validated against live in
  // the control directory, exactly as a production release publishes them.
  for (const [digest, profile] of Object.entries(fx.profiles)) {
    fixture.store.putProfile(profile, { profileSha256: digest });
  }

  const executionPlanSha256 = plan.planSha256;

  const binding = createBindingV2({
    manifest: fixture.manifest,
    manifestSha256: fixture.manifestSha256,
    profileSha256: fixture.profileSha256,
    inventory: fixture.inventory,
    artifacts: fixture.artifacts,
    observers: fixture.observers,
    modelRegistrySha256: fx.modelRegistrySha256,
    skillRegistrySha256: fx.skillRegistrySha256,
    executionPlanSha256,
    runtimePolicySha256: fx.runtimePolicySha256,
  });
  const skillApprovalRefs = Object.fromEntries(
    AI_OPERATIONS.map((operation) => [
      operation,
      {
        packageDigestSha256: fx.packages[operation].digest,
        attestationSha256: fx.packages[operation].attestationSha256 ?? sha256Hex(`attestation-${operation}`),
      },
    ]),
  );
  const descriptor = validateReleaseDescriptor({
    schemaVersion: 2,
    binding,
    inventory: fixture.inventory,
    artifacts: fixture.artifacts,
    observers: fixture.observers,
    approvalId: 'approval-v2',
    skillApprovalRefs,
    planApprovalRef: sha256Hex('plan-approval-v2'),
  });
  fixture.store.putReleaseDescriptor(descriptor);

  // Drive the real barrier to a committed ACTIVE v2 generation. A v1 record is
  // first converted by the authorized offline migration, which lands PAUSED and
  // unbound; only then can a v2 descriptor be staged.
  const store = fixture.store;
  let record = store.tryReadRecord();
  if (record === null) record = store.initialize({ inventory: fixture.inventory }).record;
  const migrated = buildMigratedRecord(record, { operatorApprovalId: 'operator-migration-1' });
  record = store.migrateRecord({
    record: migrated,
    expectedRevision: record.revision,
    operatorApprovalId: 'operator-migration-1',
  }).record;
  if (record.schemaVersion !== 2 || record.phase !== 'PAUSED') {
    throw new Error('the migration fixture must land a PAUSED schemaVersion 2 record');
  }
  record = store.transact(
    { action: 'quiesce', descriptor, transitionId: '33333333-3333-4333-8333-333333333333' },
    { expectedRevision: record.revision },
  ).record;
  record = store.transact({ action: 'prepare' }, { expectedRevision: record.revision }).record;
  for (const entry of descriptor.inventory) {
    if (!entry.enabled) continue;
    record = store.transact(
      {
        action: 'register-target',
        descriptor,
        slot: entry.slot,
        instanceId: `inst-${entry.slot}`,
        artifactSha256: descriptor.artifacts.find((candidate) => candidate.slot === entry.slot).artifactSha256,
      },
      { expectedRevision: record.revision },
    ).record;
    const instanceId = `inst-${entry.slot}`;
    const ack = {
      schemaVersion: 1,
      deploymentId: record.deploymentId,
      transitionId: record.transitionId,
      targetGeneration: record.nextGeneration,
      slot: entry.slot,
      instanceId,
      artifactSha256: descriptor.artifacts.find((candidate) => candidate.slot === entry.slot).artifactSha256,
      status: 'PREPARED',
      manifestVersion: binding.manifestVersion,
      manifestSha256: binding.manifestSha256,
      capabilityProfileSha256: binding.capabilityProfileSha256,
      inventorySha256: binding.inventorySha256,
      outstandingWork: 0,
      pendingAIApprovals: 0,
      errorCode: null,
    };
    const written = store.writeAck(record.transitionId, entry.slot, instanceId, 'PREPARED', ack);
    record = store.transact(
      { action: 'prepare-ack', ack, evidenceSha256: written.sha256 },
      { expectedRevision: record.revision },
    ).record;
  }
  for (const observer of descriptor.observers) {
    const receipt = {
      schemaVersion: 1,
      deploymentId: record.deploymentId,
      transitionId: record.transitionId,
      observerId: observer.observerId,
      artifactSha256: observer.artifactSha256,
      manifestVersion: binding.manifestVersion,
      manifestSha256: binding.manifestSha256,
      capabilityProfileSha256: binding.capabilityProfileSha256,
      status: 'VALIDATED',
      errorCode: null,
    };
    const written = store.writeObserverReceipt(record.transitionId, observer.observerId, receipt);
    record = store.transact(
      { action: 'observer-evidence', descriptor, receipt, evidenceSha256: written.sha256 },
      { expectedRevision: record.revision },
    ).record;
  }
  record = store.transact({ action: 'arm', descriptor }, { expectedRevision: record.revision }).record;
  record = store.transact({ action: 'activate', descriptor }, { expectedRevision: record.revision }).record;

  return {
    fx,
    fixture,
    binding,
    descriptor,
    record: store.readRecord(),
    cleanup() {
      fs.rmSync(fx.rootDir, { recursive: true, force: true });
    },
  };
}
