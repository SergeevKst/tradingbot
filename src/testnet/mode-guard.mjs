/**
 * Testnet mode guard — the single fail-closed chokepoint for the authenticated
 * layer (MASTER_SPEC Phase 8).
 *
 * Nothing in `src/testnet` may sign or send a request until this guard has
 * approved the context. Approval requires ALL of:
 *   - explicit `testnet === true` (never inferred, never defaulted),
 *   - the testnet REST host,
 *   - a non-empty dedicated testnet credential pair.
 *
 * Production is refused rather than merely unsupported: the guard returns a
 * rejection reason code for every failure so callers can branch on it, and
 * `assertTestnetMode` turns a rejection into a startup error.
 *
 * @module testnet/mode-guard
 */
import { ConfigurationError } from '../errors/taxonomy.mjs';
import { TESTNET_REST_BASE_URL } from './endpoints.mjs';

/** Machine-readable guard outcomes. */
export const TESTNET_GUARD = Object.freeze({
  ALLOWED: 'TESTNET_ALLOWED',
  NOT_TESTNET_MODE: 'NOT_TESTNET_MODE',
  PRODUCTION_URL_REFUSED: 'PRODUCTION_URL_REFUSED',
  MISSING_CREDENTIALS: 'MISSING_TESTNET_CREDENTIALS',
});

/**
 * @typedef {object} TestnetModeContext
 * @property {boolean} [testnet] explicit testnet opt-in
 * @property {string} [restBaseUrl] REST host
 * @property {string} [apiKey] dedicated testnet key
 * @property {string} [apiSecret] dedicated testnet secret
 */

/**
 * Decide whether authenticated testnet I/O may proceed. Pure.
 *
 * @param {TestnetModeContext} [context]
 * @returns {Readonly<{ allowed: boolean, code: string, message: string }>}
 */
export function checkTestnetMode(context = {}) {
  if (context.testnet !== true) {
    return Object.freeze({
      allowed: false,
      code: TESTNET_GUARD.NOT_TESTNET_MODE,
      message: 'Authenticated exchange access requires an explicit testnet=true; it is never inferred',
    });
  }

  const baseUrl = typeof context.restBaseUrl === 'string' ? context.restBaseUrl.trim().replace(/\/+$/, '') : '';
  if (baseUrl !== TESTNET_REST_BASE_URL) {
    return Object.freeze({
      allowed: false,
      code: TESTNET_GUARD.PRODUCTION_URL_REFUSED,
      message: `Testnet mode refuses any host other than ${TESTNET_REST_BASE_URL}`,
    });
  }

  if (typeof context.apiKey !== 'string' || context.apiKey.trim() === '') {
    return Object.freeze({
      allowed: false,
      code: TESTNET_GUARD.MISSING_CREDENTIALS,
      message: 'Dedicated testnet credentials are required; production credentials are never used',
    });
  }
  if (typeof context.apiSecret !== 'string' || context.apiSecret.trim() === '') {
    return Object.freeze({
      allowed: false,
      code: TESTNET_GUARD.MISSING_CREDENTIALS,
      message: 'Dedicated testnet credentials are required; production credentials are never used',
    });
  }

  return Object.freeze({ allowed: true, code: TESTNET_GUARD.ALLOWED, message: 'Authenticated testnet access permitted' });
}

/**
 * Throw unless the context passes the testnet guard.
 *
 * @param {TestnetModeContext} [context]
 * @throws {ConfigurationError}
 */
export function assertTestnetMode(context = {}) {
  const decision = checkTestnetMode(context);
  if (!decision.allowed) {
    throw new ConfigurationError(`Testnet guard refused access (${decision.code}): ${decision.message}`, {
      details: { field: 'testnet', code: decision.code },
    });
  }
}
