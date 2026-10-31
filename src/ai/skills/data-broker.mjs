/**
 * Data capability broker (architecture v1.1 §4.3, §8.1).
 *
 * The broker is the only path from trusted host snapshots to model input. It
 * checks that the package's declared capabilities are granted by the host
 * policy, delegates field projection to the code-owned operation adapter, and
 * enforces the snapshot freshness budget. It never performs a network, file or
 * tool call on a package's behalf.
 *
 * @module ai/skills/data-broker
 */
import { structuralError, ordinaryError } from '../../errors/skill-error.mjs';

/** Default freshness budget used when the host does not configure one. */
export const DEFAULT_SNAPSHOT_FRESHNESS_MS = 120_000;

/**
 * @param {{
 *   adapters: Record<string, any>,
 *   grants: Record<string, { dataSources: readonly string[] }>,
 *   freshnessMs?: number,
 *   clock?: () => number,
 * }} input
 */
export function createDataBroker(input) {
  const freshnessMs = input.freshnessMs ?? DEFAULT_SNAPSHOT_FRESHNESS_MS;
  const clock = input.clock ?? (() => Date.now());

  /**
   * @param {string} operation
   * @param {unknown} snapshot trusted host snapshot (optionally `{ asOf, data }`)
   * @returns {Readonly<{ dto: unknown, capabilities: readonly string[] }>}
   */
  function project(operation, snapshot) {
    const adapter = input.adapters[operation];
    if (!adapter) {
      throw structuralError('SKILL_INCOMPATIBLE', `no host adapter is registered for ${operation}`, { operation });
    }
    const grant = input.grants[operation];
    if (!grant) {
      throw structuralError('SKILL_POLICY_DENIED', `the runtime policy grants no capabilities for ${operation}`, {
        operation,
      });
    }
    for (const capability of adapter.dataSources) {
      if (!grant.dataSources.includes(capability)) {
        throw structuralError('SKILL_POLICY_DENIED', `host policy does not grant ${capability} to ${operation}`, {
          field: 'policy.operationGrants',
        });
      }
    }
    if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') {
      throw ordinaryError('SKILL_INPUT_INVALID', `no host snapshot was supplied for ${operation}`, {
        operation,
        field: 'snapshot',
      });
    }
    const envelope = /** @type {Record<string, unknown>} */ (snapshot);
    const hasEnvelope = 'data' in envelope || 'asOf' in envelope;
    const data = hasEnvelope ? envelope.data : snapshot;
    if (hasEnvelope && 'asOf' in envelope) {
      const asOf = envelope.asOf;
      if (typeof asOf !== 'number' || !Number.isFinite(asOf)) {
        throw ordinaryError('SKILL_INPUT_INVALID', 'snapshot.asOf must be a finite epoch-millisecond value', {
          operation,
          field: 'snapshot.asOf',
        });
      }
      const age = clock() - asOf;
      if (age > freshnessMs) {
        throw ordinaryError('SKILL_DATA_STALE', 'the host snapshot is older than the freshness budget', {
          operation,
          field: 'snapshot.asOf',
        });
      }
      if (age < -freshnessMs) {
        throw ordinaryError('SKILL_INPUT_INVALID', 'the host snapshot is dated in the future', {
          operation,
          field: 'snapshot.asOf',
        });
      }
    }
    return Object.freeze({ dto: adapter.shape(data), capabilities: adapter.dataSources });
  }

  return Object.freeze({ project, freshnessMs });
}

/** @typedef {ReturnType<typeof createDataBroker>} DataBroker */
