/**
 * Public operation boundary for the Skill runtime (architecture v1.1 §6.2, §6.3).
 *
 * This is the module trusted callers use. Two responsibilities only:
 *
 *   1. Prepare the six-operation plan once, at start. A candidate that cannot be
 *      prepared never admits inference: the composition is built in a *refusing*
 *      mode where every one of the six operations returns the exact
 *      `ACTIVATION_PAUSED` envelope, with the structural cause in safe
 *      diagnostic metadata and zero model calls or effects.
 *   2. Expose one typed method per operation plus `execute`, and never translate
 *      a structural refusal into a legacy outcome (null, PROVIDER_ERROR, empty
 *      ideas, fabricated HOLD).
 *
 * @module ai/skills/composition
 */
import { randomUUID } from 'node:crypto';
import { structuralError, SkillError } from '../../errors/skill-error.mjs';
import { AI_OPERATIONS } from '../operation-profiles.mjs';
import { ADAPTERS } from './adapters/catalogue.mjs';
import { createDataBroker } from './data-broker.mjs';
import { prepareExecutionPlan } from './execution-plan.mjs';
import { createSkillRuntime, SkillAdmissionLatch, SkillWorkflowScope } from './runtime.mjs';

/** Runtime modes. `v2` is the skill-based path; `legacy` is explicitly reviewed. */
export const RUNTIME_MODE = Object.freeze({ V2: 'v2', LEGACY: 'legacy' });

/**
 * Resolve the runtime mode from **reviewed configuration only**.
 *
 * Process environment, file presence and a missing registry are never allowed to
 * silently downgrade a v2 deployment to uncounted legacy dispatch, and a v2
 * control record can never be read by a legacy-only process (mixed-version
 * execution is refused).
 *
 * @param {{ configuredMode: string, controlRecord: Readonly<object> | null }} input
 * @returns {'v2' | 'legacy'}
 */
export function resolveRuntimeMode(input) {
  const record = input.controlRecord;
  const recordVersion = record === null || record === undefined ? null : /** @type {any} */ (record).schemaVersion;
  if (input.configuredMode === RUNTIME_MODE.V2) {
    if (recordVersion !== 2) {
      throw structuralError(
        'SKILL_REGISTRY_INVALID',
        'v2 mode requires a schemaVersion 2 control record; refusing to assume a legacy or empty store',
        { field: 'controlRecord.schemaVersion' },
      );
    }
    return RUNTIME_MODE.V2;
  }
  if (input.configuredMode === RUNTIME_MODE.LEGACY) {
    if (recordVersion === 2) {
      throw structuralError(
        'SKILL_INCOMPATIBLE',
        'a schemaVersion 2 control record cannot be consumed in legacy compatibility mode',
        { field: 'controlRecord.schemaVersion' },
      );
    }
    return RUNTIME_MODE.LEGACY;
  }
  throw new TypeError(
    `configuredMode must be ${JSON.stringify(RUNTIME_MODE.V2)} or ${JSON.stringify(RUNTIME_MODE.LEGACY)}; ` +
      'the mode is never inferred from the environment',
  );
}

/**
 * @param {string} operation
 * @param {string} cause
 * @param {string} requestId
 */
function pausedEnvelope(operation, cause, requestId) {
  return Object.freeze({
    ok: /** @type {false} */ (false),
    operation,
    code: 'ACTIVATION_PAUSED',
    cause,
    retryable: /** @type {false} */ (false),
    requestId,
  });
}

/**
 * A composition that refuses every operation with the exact
 * `ACTIVATION_PAUSED` envelope.
 *
 * Callers reach this state when the reviewed plan cannot be prepared (missing,
 * invalid, unapproved or mismatched package) or when a production boundary is
 * configured for v2 but the admitted generation carries no v2 joint binding.
 * Both accepted refusals and no result may be produced from it.
 *
 * @param {string} cause structural cause (safe diagnostic)
 * @param {() => string} uuid
 */
