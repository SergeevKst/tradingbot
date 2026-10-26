/**
 * Immutable per-generation AI runtime (UAI-05C, architecture §5).
 *
 * A runtime is constructed only from a validated binding + manifest + profile
 * and is frozen for that generation. It owns the *whole-work* accounting around
 * one operation:
 *
 *   beginWork  (synchronous counter increment, admission check, control read)
 *   check      (control read before inference)
 *   invoke     (transport; provider/model/endpoint come from the manifest)
 *   check      (control read after the response, before any caller can act)
 *   endWork    (final release)
 *
 * Public AI outcome schemas are unchanged. Provenance lives in a separate,
 * frozen sidecar so a caller can prove which generation produced a result
 * without a payload change (and cannot forge it from model text).
 *
 * @module ai/runtime
 */
import { COORDINATION_ERROR_CODE, CoordinationError } from '../errors/coordination-error.mjs';

/**
 * @param {{
 *   binding: Readonly<object>,
 *   generation: number,
 *   deploymentId: string,
 *   slot: string,
 *   instanceId: string,
 *   manifest: Readonly<object>,
 *   profile: Readonly<object>,
 *   operations: readonly string[],
 *   guard: { beginWork: Function, check: Function, endWork: Function },
 *   invoke: (input: { operation: string, request: unknown, manifest: Readonly<object>, profile: Readonly<object>, binding: Readonly<object>, generation: number }) => Promise<unknown>,
 *   clock?: () => number,
 * }} options
 * @returns {Readonly<object>}
 */
export function createGenerationRuntime(options) {
  if (options === null || typeof options !== 'object') {
    throw new CoordinationError('createGenerationRuntime requires an options object', {
      code: COORDINATION_ERROR_CODE.INTERNAL_ERROR,
    });
  }
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  /** @type {Readonly<object>} */
  const provenance = Object.freeze({
    deploymentId: options.deploymentId,
    generation: options.generation,
    manifestVersion: options.binding.manifestVersion,
    manifestSha256: options.binding.manifestSha256,
    capabilityProfileSha256: options.binding.capabilityProfileSha256,
    slot: options.slot,
    instanceId: options.instanceId,
  });

  /**
   * @param {string} operation
   * @param {unknown} request
   * @param {{ workToken?: any }} [opts] an outer workflow token that owns the
   *   admission and drain accounting for the whole workflow
   * @returns {Promise<{ result: unknown, provenance: Readonly<object> }>}
   */
  async function complete(operation, request, opts = {}) {
    const externalToken = opts.workToken ?? null;
    const token = externalToken ?? options.guard.beginWork(operation);
    try {
      options.guard.check(token);
      const result = await options.invoke({
        operation,
        request,
        manifest: options.manifest,
        profile: options.profile,
        binding: options.binding,
        generation: options.generation,
      });
      // A retired generation must not hand a usable result to a caller: the
      // response is discarded, not returned with a warning.
      options.guard.check(token);
      return Object.freeze({ result, provenance });
    } finally {
      if (externalToken === null) options.guard.endWork(token);
    }
  }

  return Object.freeze({
    binding: options.binding,
    generation: options.generation,
    manifest: options.manifest,
    profile: options.profile,
    operations: options.operations,
    provenance,
    complete,
    /** Stable, non-secret fingerprint of this runtime. */
    fingerprint: Object.freeze({
      manifestVersion: options.binding.manifestVersion,
      manifestSha256: options.binding.manifestSha256,
      capabilityProfileSha256: options.binding.capabilityProfileSha256,
      inventorySha256: options.binding.inventorySha256,
      artifactSetSha256: options.binding.artifactSetSha256,
      generation: options.generation,
    }),
    createdAt: clock(),
  });
}

/**
 * Convert a coordination failure into the metadata shape a caller can log or
 * attach to a status report without leaking a provider body or secret.
 *
 * @param {unknown} error
 * @returns {Readonly<{ code: string, retryable: false }>}
 */
export function coordinationFailureMetadata(error) {
  return Object.freeze({
    code: error instanceof CoordinationError ? error.code : COORDINATION_ERROR_CODE.INTERNAL_ERROR,
    retryable: false,
  });
}
