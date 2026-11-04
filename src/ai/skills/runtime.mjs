/**
 * Bounded data-only Skill runtime (architecture v1.1 §3.1, §6.3).
 *
 * One generic execution path for all six operations:
 *
 *   admission → broker projection → host validation → package input schema
 *   → literal render → one bounded completion → strict parse → package output
 *   schema → host domain validation → typed result + trusted provenance
 *
 * Safety properties that this module owns:
 *
 *   - **Fail closed structurally.** A required-Skill structural fault latches
 *     admission closed synchronously (before any await), taints the joined
 *     workflow and returns the exact `ACTIVATION_PAUSED` envelope. No model call
 *     and no effect can follow.
 *   - **No fallback, retry, repair or salvage.** One call, no tools, no defaults.
 *   - **Local, not durable.** Refusal never writes the control store. Fleet-wide
 *     pause remains the authorized writer's job.
 *
 * @module ai/skills/runtime
 */
import { randomUUID } from 'node:crypto';
import { digestJson, isPlainObject, parseStrictJson } from '../../config/jcs.mjs';
import { ACTIVATION_PAUSED, SkillError, toFailureEnvelope, ordinaryError, structuralError } from '../../errors/skill-error.mjs';
import { AI_OPERATIONS } from '../operation-profiles.mjs';
import { renderSkillMessages } from './renderer.mjs';
import { instanceValid } from './schema-validator.mjs';

/** Admission substates (architecture §7.3). Local and diagnostic only. */
export const ADMISSION_STATE = Object.freeze({ OPEN: 'OPEN', LATCHED_CLOSED: 'LATCHED_CLOSED' });

/**
 * Participant-local admission latch.
 *
 * The latch is deliberately not persisted: runtime refusal must not acquire
 * control-store write privileges. Sharing it across a same-generation restart
 * (by passing the same instance) keeps it closed, which is what "a restart
 * cannot clear the latch" means locally; clearing it fleet-wide requires the
 * authorized higher-generation transition.
 */
export class SkillAdmissionLatch {
  /** @type {'OPEN' | 'LATCHED_CLOSED'} */
  #state = ADMISSION_STATE.OPEN;
  /** @type {string | null} */
  #cause = null;

  /**
   * @param {string} cause structural cause
   */
  close(cause) {
    if (this.#state === ADMISSION_STATE.LATCHED_CLOSED) return;
    this.#state = ADMISSION_STATE.LATCHED_CLOSED;
    this.#cause = cause;
  }

  get state() {
    return this.#state;
  }

  get cause() {
    return this.#cause;
  }

  isClosed() {
    return this.#state === ADMISSION_STATE.LATCHED_CLOSED;
  }
}

/**
 * Joined whole-work scope. Carries the caller's work token, the taint state and
 * the unconsumed effect handles that a fault invalidates.
 */
export class SkillWorkflowScope {
  /** @type {{ structural: boolean, cause: string } | null} */
  #taint = null;
  /** @type {Set<{ invalidated: boolean, kind: string }>} */
  #handles = new Set();

  /**
   * @param {{ workToken: string, requestId?: string }} input
   */
  constructor(input) {
    if (input === null || typeof input !== 'object' || typeof input.workToken !== 'string' || input.workToken === '') {
      throw new TypeError('SkillWorkflowScope requires { workToken }');
    }
    this.workToken = input.workToken;
    this.requestId = input.requestId ?? null;
  }

  /**
   * Current taint record, or `null` when the workflow is clean. The accessor is
   * deliberately not named `taint`: a getter and a mutator of the same name would
   * shadow each other and turn every read into the function object.
   *
   * @returns {{ structural: boolean, cause: string } | null}
   */
  get taintState() {
    return this.#taint;
  }

