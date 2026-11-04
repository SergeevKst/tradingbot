/**
 * Production operation boundary for the data-only Skill runtime
 * (architecture v1.1 §3.1, §6.2, §10 Phase C/E).
 *
 * The isolated `composition.mjs` module knows how to prepare a six-operation plan
 * and run one operation. This module is the bridge from a *committed v2
 * generation* to that runtime, so the production compositions (core ANALYZE and
 * the Telegram participant) can dispatch through packaged Skills instead of
 * hard-coded prompts.
 *
 * Rules enforced here:
 *
 *   - A v2 dispatch requires a schemaVersion 2 joint binding. The four digests
 *     (skill registry, model registry, execution plan, runtime policy) are read
 *     from the immutable CAS and re-derived; a plan that does not reproduce the
 *     bound digest is an integrity fault.
 *   - The plan rebuilt by the planner must hash to the bound
 *     `executionPlanSha256`, which proves the profiles, capability evidence and
 *     package bytes the runtime will use are the ones the release approved.
 *   - Any structural fault yields a *refusing* dispatch: every operation returns
 *     the exact `ACTIVATION_PAUSED` envelope with zero model calls and zero
 *     effects. There is no fallback to a legacy prompt.
 *   - A v2-bound generation is never executed by a legacy-configured process, and
 *     a legacy generation is never admitted in v2 mode. Mixed-version execution
 *     is refused in both directions.
 *
 * @module ai/skills/production
 */
import { randomUUID } from 'node:crypto';
import { createSkillComposition, createRefusingComposition } from './composition.mjs';
import { createSkillPackageStore } from './package-store.mjs';
import { createOpenAICompatibleTransport } from './transport.mjs';
import {
  computeExecutionPlanDigest,
  validateArtifactIdentity,
} from '../../config/skill-release-contracts.mjs';
import { ACTIVATION_PAUSED, SkillError, structuralError } from '../../errors/skill-error.mjs';

/** Reviewed runtime modes for a production operation boundary. */
export const SKILL_RUNTIME_MODE = Object.freeze({ V2: 'v2', LEGACY: 'legacy' });

export const SKILL_RUNTIME_MODES = Object.freeze(Object.values(SKILL_RUNTIME_MODE));

/**
 * Decide whether an admitted generation may be dispatched through packaged
 * Skills, must use the explicitly authorized legacy compatibility path, or must
 * refuse.
 *
 * The decision is made from the *admitted binding* and the reviewed mode; it is
 * never inferred from the environment, a missing registry or a directory scan.
 *
 * @param {{ configuredMode: string, binding: Readonly<object> | null }} input
 * @returns {{ mode: 'v2' | 'legacy', cause: string | null }}
 */
export function resolveSkillRuntimeMode(input) {
  const { configuredMode, binding } = input;
  if (configuredMode !== SKILL_RUNTIME_MODE.V2 && configuredMode !== SKILL_RUNTIME_MODE.LEGACY) {
    throw new TypeError(
      `skill runtime mode must be ${JSON.stringify(SKILL_RUNTIME_MODE.V2)} or ` +
        `${JSON.stringify(SKILL_RUNTIME_MODE.LEGACY)}; it is never inferred`,
    );
  }
  const bindingVersion = binding === null || binding === undefined ? null : /** @type {any} */ (binding).schemaVersion;
  if (configuredMode === SKILL_RUNTIME_MODE.V2) {
    // v2 mode requires the joint v2 binding: a v1 or empty record means the
    // release plan was not bound to this generation, so no package can be
    // proven to be the approved one.
    return bindingVersion === 2
      ? { mode: SKILL_RUNTIME_MODE.V2, cause: null }
      : { mode: SKILL_RUNTIME_MODE.V2, cause: 'SKILL_REGISTRY_INVALID' };
  }
  // Legacy compatibility mode can never read a v2-bound generation: the two
  // dispatch mechanisms are not interchangeable inside one generation.
  if (bindingVersion === 2) {
    return { mode: SKILL_RUNTIME_MODE.LEGACY, cause: 'SKILL_INCOMPATIBLE' };
  }
  return { mode: SKILL_RUNTIME_MODE.LEGACY, cause: null };
}

