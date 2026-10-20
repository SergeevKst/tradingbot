/**
 * Live credential separation (MASTER_SPEC Phase 10).
 *
 * Three credential domains exist in this project: dedicated live keys, the
 * dedicated testnet pair, and the operational pair used by standalone scripts.
 *
 * A live run must use its own pair and nothing else. Sharing a key between the
 * live and testnet domains means a testnet mistake can reach production, and a
 * `TESTNET_ENABLED=true` flag in a live configuration means the run is confused
 * about which exchange it is talking to. Both are refused here.
 *
 * The check is pure and value-based: it never reads the environment and never
 * logs, stores or returns credential material. Only the boolean outcome and a
 * reason code leave this module.
 *
 * @module safety/credential-separation
 */
import { ConfigError } from '../config/config-error.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';

/** Machine-readable separation outcomes. */
export const CREDENTIAL_SEPARATION = Object.freeze({
  SEPARATED: 'CREDENTIALS_SEPARATED',
  MISSING_LIVE_CREDENTIALS: 'MISSING_LIVE_CREDENTIALS',
  TESTNET_ENABLED_IN_LIVE: 'TESTNET_ENABLED_IN_LIVE',
  SHARED_CREDENTIALS: 'SHARED_CREDENTIALS',
});

/** The trimmed string, or null when the value is absent/empty/non-string. */
function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * @typedef {object} CredentialSeparationInput
 * @property {{ apiKey?: unknown, apiSecret?: unknown }} [live] live credentials
 * @property {{ apiKey?: unknown, apiSecret?: unknown } | null} [testnet] testnet credentials, if any
 * @property {boolean} [testnetEnabled] testnet mode flag
 */

/**
 * Decide whether the live credential domain is properly separated. Pure.
 *
 * @param {CredentialSeparationInput} [input]
 * @returns {Readonly<{ separated: boolean, code: string, message: string }>}
 */
export function checkCredentialSeparation(input = {}) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const liveKey = asNonEmptyString(source.live?.apiKey);
  const liveSecret = asNonEmptyString(source.live?.apiSecret);

  if (liveKey === null || liveSecret === null) {
    return Object.freeze({
      separated: false,
      code: CREDENTIAL_SEPARATION.MISSING_LIVE_CREDENTIALS,
      message: 'Live requires dedicated, non-empty live credentials; nothing is inferred or reused',
    });
  }

  if (source.testnetEnabled === true) {
    return Object.freeze({
      separated: false,
      code: CREDENTIAL_SEPARATION.TESTNET_ENABLED_IN_LIVE,
      message: 'A live configuration must not have testnet mode enabled',
    });
  }

  const testnetKey = asNonEmptyString(source.testnet?.apiKey);
  const testnetSecret = asNonEmptyString(source.testnet?.apiSecret);
  if ((testnetKey !== null && testnetKey === liveKey) || (testnetSecret !== null && testnetSecret === liveSecret)) {
    return Object.freeze({
      separated: false,
      code: CREDENTIAL_SEPARATION.SHARED_CREDENTIALS,
      message: 'Live and testnet credentials must be distinct: no testnet key may be used for live',
    });
  }

  return Object.freeze({
    separated: true,
    code: CREDENTIAL_SEPARATION.SEPARATED,
    message: 'Live credentials are dedicated and separated from the testnet domain',
  });
}

/**
 * Throw unless the live credential domain is properly separated.
 *
 * @param {CredentialSeparationInput} [input]
 * @returns {Readonly<{ separated: boolean, code: string, message: string }>}
 * @throws {ConfigError}
 */
export function assertCredentialSeparation(input = {}) {
  const decision = checkCredentialSeparation(input);
  if (!decision.separated) {
    throw new ConfigError(`Live credential separation refused (${decision.code}): ${decision.message}`, {
      field: 'live_credentials',
      value: decision.code,
    });
  }
  return decision;
}

/** The reason code the gate uses when separation fails. */
export const SEPARATION_REASON_CODE = REASON_CODE.LIVE_CREDENTIAL_SEPARATION_FAILED;