  /**
   * @param {{ structural: boolean, cause: string }} taint
   */
  taint(taint) {
    // The first taint wins: a later, milder failure never erases an earlier
    // structural fault.
    if (this.#taint === null) this.#taint = Object.freeze({ ...taint });
    if (this.#taint.structural) this.invalidateEffectHandles();
  }

  /** Invalidate every unconsumed approval/effect handle in this workflow. */
  invalidateEffectHandles() {
    for (const handle of this.#handles) {
      handle.invalidated = true;
    }
    this.#handles.clear();
  }

  /**
   * Register an effect handle that a structural fault must invalidate.
   *
   * @param {string} kind
   * @returns {{ kind: string, invalidated: boolean, consume: () => void, isUsable: () => boolean }}
   */
  registerEffectHandle(kind) {
    const scope = this;
    const handle = {
      kind,
      invalidated: false,
      isUsable() {
        return handle.invalidated === false && scope.#taint === null;
      },
      consume() {
        if (!handle.isUsable()) {
          throw ordinaryError('SKILL_POLICY_DENIED', 'the effect handle was invalidated by a workflow fault');
        }
        handle.invalidated = true;
        scope.#handles.delete(handle);
      },
    };
    if (this.#taint !== null) handle.invalidated = true;
    else this.#handles.add(handle);
    return handle;
  }
}

const TRUSTED_RESULTS = new WeakSet();

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTrustedSkillResult(value) {
  return typeof value === 'object' && value !== null && TRUSTED_RESULTS.has(value);
}

/**
 * Parse a provider answer with the repository strict JSON parser.
 *
 * `JSON.parse` silently keeps the last duplicate key, so an answer carrying two
 * `bias` fields (or any other repeated member) would be accepted as if the
 * model had produced one unambiguous object. Architecture v1.1 §3.1 step 6 and
 * §9.2 require duplicate-key rejection, so the strict parser is used for both
 * the direct body and the nested chat `message.content`.
 *
 * @param {unknown} body
 * @returns {unknown}
 */
function parseModelJson(body) {
  if (typeof body !== 'string' || body.trim() === '') {
    throw ordinaryError('SKILL_OUTPUT_INVALID', 'the provider returned an empty response body');
  }
  let parsed;
  try {
    parsed = parseStrictJson(body, { label: 'skill model answer' });
  } catch {
    // The strict parser rejects duplicate keys, trailing content, invalid
    // escapes and over-deep nesting; the raw body never enters the diagnostic.
    throw ordinaryError('SKILL_OUTPUT_INVALID', 'the provider response is not strict JSON');
  }
  if (Array.isArray(parsed) || !isPlainObject(parsed)) {
    throw ordinaryError('SKILL_OUTPUT_INVALID', 'the provider response is not a JSON object');
  }
  const record = /** @type {Record<string, unknown>} */ (parsed);
  if ('tool_calls' in record || 'function_call' in record) {
    throw ordinaryError('SKILL_TOOL_DENIED', 'the model requested a tool, which v2.0 never provides');
  }
  // Chat-completions envelopes are accepted only when they carry exactly one
  // string content field; otherwise the object itself must be the answer.
  if ('choices' in record) {
    const choices = record.choices;
    if (!Array.isArray(choices) || choices.length !== 1) {
      throw ordinaryError('SKILL_OUTPUT_INVALID', 'the provider returned an unexpected choices envelope');
    }
    const choice = /** @type {any} */ (choices[0]);
    const message = choice?.message;
    if (!message || typeof message !== 'object') {
      throw ordinaryError('SKILL_OUTPUT_INVALID', 'the provider response has no message');
    }
    if ('tool_calls' in message || 'function_call' in message) {
      throw ordinaryError('SKILL_TOOL_DENIED', 'the model requested a tool, which v2.0 never provides');
    }
    if (typeof message.content !== 'string') {
      throw ordinaryError('SKILL_OUTPUT_INVALID', 'the provider message has no string content');
    }
    return parseModelJson(message.content);
  }
  return record;
}

/**
 * @param {unknown} usage
 * @returns {{ inputTokens: number | null, outputTokens: number | null, cachedInputTokens: number | null }}
 */
function normalizeUsage(usage) {
  const pick = (value) => (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : null);
  if (!isPlainObject(usage)) return { inputTokens: null, outputTokens: null, cachedInputTokens: null };
  const record = /** @type {Record<string, unknown>} */ (usage);
  return {
    inputTokens: pick(record.prompt_tokens ?? record.input_tokens),
    outputTokens: pick(record.completion_tokens ?? record.output_tokens),
    cachedInputTokens: pick(record.cached_input_tokens ?? record.prompt_cache_hit_tokens),
  };
}

/**
 * Create a runtime from an already prepared plan.
 *
 * @param {{
 *   planResult: {
 *     plan: Readonly<object>, planSha256: string, prepared: Map<string, Readonly<object>>,
 *     policy: Readonly<object>, modelRegistry: Readonly<object>,
 *   },
 *   transport: { id: string, complete: (request: any) => Promise<any> },
 *   broker: { project: (operation: string, snapshot: unknown) => Readonly<{ dto: unknown }> },
 *   identity: {
 *     deploymentId: string | null, generation: number | null, bindingSha256: string | null,
 *     releaseDescriptorSha256: string | null, slot: string | null, instanceId: string | null,
 *   },
 *   latch?: SkillAdmissionLatch,
 *   clock?: () => number,
 *   uuid?: () => string,
 *   audit?: ((event: Readonly<object>) => void) | null,
 * }} input
 */
export function createSkillRuntime(input) {
  if (input === null || typeof input !== 'object' || !input.planResult || !input.transport) {
    throw new TypeError('createSkillRuntime requires { planResult, transport, broker, identity }');
  }
  const { planResult, transport, broker } = input;
  const latch = input.latch ?? new SkillAdmissionLatch();
  const clock = input.clock ?? (() => Date.now());
  const uuid = input.uuid ?? (() => randomUUID());
  const audit = input.audit ?? null;
  const identity = Object.freeze({
    deploymentId: input.identity?.deploymentId ?? null,
    generation: input.identity?.generation ?? null,
    bindingSha256: input.identity?.bindingSha256 ?? null,
    releaseDescriptorSha256: input.identity?.releaseDescriptorSha256 ?? null,
    slot: input.identity?.slot ?? null,
    instanceId: input.identity?.instanceId ?? null,
  });
  /** @type {Map<string, number>} */
  const inFlight = new Map();

  /**
   * @param {Readonly<object>} event
   */
  function emit(event) {
    if (typeof audit !== 'function') return;
    try {
      audit(Object.freeze(event));
    } catch {
      // Telemetry never delays or changes a refusal (architecture §6.3).
    }
  }

  /**
   * @param {string} operation
   * @param {string} cause
   * @param {string} requestId
   * @param {boolean} [retryable]
   */
  function paused(operation, cause, requestId) {
    return Object.freeze({
      ok: /** @type {false} */ (false),
      operation,
      code: ACTIVATION_PAUSED,
      cause,
      retryable: /** @type {false} */ (false),
      requestId,
    });
  }

  /**
   * Synchronously latch participant admission closed and taint the workflow.
   *
   * @param {SkillError} error structural error
   * @param {SkillWorkflowScope} scope
   * @param {string} operation
   * @param {string} requestId
   */
  function structuralRefusal(error, scope, operation, requestId) {
    latch.close(error.code);
    scope.taint({ structural: true, cause: error.code });
    emit({ event: 'skill.execution.rejected', operation, code: ACTIVATION_PAUSED, cause: error.code, requestId, at: clock() });
    return paused(operation, error.code, requestId);
  }

  /**
   * @param {SkillError} error
   * @param {SkillWorkflowScope} scope
   * @param {string} operation
   * @param {string} requestId
   */
  function ordinaryFailure(error, scope, operation, requestId, { taint }) {
    if (taint) scope.taint({ structural: false, cause: error.code });
    emit({ event: 'skill.execution.rejected', operation, code: error.code, requestId, at: clock() });
    return Object.freeze(toFailureEnvelope(error, { operation, requestId }));
  }

  /**
   * @param {{ taintScope: boolean }} [options]
   * @returns {(error: unknown, scope: SkillWorkflowScope, operation: string, requestId: string) => object}
   */
  function failureHandler(options = { taintScope: true }) {
    return (error, scope, operation, requestId) => {
      if (error instanceof SkillError && error.structural) {
        return structuralRefusal(error, scope, operation, requestId);
      }
      if (error instanceof SkillError) {
        return ordinaryFailure(error, scope, operation, requestId, { taint: options.taintScope !== false });
      }
      // An unclassified throw cannot be trusted: treat it as a provider-boundary
      // failure of this request only.
      return ordinaryFailure(
        ordinaryError('SKILL_PROVIDER_ERROR', 'the skill runtime failed unexpectedly'),
        scope,
        operation,
        requestId,
        { taint: false },
      );
    };
  }

  /**
   * @param {{ operation: string, input: unknown }} request
   * @param {SkillWorkflowScope} scope
   * @returns {Promise<object>}
   */
  async function execute(request, scope) {
    const operation = request?.operation;
    const requestId = uuid();
    if (!AI_OPERATIONS.includes(operation)) {
      throw new TypeError(`unknown skill operation ${JSON.stringify(operation)}`);
    }
    if (!(scope instanceof SkillWorkflowScope)) {
      throw new TypeError('execute requires a SkillWorkflowScope');
    }

    // 1. Admission: local latch, then workflow taint.
    if (latch.isClosed()) {
      return paused(operation, /** @type {string} */ (latch.cause), requestId);
    }
    const taint = scope.taintState;
    if (taint !== null) {
      return taint.structural
        ? paused(operation, taint.cause, requestId)
        : Object.freeze(toFailureEnvelope(ordinaryError(taint.cause, 'the joined workflow is tainted'), { operation, requestId }));
    }

    const prepared = planResult.prepared.get(operation);
    if (!prepared) {
      return structuralRefusal(
        structuralError('SKILL_MISSING', `no prepared package exists for ${operation}`, { operation }),
        scope,
        operation,
        requestId,
      );
    }

    // 2. Concurrency budget.
    const maxConcurrent = /** @type {any} */ (planResult.policy).limits.maxConcurrentByOperation[operation];
    const active = inFlight.get(operation) ?? 0;
    if (active >= maxConcurrent) {
      return ordinaryFailure(
        ordinaryError('SKILL_RESOURCE_EXCEEDED', `the ${operation} concurrency budget is exhausted`, { operation }),
        scope,
        operation,
        requestId,
        { taint: false },
      );
    }
    inFlight.set(operation, active + 1);
    const startedAt = clock();
    try {
      return await executePrepared({ operation, request, scope, requestId, prepared, startedAt });
    } finally {
      inFlight.set(operation, (inFlight.get(operation) ?? 1) - 1);
    }
  }

  /**
   * @param {{
   *   operation: string,
   *   request: any,
   *   scope: SkillWorkflowScope,
   *   requestId: string,
   *   prepared: Readonly<object>,
   *   startedAt: number,
   * }} input
   */
  async function executePrepared(input) {
    const { operation, request, scope, requestId, prepared, startedAt } = input;
    const handleFailure = failureHandler({ taintScope: true });
    const limits = /** @type {any} */ (/** @type {any} */ (prepared).policy).limits;
    /** @type {unknown} */
    let dto;

    // 3. Broker projection + host domain validation (ordinary input failure).
    try {
      const projected = broker.project(operation, request.input);
      dto = projected.dto;
    } catch (error) {
      return handleFailure(error, scope, operation, requestId);
    }

    // 4. Package input schema (ordinary input failure; zero model calls).
    if (!instanceValid(/** @type {any} */ (prepared).inputValidator, dto)) {
      return handleFailure(
        ordinaryError('SKILL_INPUT_INVALID', 'the host snapshot does not satisfy the package input schema', {
          operation,
          field: 'input.schema.json',
        }),
        scope,
        operation,
        requestId,
      );
    }

    // 5. Literal render. A missing pointer is a package fault (structural).
    let messages;
    try {
      messages = renderSkillMessages({
        instructions: /** @type {any} */ (prepared).instructions,
        layout: /** @type {any} */ (prepared).layout,
        input: dto,
      });
    } catch (error) {
      return handleFailure(error, scope, operation, requestId);
    }
    const inputBytes = Buffer.byteLength(messages.user, 'utf8');
    if (inputBytes > limits.maxInputBytes) {
      return handleFailure(
        ordinaryError('SKILL_INPUT_INVALID', 'the rendered input exceeds the package input byte budget', {
          operation,
          field: 'policy.limits.maxInputBytes',
        }),
        scope,
        operation,
        requestId,
      );
    }

    // 6. Re-check admission immediately before transport.
    if (latch.isClosed()) return paused(operation, /** @type {string} */ (latch.cause), requestId);
    if (scope.taintState !== null) {
      const current = scope.taintState;
      return current.structural
        ? paused(operation, current.cause, requestId)
        : Object.freeze(toFailureEnvelope(ordinaryError(current.cause, 'the joined workflow is tainted'), { operation, requestId }));
    }

    const controller = new AbortController();
    const timeoutMs = limits.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    emit({ event: 'skill.execution.started', operation, requestId, at: startedAt });
    let response;
    try {
      response = await transport.complete({
        identity: { .../** @type {any} */ (prepared).identity },
        system: messages.system,
        user: messages.user,
        settings: /** @type {any} */ (prepared).settings,
        signal: controller.signal,
        maxOutputBytes: limits.maxOutputBytes,
      });
    } catch (error) {
      // The runtime owns the deadline, so an aborted call is a timeout even when
      // the injected transport surfaces it as an AbortError.
      if (controller.signal.aborted) {
        return handleFailure(
          ordinaryError('SKILL_TIMEOUT', 'the model call exceeded the reviewed deadline', { operation }),
          scope,
          operation,
          requestId,
        );
      }
      return handleFailure(error, scope, operation, requestId);
    } finally {
      clearTimeout(timer);
    }

    // 7. Re-check admission after the await: a fault discovered elsewhere in the
    // participant (or in this workflow) discards the late response.
    if (latch.isClosed()) return paused(operation, /** @type {string} */ (latch.cause), requestId);
    if (scope.taintState !== null && scope.taintState.structural) {
      return paused(operation, scope.taintState.cause, requestId);
    }

    // 8. Strict parse, schema validation, host domain validation.
    let value;
    try {
      if (typeof response.body === 'string' && Buffer.byteLength(response.body, 'utf8') > limits.maxOutputBytes) {
        throw ordinaryError('SKILL_RESOURCE_EXCEEDED', 'the provider response exceeded the output byte budget', {
          operation,
        });
      }
      const parsed = parseModelJson(response.body);
      if (!instanceValid(/** @type {any} */ (prepared).outputValidator, parsed)) {
        throw ordinaryError('SKILL_OUTPUT_INVALID', 'the model answer does not satisfy the package output schema', {
          operation,
          field: 'output.schema.json',
        });
      }
      value = /** @type {any} */ (prepared).adapter.validateOutput(parsed);
      // Host domain validation with the shaped input always runs, even when the
      // package schema says the answer is valid (architecture §4.4).
      if (typeof /** @type {any} */ (prepared).adapter.validateWithInput === 'function') {
        value = /** @type {any} */ (prepared).adapter.validateWithInput(value, dto);
      }
    } catch (error) {
      return handleFailure(error, scope, operation, requestId);
    }

    const usage = normalizeUsage(response.usage);
    const latencyMs = Number.isFinite(response.latencyMs) ? response.latencyMs : Math.max(0, clock() - startedAt);
    const result = Object.freeze({
      ok: /** @type {true} */ (true),
      operation,
      value,
      usage: Object.freeze({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        estimatedCostUsd: null,
        pricingVersion: null,
        latencyMs,
      }),
      provenance: Object.freeze({
        deploymentId: identity.deploymentId,
        generation: identity.generation,
        bindingSha256: identity.bindingSha256,
        releaseDescriptorSha256: identity.releaseDescriptorSha256,
        operation,
        packageId: /** @type {any} */ (prepared).package.packageId,
        skillVersion: /** @type {any} */ (prepared).package.version,
        packageDigestSha256: /** @type {any} */ (prepared).skill.packageDigestSha256,
        modelRegistrySha256: /** @type {any} */ (planResult.plan).modelRegistrySha256,
        modelIdentitySha256: /** @type {any} */ (prepared).modelIdentitySha256,
        profileSha256: /** @type {any} */ (prepared).identity?.profileDigestSha256 ?? null,
        executionPlanSha256: planResult.planSha256,
        slot: identity.slot,
        instanceId: identity.instanceId,
        requestId,
        inputDigestSha256: digestJson(dto, { label: 'skill input' }),
        outputDigestSha256: digestJson(value, { label: 'skill output' }),
      }),
    });
    TRUSTED_RESULTS.add(result);
    emit({
      event: 'skill.execution.completed',
      operation,
      requestId,
      at: clock(),
      outputDigestSha256: result.provenance.outputDigestSha256,
    });
    return result;
  }

  /**
   * @param {{ operation: string, input: unknown }} request
   * @param {{ workToken: string, requestId?: string }} work
   */
  async function run(request, work) {
    return execute(request, new SkillWorkflowScope(work));
  }

  return Object.freeze({
    execute,
    run,
    admissionState: () => latch.state,
    admissionCause: () => latch.cause,
    closeAdmission: (cause) => latch.close(cause),
    planSha256: planResult.planSha256,
    plan: planResult.plan,
    latch,
  });
}
