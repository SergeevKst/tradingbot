/**
 * Host operation-adapter catalogue (architecture v1.1 §6.2).
 *
 * The catalogue is code-owned and hash-pinned into the artifact identity. A
 * package may narrow a contract but never broaden host authority: the planner
 * requires the package's declared contract ids/versions to equal the catalogue
 * entry, and the runtime always runs the host adapter checks in addition to the
 * package schema.
 *
 * @module ai/skills/adapters/catalogue
 */
import { digestJson } from '../../../config/jcs.mjs';
import { AI_OPERATIONS } from '../../operation-profiles.mjs';
import { analyzeAdapter } from './analyze.mjs';
import { guardAdapter } from './guard.mjs';
import { monitorAdapter } from './monitor.mjs';
import { reflectAdapter } from './reflect.mjs';
import { scoutAdapter } from './scout.mjs';
import { stopcheckAdapter } from './stopcheck.mjs';

/** The six adapters, keyed by operation. */
export const ADAPTERS = Object.freeze({
  ANALYZE: analyzeAdapter,
  SCOUT: scoutAdapter,
  GUARD: guardAdapter,
  MONITOR: monitorAdapter,
  STOPCHECK: stopcheckAdapter,
  REFLECT: reflectAdapter,
});

/**
 * Canonical, digestible description of the adapter catalogue.
 *
 * @returns {Readonly<object>}
 */
export function describeAdapterCatalogue() {
  return Object.freeze({
    schemaVersion: 1,
    adapters: Object.freeze(
      AI_OPERATIONS.map((operation) => {
        const adapter = ADAPTERS[operation];
        return Object.freeze({
          operation,
          adapterId: adapter.adapterId,
          adapterContractVersion: adapter.adapterContractVersion,
          inputContract: adapter.inputContract,
          outputContract: adapter.outputContract,
          dataSources: adapter.dataSources,
        });
      }),
    ),
  });
}

/**
 * Canonical description of the host input/output contracts (code-owned).
 *
 * @returns {Readonly<object>}
 */
export function describeHostContractCatalogue() {
  return Object.freeze({
    schemaVersion: 1,
    contracts: Object.freeze(
      AI_OPERATIONS.map((operation) => {
        const adapter = ADAPTERS[operation];
        return Object.freeze({
          operation,
          input: adapter.inputContract,
          output: adapter.outputContract,
        });
      }),
    ),
  });
}

/** Digest committed by ArtifactIdentity.adapterCatalogueSha256. */
export const ADAPTER_CATALOGUE_SHA256 = digestJson(describeAdapterCatalogue(), { label: 'adapter catalogue' });

/** Digest committed by ArtifactIdentity.hostContractCatalogueSha256. */
export const HOST_CONTRACT_CATALOGUE_SHA256 = digestJson(describeHostContractCatalogue(), {
  label: 'host contract catalogue',
});

/**
 * @param {string} operation
 * @returns {typeof ADAPTERS[keyof typeof ADAPTERS]}
 */
export function adapterFor(operation) {
  const adapter = ADAPTERS[operation];
  if (!adapter) {
    throw new TypeError(`no host adapter for operation ${JSON.stringify(operation)}`);
  }
  return adapter;
}
