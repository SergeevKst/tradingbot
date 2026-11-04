/**
 * Reviewed runtime-policy construction helpers (architecture v1.1 §6).
 *
 * The defaults below are the v2 engineering ceilings. They are deliberately
 * conservative and, like every other policy input, are hashed into the release
 * binding. A deployment may tighten them; nothing here can be raised by a
 * package.
 *
 * @module ai/skills/runtime-policy
 */
import { AI_OPERATIONS } from '../operation-profiles.mjs';
import { DATA_SOURCE_CATALOGUE } from '../../config/skill-package.mjs';

/** Default host ceilings for a v2 release. */
export const DEFAULT_RUNTIME_LIMITS = Object.freeze({
  maxInputBytes: 256 * 1024,
  maxOutputBytes: 64 * 1024,
  maxOutputTokens: 4096,
  timeoutMs: 600_000,
  maxModelCalls: 1,
  maxToolCalls: 0,
});

/**
 * @param {{
 *   capabilityEvidence: Record<string, unknown>,
 *   trustRootsSha256: string,
 *   limits?: Partial<typeof DEFAULT_RUNTIME_LIMITS>,
 *   grants?: Record<string, readonly string[]>,
 *   maxConcurrentByOperation?: Record<string, number>,
 * }} input
 * @returns {Readonly<object>}
 */
export function createRuntimePolicy(input) {
  /** @type {Record<string, Readonly<{ dataSources: readonly string[], allowedTools: readonly string[] }>>} */
  const operationGrants = {};
  for (const operation of AI_OPERATIONS) {
    const granted = input.grants?.[operation] ?? DATA_SOURCE_CATALOGUE[operation];
    for (const capability of granted) {
      if (!DATA_SOURCE_CATALOGUE[operation].includes(capability)) {
        throw new TypeError(`grants.${operation} offers an unknown capability ${JSON.stringify(capability)}`);
      }
    }
    operationGrants[operation] = Object.freeze({
      dataSources: Object.freeze([...granted]),
      allowedTools: Object.freeze([]),
    });
  }
  /** @type {Record<string, number>} */
  const maxConcurrentByOperation = {};
  for (const operation of AI_OPERATIONS) {
    maxConcurrentByOperation[operation] = input.maxConcurrentByOperation?.[operation] ?? 4;
  }
  return Object.freeze({
    schemaVersion: 1,
    operationGrants: Object.freeze(operationGrants),
    limits: Object.freeze({
      ...DEFAULT_RUNTIME_LIMITS,
      ...(input.limits ?? {}),
      maxConcurrentByOperation: Object.freeze(maxConcurrentByOperation),
    }),
    capabilityEvidence: Object.freeze({ ...input.capabilityEvidence }),
    trustRootsSha256: input.trustRootsSha256,
  });
}
