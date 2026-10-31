/**
 * Skill error taxonomy for the data-only Skill runtime (architecture v1.1 §6.3).
 *
 * Two disjoint families exist and must never be conflated:
 *
 *   - STRUCTURAL causes are package/release identity faults. Detected before any
 *     provider request they latch participant admission closed and every public
 *     operation boundary answers `ACTIVATION_PAUSED` with the cause kept in
 *     safe diagnostic metadata only.
 *   - ORDINARY codes are per-request input/output/transport failures. They fail
 *     and taint their own joined workflow; they never latch a healthy
 *     participant and they never rewrite durable control state.
 *
 * Neither family carries raw model output, prompts, market data or credentials.
 * `retryable` is always false: nothing in this taxonomy is a transient retry
 * instruction (v2.0 has no automatic retry, fallback or repair prompt).
 *
 * @module errors/skill-error
 */

/** Public operation-boundary code for every structural package fault. */
export const ACTIVATION_PAUSED = 'ACTIVATION_PAUSED';

/** Closed set of structural causes (architecture §6.3). Diagnostic only. */
export const STRUCTURAL_SKILL_CAUSES = Object.freeze([
  'SKILL_MISSING',
  'SKILL_REGISTRY_INVALID',
  'SKILL_INTEGRITY_MISMATCH',
  'SKILL_NOT_APPROVED',
  'SKILL_REVOKED',
  'SKILL_INCOMPATIBLE',
  'SKILL_DEPENDENCY_UNSUPPORTED',
  'SKILL_EXECUTABLE_FORBIDDEN',
  'SKILL_SCHEMA_INVALID',
  'SKILL_RENDER_INVALID',
  'SKILL_CAPABILITY_MISMATCH',
  'SKILL_POLICY_DENIED',
]);

/** Closed set of ordinary per-request failure codes (architecture §6.3). */
export const ORDINARY_SKILL_CODES = Object.freeze([
  'SKILL_INPUT_INVALID',
  'SKILL_DATA_STALE',
  'SKILL_OUTPUT_INVALID',
  'SKILL_TOOL_DENIED',
  'SKILL_RESOURCE_EXCEEDED',
  'SKILL_TIMEOUT',
  'SKILL_PROVIDER_ERROR',
]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStructuralCause(value) {
  return typeof value === 'string' && STRUCTURAL_SKILL_CAUSES.includes(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isOrdinarySkillCode(value) {
  return typeof value === 'string' && ORDINARY_SKILL_CODES.includes(value);
}

/**
 * Internal skill fault. `code` is either a structural cause or an ordinary
 * skill code; `field`/`operation` are safe identifiers, never payload text.
 */
export class SkillError extends Error {
  /**
   * @param {string} code
   * @param {string} message safe, non-payload description
   * @param {{ field?: string | null, operation?: string | null, structural?: boolean }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'SkillError';
    if (!isStructuralCause(code) && !isOrdinarySkillCode(code)) {
      throw new TypeError(`unknown skill error code ${JSON.stringify(code)}`);
    }
    this.code = code;
    this.structural = options.structural ?? isStructuralCause(code);
    this.field = options.field ?? null;
    this.operation = options.operation ?? null;
    /** v2.0 never retries an AI call. */
    this.retryable = false;
  }
}

/**
 * Convenience constructor for a structural fault.
 *
 * @param {string} cause one of STRUCTURAL_SKILL_CAUSES
 * @param {string} message
 * @param {{ field?: string | null, operation?: string | null }} [options]
 * @returns {SkillError}
 */
export function structuralError(cause, message, options = {}) {
  return new SkillError(cause, message, { ...options, structural: true });
}

/**
 * Convenience constructor for an ordinary per-request failure.
 *
 * @param {string} code one of ORDINARY_SKILL_CODES
 * @param {string} message
 * @param {{ field?: string | null, operation?: string | null }} [options]
 * @returns {SkillError}
 */
export function ordinaryError(code, message, options = {}) {
  return new SkillError(code, message, { ...options, structural: false });
}

/**
 * Map any thrown error to a safe public failure envelope. Unknown errors become
 * an ordinary `SKILL_PROVIDER_ERROR` because the transport boundary is the only
 * place that can raise an unclassified error, and refusing is always safe.
 *
 * @param {unknown} error
 * @param {{ operation: string, requestId: string }} context
 * @returns {{ ok: false, operation: string, code: string, cause?: string, retryable: false, requestId: string }}
 */
export function toFailureEnvelope(error, context) {
  if (error instanceof SkillError) {
    if (error.structural) {
      return {
        ok: false,
        operation: context.operation,
        code: ACTIVATION_PAUSED,
        cause: error.code,
        retryable: false,
        requestId: context.requestId,
      };
    }
    return {
      ok: false,
      operation: context.operation,
      code: error.code,
      retryable: false,
      requestId: context.requestId,
    };
  }
  return {
    ok: false,
    operation: context.operation,
    code: 'SKILL_PROVIDER_ERROR',
    retryable: false,
    requestId: context.requestId,
  };
}
