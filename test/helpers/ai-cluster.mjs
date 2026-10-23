/**
 * Cross-process test harness (UAI-06C).
 *
 * The parent test drives real child processes and the real release CLI, and
 * shares only a temporary control directory. No participant runs in the test
 * process, so an "in-process validation" bug cannot hide here.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAlternateDescriptor, buildReleaseFixture } from '../fixtures/ai-release/factory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const CHILD_ENTRY = path.join(HERE, 'ai-participant-child.mjs');
export const CLI_ENTRY = path.join(REPO_ROOT, 'scripts', 'ai_release.mjs');

/** Every spawned participant, so a failing assertion cannot leak a process. */
const liveParticipants = new Set();

/**
 * Kill every participant that is still running. Called from an `after()` hook in
 * the cross-process suite so a failed test never keeps the runner alive.
 */
export async function killAllParticipants() {
  for (const child of [...liveParticipants]) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  liveParticipants.clear();
}

/**
 * @param {string} file
 * @returns {any[]}
 */
export function readTrace(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * @param {{ manifestVersion?: string, inventory?: any[], artifactMap?: object }} [options]
 */
export function createHarness(options = {}) {
  const fixture = buildReleaseFixture({
    manifestVersion: options.manifestVersion ?? 'release-1',
    inventory: options.inventory,
    artifactMap: options.artifactMap,
  });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-xp-'));
  const descriptorPath = path.join(workDir, 'descriptor.json');
  fs.writeFileSync(descriptorPath, JSON.stringify(fixture.descriptor));
  const alternateDescriptorPath = path.join(workDir, 'descriptor-alt.json');
  const alternate = buildAlternateDescriptor({
    fixture,
    manifestVersion: options.alternateVersion ?? 'release-2',
    inventory: options.alternateInventory,
    artifactMap: options.alternateArtifactMap,
  });
  fs.writeFileSync(alternateDescriptorPath, JSON.stringify(alternate.descriptor));
  const inventoryPath = path.join(workDir, 'inventory.json');
  fs.writeFileSync(inventoryPath, JSON.stringify(fixture.inventory));
  const state = { fixture, workDir, descriptorPath, alternateDescriptorPath, inventoryPath, alternate };
  const initialized = runCli({ fixture }, 'initialize', { inventory: inventoryPath });
  if (!initialized.body.ok) {
    throw new Error(`harness initialize failed: ${JSON.stringify(initialized.body)}`);
  }
  state.deploymentId = initialized.body.deploymentId;
  return state;
}

/**
 * @param {ReturnType<typeof createHarness>} harness
 * @returns {{ deployId: string, phase: string, generation: number, revision: number, raw: any }}
 */
export function inspect(harness) {
  const result = runCli(harness, 'inspect');
  if (!result.body.ok) return { deployId: harness.deploymentId, phase: 'UNREADABLE', generation: -1, revision: -1, raw: result.body };
  return {
    deployId: result.body.deploymentId,
    phase: result.body.phase,
    generation: result.body.generation,
    revision: result.body.revision,
    raw: result.body,
  };
}

/**
 * Run one release CLI verb in a separate process.
 *
 * @param {ReturnType<typeof createHarness>} harness
 * @param {string} verb
 * @param {Record<string, string | number | undefined>} [args]
 * @param {{ fault?: string }} [options]
 */
export function runCli(harness, verb, args = {}, options = {}) {
  const argv = [CLI_ENTRY, verb, '--control-dir', harness.fixture.controlDir];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    argv.push(`--${key}`, String(value));
  }
  if (options.fault) argv.push('--fault', options.fault);
  const result = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 30000 });
  const line = (result.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '{}';
  let body;
  try {
    body = JSON.parse(line);
  } catch {
    body = { ok: false, error: { code: 'CLI_OUTPUT', message: line || result.stderr } };
  }
  return { status: result.status, body, stderr: result.stderr };
}

/**
 * @param {ReturnType<typeof createHarness>} harness
 * @param {{ role: 'core'|'telegram'|'observer', slot?: string|null, instanceId: string, expectedVersion?: string, expectedSha256?: string, artifactSha256?: string, deploymentId?: string, env?: Record<string,string> }} options
 */