/**
 * @param {unknown} value
 * @returns {boolean} true for the typed structural-refusal envelope
 */
export function isPausedEnvelope(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    /** @type {any} */ (value).ok === false &&
    /** @type {any} */ (value).code === ACTIVATION_PAUSED
  );
}

/**
 * @param {string} cause
 * @param {() => string} [uuid]
 */
export function createRefusingDispatch(cause, uuid = () => randomUUID()) {
  return Object.freeze({
    mode: SKILL_RUNTIME_MODE.V2,
    refusing: true,
    cause,
    planSha256: null,
    plan: null,
    composition: createRefusingComposition(cause, uuid),
  });
}

/**
 * @param {Readonly<object>} modelRegistry
 * @returns {string[]} unique allowlisted hosts
 */
function allowedHostsFromRegistry(modelRegistry) {
  const hosts = new Set();
  const models = /** @type {any} */ (modelRegistry).models ?? {};
  for (const entry of Object.values(models)) {
    const url = new URL(/** @type {any} */ (entry).canonicalBaseUrl);
    hosts.add(url.hostname);
  }
  if (hosts.size === 0) {
    throw structuralError('SKILL_REGISTRY_INVALID', 'the bound model registry names no endpoint');
  }
  return [...hosts];
}

/**
 * Build the v2 dispatch for one admitted generation.
 *
 * @param {{
 *   binding: Readonly<object>,
 *   controlDir?: string,
 *   store?: any,
 *   profileReader?: { read: (profileSha256: string) => Readonly<object> },
 *   artifact: Readonly<object>,
 *   transport?: { id: string, complete: (request: any) => Promise<any> },
 *   fetchImpl?: typeof fetch,
 *   credentialProvider?: (identity: any) => string | null,
 *   identity?: Record<string, unknown>,
 *   latch?: any,
 *   clock?: () => number,
 *   uuid?: () => string,
 *   audit?: ((event: Readonly<object>) => void) | null,
 *   adapters?: Record<string, any>,
 *   freshnessMs?: number,
 * }} input
 * @returns {Readonly<object>} a prepared or refusing dispatch
 */
export function createProductionSkillDispatch(input) {
  const uuid = input.uuid ?? (() => randomUUID());
  const binding = input.binding;
  try {
    return buildDispatch(input, uuid);
  } catch (error) {
    if (!(error instanceof SkillError)) throw error;
    return createRefusingDispatch(error.structural ? error.code : 'SKILL_REGISTRY_INVALID', uuid);
  }
}

/**
 * @param {any} input
 * @param {() => string} uuid
 */
