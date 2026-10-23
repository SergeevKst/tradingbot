#!/usr/bin/env node
/**
 * Participant identity probe (UAI-09 §4 "all counts/hashes derive from actual
 * traces/files").
 *
 * The release report must not assert `identityReady: true` from a static roster.
 * This script is spawned by `ai_release_verify.mjs` once per observed
 * participant, in its own process, and performs the participant's
 * side-effect-free startup validation against the durable control record:
 * deployment ID, ACTIVE phase, manifest version/hash, profile, artifact
 * assignment and committed membership.
 *
 * It writes nothing, claims no slot, loads no key and makes no provider call.
 * Its JSON result is the only source of `identityReady` in the report.
 *
 * Usage:
 *   node scripts/ai_participant_probe.mjs --control-dir DIR --deployment-id ID \
 *     --slot SLOT --instance-id ID --expected-manifest-version V \
 *     --expected-manifest-sha SHA --artifact-sha SHA
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createControlStore } from '../src/ai/coordination/control-store.mjs';
import { validateObserverIdentity } from '../src/ai/coordination/generation-guard.mjs';

const { values } = parseArgs({
  options: {
    'control-dir': { type: 'string' },
    'deployment-id': { type: 'string' },
    slot: { type: 'string' },
    'instance-id': { type: 'string' },
    'expected-manifest-version': { type: 'string' },
    'expected-manifest-sha': { type: 'string' },
    'artifact-sha': { type: 'string' },
    policy: { type: 'string' },
  },
});

/**
 * @param {string} message
 * @returns {never}
 */
function refuse(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, identityReady: false, error: message })}\n`);
  process.exit(2);
}

try {
  for (const name of ['control-dir', 'deployment-id', 'slot', 'instance-id', 'expected-manifest-version', 'expected-manifest-sha']) {
    if (!values[name]) refuse(`missing --${name}`);
  }
  const policy = values.policy ? JSON.parse(values.policy) : undefined;
  const store = createControlStore({ controlDir: path.resolve(values['control-dir']) });
  const record = store.readRecord();

  // The generic identity validation (phase, deployment, manifest, profile).
  const validation = validateObserverIdentity({
    controlStore: store,
    deploymentId: values['deployment-id'],
    expectedManifestVersion: values['expected-manifest-version'],
    expectedManifestSha256: values['expected-manifest-sha'],
    artifactSha256: values['artifact-sha'] ?? null,
    policy,
  });

  // Membership: a validated manifest is not the same thing as being the admitted
  // participant of this slot.
  const membership = record.members.find((member) => member.slot === values.slot) ?? null;
  const membershipOk = membership !== null
    && membership.instanceId === values['instance-id']
    && (values['artifact-sha'] ? membership.artifactSha256 === values['artifact-sha'] : true);
  const inventoryEntry = record.inventory.find((entry) => entry.slot === values.slot) ?? null;
  const identityReady = validation.identityValidated === true && membershipOk;

  process.stdout.write(`${JSON.stringify({
    ok: true,
    slot: values.slot,
    instanceId: values['instance-id'],
    identityReady,
    inferenceEnabled: identityReady && inventoryEntry?.enabled === true,
    artifactSha256: validation.artifactSha256,
    manifestVersion: validation.manifestVersion,
    manifestSha256: validation.manifestSha256,
    capabilityProfileSha256: validation.capabilityProfileSha256,
    generation: validation.generation,
    phase: validation.phase,
    committedInstanceId: membership?.instanceId ?? null,
    errorCode: validation.errorCode,
    membershipOk,
    checkedAt: validation.checkedAt,
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    identityReady: false,
    error: error instanceof Error ? error.message : String(error),
    code: error?.code ?? null,
  })}\n`);
  process.exitCode = 1;
}