export function spawnParticipant(harness, options) {
  const trace = path.join(harness.workDir, `trace-${options.instanceId}-${Math.random().toString(16).slice(2, 8)}.jsonl`);
  fs.writeFileSync(trace, '');
  const configFile = path.join(harness.workDir, `config-${options.instanceId}-${Math.random().toString(16).slice(2, 8)}.json`);
  fs.writeFileSync(configFile, JSON.stringify({
    role: options.role,
    controlDir: harness.fixture.controlDir,
    deploymentId: options.deploymentId ?? harness.deploymentId,
    slot: options.slot ?? null,
    artifactSha256: options.artifactSha256 ?? harness.fixture.artifactMap[options.slot],
    expectedManifestVersion: options.expectedVersion ?? harness.fixture.manifest.manifestVersion,
    expectedManifestSha256: options.expectedSha256 ?? harness.fixture.manifestSha256,
    instanceId: options.instanceId,
    trace,
    env: options.env ?? {},
  }));
  const child = spawn(process.execPath, [CHILD_ENTRY, configFile], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ...(options.env ?? {}) },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  liveParticipants.add(child);
  child.on('exit', () => liveParticipants.delete(child));
  /** @type {Map<number, {resolve: Function, reject: Function}>} */
  const waiters = new Map();
  let sequence = 1;
  /** @type {(value?: any) => void} */
  let markReady;
  const readyPromise = new Promise((resolve) => {
    markReady = resolve;
  });
  child.on('message', (message) => {
    if (message.id === 0) {
      markReady(message.result ?? {});
      return;
    }
    const waiter = waiters.get(message.id);
    if (!waiter) return;
    waiters.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(Object.assign(new Error(message.error?.message ?? 'child error'), { code: message.error?.code }));
  });
  child.on('exit', (code) => {
    for (const waiter of waiters.values()) waiter.reject(new Error(`child exited with ${code}: ${stderr}`));
    waiters.clear();
    markReady(null);
  });

  /**
   * @param {object} command
   * @param {{ timeoutMs?: number }} [opts]
   */
  async function cmd(command, opts = {}) {
    /** @type {NodeJS.Timeout | undefined} */
    let readyTimer;
    const readyInfo = await Promise.race([
      readyPromise,
      new Promise((resolve) => {
        readyTimer = setTimeout(() => resolve(null), opts.timeoutMs ?? 15000);
      }),
    ]);
    if (readyTimer) clearTimeout(readyTimer);
    if (readyInfo === null) throw new Error(`child is not ready: ${stderr}`);
    if (!child.connected) throw new Error(`child is not connected: ${stderr}`);
    const id = sequence++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`child command timed out: ${command.cmd}`));
      }, opts.timeoutMs ?? 15000);
      waiters.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.send({ ...command, id });
    });
  }

  return {
    child,
    trace,
    cmd,
    get stderr() {
      return stderr;
    },
    async start() {
      const status = await cmd({ cmd: 'start' });
      return status;
    },
    async stop() {
      try {
        if (child.connected) await cmd({ cmd: 'exit' }, { timeoutMs: 2000 });
      } catch {
        /* already gone */
      }
      if (!child.killed) child.kill('SIGKILL');
    },
    async kill(signal = 'SIGKILL') {
      child.kill(signal);
    },
    events() {
      return readTrace(trace);
    },
  };
}

/**
 * Drive a complete barrier through the real CLI, delegating only the participant
 * steps (ack/prepare/promote) to the child processes.
 *
 * @param {ReturnType<typeof createHarness>} harness
 * @param {{
 *   descriptorPath: string,
 *   descriptorSha: string,
 *   manifestVersion: string,
 *   manifestSha256: string,
 *   participants: { child: any, slot: string, instanceId: string, retained: boolean }[],
 *   fence?: string[],
 *   observerArtifactSha256?: string,
 *   transitionId?: string,
 * }} input
 */