export function createRefusingComposition(cause, uuid) {
  /**
   * @param {string} operation
   */
  const refuse = (operation) => async () => pausedEnvelope(operation, cause, uuid());
  /** @type {Record<string, unknown>} */
  const methods = {};
  for (const operation of AI_OPERATIONS) {
    // Both spellings exist on a healthy composition, so both must refuse here:
    // a caller must never be able to tell the two modes apart except by the code.
    methods[operation] = refuse(operation);
    methods[operation.toLowerCase()] = methods[operation];
  }
  return Object.freeze({
    ...methods,
    /** @param {{ operation: string }} request */
    execute: async (request) => pausedEnvelope(request?.operation ?? 'UNKNOWN', cause, uuid()),
    admissionState: () => 'LATCHED_CLOSED',
    admissionCause: () => cause,
    closeAdmission: () => {},
    plan: null,
    planSha256: null,
    latch: null,
    refusing: true,
  });
}

/**
 * Create the public composition.
 *
 * @param {{
 *   store: any,
 *   skillRegistrySha256: string,
 *   modelRegistrySha256: string,
 *   runtimePolicySha256: string,
 *   artifact: Readonly<object>,
 *   profileReader: { read: (profileSha256: string) => Readonly<object> },
 *   transport: { id: string, complete: (request: any) => Promise<any> },
 *   identity?: Record<string, unknown>,
 *   latch?: SkillAdmissionLatch,
 *   clock?: () => number,
 *   uuid?: () => string,
 *   audit?: ((event: Readonly<object>) => void) | null,
 *   freshnessMs?: number,
 *   adapters?: Record<string, any>,
 * }} input
 * @returns {Readonly<object>}
 */
export function createSkillComposition(input) {
  const uuid = input.uuid ?? (() => randomUUID());
  const adapters = input.adapters ?? ADAPTERS;
  let planResult;
  try {
    planResult = prepareExecutionPlan({
      store: input.store,
      skillRegistrySha256: input.skillRegistrySha256,
      modelRegistrySha256: input.modelRegistrySha256,
      runtimePolicySha256: input.runtimePolicySha256,
      artifact: input.artifact,
      profileReader: input.profileReader,
      adapters,
    });
  } catch (error) {
    const cause = error instanceof SkillError && error.structural ? error.code : 'SKILL_REGISTRY_INVALID';
    if (typeof input.audit === 'function') {
      try {
        input.audit(Object.freeze({ event: 'plan.rejected', cause, at: (input.clock ?? Date.now)() }));
      } catch {
        // Telemetry failure never changes the refusal.
      }
    }
    return createRefusingComposition(cause, uuid);
  }

  const broker = createDataBroker({
    adapters,
    grants: /** @type {any} */ (planResult.policy).operationGrants,
    freshnessMs: input.freshnessMs,
    clock: input.clock,
  });
  const runtime = createSkillRuntime({
    planResult,
    transport: input.transport,
    broker,
    identity: /** @type {any} */ (input.identity ?? {}),
    latch: input.latch,
    clock: input.clock,
    uuid,
    audit: input.audit,
  });

  /**
   * @param {string} operation
   */
  const method = (operation) => async (hostInput, work) =>
    runtime.execute({ operation, input: hostInput }, work instanceof SkillWorkflowScope ? work : new SkillWorkflowScope(work));

  return Object.freeze({
    ANALYZE: method('ANALYZE'),
    SCOUT: method('SCOUT'),
    GUARD: method('GUARD'),
    MONITOR: method('MONITOR'),
    STOPCHECK: method('STOPCHECK'),
    REFLECT: method('REFLECT'),
    analyze: method('ANALYZE'),
    scout: method('SCOUT'),
    guard: method('GUARD'),
    monitor: method('MONITOR'),
    stopcheck: method('STOPCHECK'),
    reflect: method('REFLECT'),
    /** @param {{ operation: string, input: unknown }} request @param {any} work */
    execute: (request, work) =>
      runtime.execute(request, work instanceof SkillWorkflowScope ? work : new SkillWorkflowScope(work)),
    admissionState: runtime.admissionState,
    admissionCause: runtime.admissionCause,
    closeAdmission: runtime.closeAdmission,
    plan: planResult.plan,
    planSha256: planResult.planSha256,
    latch: runtime.latch,
    refusing: false,
  });
}

export { SkillAdmissionLatch, SkillWorkflowScope };