function buildDispatch(input, uuid) {
  const binding = input.binding;
  if (binding === null || typeof binding !== 'object' || /** @type {any} */ (binding).schemaVersion !== 2) {
    throw structuralError(
      'SKILL_REGISTRY_INVALID',
      'v2 dispatch requires a schemaVersion 2 joint binding',
      { field: 'binding.schemaVersion' },
    );
  }
  const store = input.store ?? createSkillPackageStore({ rootDir: input.controlDir });

  const plan = store.readExecutionPlan(binding.executionPlanSha256);
  if (computeExecutionPlanDigest(plan) !== binding.executionPlanSha256) {
    throw structuralError('SKILL_INTEGRITY_MISMATCH', 'the stored execution plan does not hash to the bound digest', {
      field: 'binding.executionPlanSha256',
    });
  }
  if (
    plan.skillRegistrySha256 !== binding.skillRegistrySha256 ||
    plan.modelRegistrySha256 !== binding.modelRegistrySha256 ||
    plan.runtimePolicySha256 !== binding.runtimePolicySha256
  ) {
    throw structuralError('SKILL_INTEGRITY_MISMATCH', 'the execution plan references different registries than the binding', {
      field: 'binding',
    });
  }
  // Re-read every referenced document so a missing blob is a structural fault
  // here, not halfway through an operation.
  store.readRegistry(binding.skillRegistrySha256);
  const modelRegistry = store.readModelRegistry(binding.modelRegistrySha256);
  store.readRuntimePolicy(binding.runtimePolicySha256);
  const artifact = validateArtifactIdentity(input.artifact);

  let transport = input.transport;
  if (!transport) {
    if (typeof input.fetchImpl !== 'function' || typeof input.credentialProvider !== 'function') {
      throw new TypeError('createProductionSkillDispatch requires { transport } or { fetchImpl, credentialProvider }');
    }
    transport = createOpenAICompatibleTransport({
      fetchImpl: input.fetchImpl,
      credentialProvider: input.credentialProvider,
      allowedHosts: allowedHostsFromRegistry(modelRegistry),
    });
  }

  const composition = createSkillComposition({
    store,
    skillRegistrySha256: binding.skillRegistrySha256,
    modelRegistrySha256: binding.modelRegistrySha256,
    runtimePolicySha256: binding.runtimePolicySha256,
    artifact,
    profileReader: input.profileReader ?? { read: (digest) => input.controlStore.readProfile(digest) },
    transport,
    identity: input.identity ?? {},
    latch: input.latch,
    clock: input.clock,
    uuid,
    audit: input.audit,
    adapters: input.adapters,
    freshnessMs: input.freshnessMs,
  });

  if (composition.refusing === true) {
    // The planner could not rebuild the six pairs from verified bytes. The plan
    // digest can therefore not be trusted, so the generation is refused rather
    // than silently downgraded.
    return createRefusingDispatch(composition.admissionCause() ?? 'SKILL_REGISTRY_INVALID', uuid);
  }
  if (composition.planSha256 !== binding.executionPlanSha256) {
    // The rebuilt plan must reproduce the approved digest exactly, or the
    // profiles/evidence/packages the runtime would use are not the approved
    // ones (architecture §7.1 agreement across references).
    return createRefusingDispatch('SKILL_INTEGRITY_MISMATCH', uuid);
  }
  return Object.freeze({
    mode: SKILL_RUNTIME_MODE.V2,
    refusing: false,
    cause: null,
    plan,
    planSha256: composition.planSha256,
    modelRegistry,
    composition,
  });
}

/**
 * Resolve and build the dispatch a production participant should use for the
 * admitted generation.
 *
 * @param {{
 *   configuredMode: string,
 *   binding: Readonly<object> | null,
 *   controlDir?: string,
 *   store?: any,
 *   controlStore?: any,
 *   profileReader?: { read: (profileSha256: string) => Readonly<object> },
 *   artifact?: Readonly<object>,
 *   transport?: any,
 *   fetchImpl?: typeof fetch,
 *   credentialProvider?: (identity: any) => string | null,
 *   identity?: Record<string, unknown>,
 *   latch?: any,
 *   clock?: () => number,
 *   uuid?: () => string,
 *   audit?: ((event: Readonly<object>) => void) | null,
 *   adapters?: Record<string, any>,
 *   freshnessMs?: number,
 * }} input
 * @returns {{ mode: 'v2' | 'legacy', refusing: boolean, cause: string | null, dispatch: Readonly<object> | null, composition: Readonly<object> | null }}
 */
export function createProductionDispatch(input) {
  const uuid = input.uuid ?? (() => randomUUID());
  const resolution = resolveSkillRuntimeMode({ configuredMode: input.configuredMode, binding: input.binding });
  if (resolution.mode === SKILL_RUNTIME_MODE.LEGACY) {
    if (resolution.cause !== null) {
      // A v2 record in a legacy-configured process: refuse every operation.
      return Object.freeze({
        mode: SKILL_RUNTIME_MODE.LEGACY,
        refusing: true,
        cause: resolution.cause,
        dispatch: null,
        composition: createRefusingComposition(resolution.cause, uuid),
      });
    }
    // Explicitly authorized compatibility mode: the caller keeps its legacy
    // dispatch. No packaged skill is prepared for this generation.
    return Object.freeze({
      mode: SKILL_RUNTIME_MODE.LEGACY,
      refusing: false,
      cause: null,
      dispatch: null,
      composition: null,
    });
  }
  const dispatch = createProductionSkillDispatch({ ...input, uuid });
  return Object.freeze({
    mode: SKILL_RUNTIME_MODE.V2,
    refusing: dispatch.refusing,
    cause: dispatch.cause,
    dispatch,
    composition: dispatch.composition,
  });
}