export async function completeBarrier(harness, input) {
  const transitionId = input.transitionId ?? randomUuid();
  const quiesce = runCli(harness, 'quiesce', {
    descriptor: input.descriptorPath,
    'transition-id': transitionId,
  });
  if (!quiesce.body.ok) throw new Error(`quiesce failed: ${JSON.stringify(quiesce.body)}`);

  const oldMembers = quiesce.body.oldMembers ?? [];
  // Quiescence: live participants ack; every other old member needs an explicit
  // operator fence, exactly as the protocol requires.
  for (const child of input.participants) {
    const isOld = oldMembers.some((member) => member.slot === child.slot && member.instanceId === child.instanceId);
    if (!isOld) continue;
    if ((input.fence ?? []).includes(child.slot)) continue;
    await child.child.cmd({ cmd: 'poll' });
    const ack = await child.child.cmd({ cmd: 'ack' });
    if (!ack?.sha256) throw new Error(`participant ${child.slot} did not produce an ack`);
  }
  const collected = runCli(harness, 'collect-quiescence');
  if (!collected.body.ok) throw new Error(`collect-quiescence failed: ${JSON.stringify(collected.body)}`);

  for (const slot of input.fence ?? []) {
    const fenceRecord = {
      schemaVersion: 1,
      deploymentId: harness.deploymentId,
      transitionId,
      slot,
      instanceId: oldMembers.find((candidate) => candidate.slot === slot)?.instanceId,
      operatorApprovalId: 'operator-fence-1',
      processFenceEvidenceRef: 'evidence/fencing/process-exit.txt',
      outcomeReconciliationRef: 'evidence/reconciliation/orders.txt',
    };
    const fencePath = path.join(harness.workDir, `fence-${slot}.json`);
    fs.writeFileSync(fencePath, JSON.stringify(fenceRecord));
    const retired = runCli(harness, 'retire', {
      slot,
      instance: fenceRecord.instanceId,
      kind: 'FENCED',
      evidence: fencePath,
    });
    if (!retired.body.ok) throw new Error(`fence ${slot} failed: ${JSON.stringify(retired.body)}`);
  }

  const prepared = runCli(harness, 'prepare');
  if (!prepared.body.ok) throw new Error(`prepare failed: ${JSON.stringify(prepared.body)}`);

  for (const participant of input.participants) {
    if (participant.retained) {
      const granted = runCli(harness, 'grant', {
        slot: participant.slot,
        instance: participant.instanceId,
        'descriptor-sha': input.descriptorSha,
      });
      if (!granted.body.ok) throw new Error(`grant failed: ${JSON.stringify(granted.body)}`);
      const staged = await participant.child.cmd({
        cmd: 'prepare',
        grant: { descriptorSha256: input.descriptorSha, approvalId: granted.body.approvalId },
      });
      if (!staged?.sha256) throw new Error(`prepare failed for ${participant.slot}`);
    } else {
      const started = await participant.child.cmd({ cmd: 'start' });
      if (!started?.identityReady) throw new Error(`target join failed for ${participant.slot}: ${JSON.stringify(started)}`);
      const staged = await participant.child.cmd({ cmd: 'prepare' });
      if (!staged?.sha256) throw new Error(`prepare failed for ${participant.slot}: ${JSON.stringify(staged)}`);
    }
  }
  const prepareCollected = runCli(harness, 'collect-prepared');
  if (!prepareCollected.body.ok) throw new Error(`collect-prepared failed: ${JSON.stringify(prepareCollected.body)}`);

  if (input.observerArtifactSha256) {
    const observed = runCli(harness, 'observer', {
      'transition-id': transitionId,
      'observer-id': 'core-bootstrap',
      'artifact-sha': input.observerArtifactSha256,
      'manifest-version': input.manifestVersion,
      'manifest-sha': input.manifestSha256,
    });
    if (!observed.body.ok) throw new Error(`observer validation failed: ${JSON.stringify(observed.body)}`);
  }

  const armed = runCli(harness, 'arm');
  if (!armed.body.ok) throw new Error(`arm failed: ${JSON.stringify(armed.body)}`);
  const activated = runCli(harness, 'activate');
  if (!activated.body.ok) throw new Error(`activate failed: ${JSON.stringify(activated.body)}`);

  for (const participant of input.participants) {
    await participant.child.cmd({ cmd: 'poll' });
  }
  return activated.body;
}

/** @returns {string} */
export function randomUuid() {
  return randomUUID();
}
