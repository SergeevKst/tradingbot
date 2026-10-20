/**
 * The live-trading gate (MASTER_SPEC Phase 10, §46).
 *
 * `evaluateLiveReadiness` is the single, deterministic, fail-closed decision
 * point for live activation. It combines three independent kinds of evidence:
 *
 *   1. the explicit configuration flag (`LIVE_ENABLED=true`, with
 *      `TRADING_MODE=LIVE`) — read from config, never from the caller's claims;
 *   2. the thirteen §46 attestations (tests, backtest, paper, testnet,
 *      reconciliation, recovery, duplicate protection, risk, kill switch,
 *      logging, secrets, credentials) — each must be an explicit `true`;
 *   3. runtime objects the gate can inspect directly: a valid risk limit set,
 *      a functional emergency stop, a usable append-only audit journal, and
 *      credentials that are properly separated from the testnet domain.
 *
 * There is no bypass and no default. A missing or malformed input is a refusal,
 * never an approval. The result is a plain frozen value, so it can be logged
 * and asserted without touching the exchange.
 *
 * `assertLiveReady` turns a refusal into a `ConfigError`. It is this build's
 * final safety: even when every check passes, there is still no live execution
 * path, so the gate grants readiness — not trading.
 *
 * @module safety/live-gate
 */
import { ConfigError } from '../config/config-error.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';
import { validateRiskLimits } from '../config/risk.mjs';
import { assertKillSwitch, isKillSwitchEngaged } from '../risk/kill-switch.mjs';
import { checkCredentialSeparation } from './credential-separation.mjs';
import { LIVE_ATTESTATION_CHECKS, LIVE_FLAG_CHECK, evaluateChecklist } from './checklist.mjs';

/**
 * @typedef {object} LiveGateFailure
 * @property {string} id checklist or runtime check id
 * @property {string} code machine-readable reason code
 * @property {string} message human-readable explanation
 */

/**
 * @typedef {object} LiveReadinessInput
 * @property {{ enabled?: boolean, mode?: string }} [config] resolved live config
 * @property {Record<string, unknown>} [evidence] the thirteen §46 attestations
 * @property {{ live?: object, testnet?: object | null, testnetEnabled?: boolean }} [credentials]
 * @property {import('../config/risk.mjs').RiskLimits} [riskConfig]
 * @property {unknown} [killSwitch] operational emergency stop
 * @property {{ record: Function }} [journal] append-only audit sink
 */

/** @returns {LiveGateFailure} */
function failure(id, code, message) {
  return { id, code, message };
}

/** True when a value looks like an append-only journal writer. */
function isJournalLike(value) {
  return value !== null && typeof value === 'object' && typeof (/** @type {any} */ (value).record) === 'function';
}

/** True when a value is a plain object (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Evaluate live readiness. Pure, deterministic and fail-closed.
 *
 * @param {LiveReadinessInput} [input]
 * @returns {Readonly<{
 *   allowed: boolean,
 *   reasonCode: string,
 *   mode: string,
 *   failures: readonly LiveGateFailure[],
 *   checklist: readonly { id: string, label: string, satisfied: boolean, source: string }[],
 *   credentialSeparation: { separated: boolean, code: string, message: string },
 *   message: string,
 * }>}
 */
export function evaluateLiveReadiness(input = {}) {
  const source = isPlainObject(input) ? input : {};
  /** @type {LiveGateFailure[]} */
  const failures = [];

  // 1. The explicit activation flag. Derived from config, never from evidence.
  const flagEnabled = source.config?.enabled === true;
  if (!flagEnabled) {
    failures.push(
      failure(
        LIVE_FLAG_CHECK.id,
        REASON_CODE.LIVE_FLAG_NOT_ENABLED,
        'LIVE_ENABLED must be explicitly true (with TRADING_MODE=LIVE); it is never inferred',
      ),
    );
  }

  // 2. The thirteen attestable §46 conditions.
  const evidence = evaluateChecklist(source.evidence);
  for (const item of evidence.failed) {
    failures.push(failure(item.id, REASON_CODE.LIVE_CHECKLIST_INCOMPLETE, item.message));
  }

  // 3. Credential separation — no testnet keys in live.
  const credentialSeparation = checkCredentialSeparation(source.credentials ?? {});
  if (!credentialSeparation.separated) {
    failures.push(
      failure('production_credentials', REASON_CODE.LIVE_CREDENTIAL_SEPARATION_FAILED, credentialSeparation.message),
    );
  }

  // 4. Risk limits must validate. The Risk Engine is the only sizing gate, so a
  // malformed limit set can never reach live.
  let riskValid = false;
  try {
    validateRiskLimits(source.riskConfig);
    riskValid = true;
  } catch (error) {
    failures.push(
      failure('risk_limits', REASON_CODE.LIVE_RISK_CONFIG_INVALID, error instanceof Error ? error.message : String(error)),
    );
  }

  // 5. The static config kill switch must be explicitly released.
  if (riskValid && isKillSwitchEngaged(source.riskConfig)) {
    failures.push(
      failure('kill_switch', REASON_CODE.LIVE_KILL_SWITCH_ENGAGED, 'The config kill switch is engaged'),
    );
  }

  // 6. The operational emergency stop must exist and be functional.
  let killSwitch = null;
  try {
    killSwitch = assertKillSwitch(source.killSwitch);
  } catch (error) {
    failures.push(
      failure('kill_switch', REASON_CODE.LIVE_KILL_SWITCH_INVALID, error instanceof Error ? error.message : String(error)),
    );
  }
  if (killSwitch !== null && killSwitch.isEngaged() === true) {
    failures.push(
      failure('kill_switch', REASON_CODE.LIVE_KILL_SWITCH_ENGAGED, 'The runtime emergency stop is engaged'),
    );
  }

  // 7. Live must be auditable: without an append-only journal there is no record.
  if (!isJournalLike(source.journal)) {
    failures.push(
      failure('logging', REASON_CODE.LIVE_AUDIT_UNAVAILABLE, 'A usable append-only audit journal is required for live'),
    );
  }

  const allowed = failures.length === 0;

  // A complete, reviewable §46 view for the audit trail and the report.
  const checklist = Object.freeze([
    ...LIVE_ATTESTATION_CHECKS.map((check) => ({
      id: check.id,
      label: check.label,
      satisfied: evidence.satisfied.includes(check.id),
      source: 'attestation',
    })),
    { id: LIVE_FLAG_CHECK.id, label: LIVE_FLAG_CHECK.label, satisfied: flagEnabled, source: 'config' },
  ]);

  return Object.freeze({
    allowed,
    reasonCode: allowed ? REASON_CODE.APPROVED : REASON_CODE.LIVE_GATE_REFUSED,
    mode: source.config?.mode ?? 'LIVE',
    failures: Object.freeze(failures),
    checklist,
    credentialSeparation,
    message: allowed
      ? 'All §46 conditions are satisfied; live readiness granted (live execution remains unavailable in this build)'
      : `Live activation refused: ${failures.length} condition(s) not satisfied`,
  });
}

/**
 * Assert live readiness, failing closed.
 *
 * @param {LiveReadinessInput} [input]
 * @returns {ReturnType<typeof evaluateLiveReadiness>}
 * @throws {ConfigError} when any §46 condition or runtime safety check fails
 */
export function assertLiveReady(input = {}) {
  const decision = evaluateLiveReadiness(input);
  if (!decision.allowed) {
    const codes = decision.failures.map((item) => item.code).join(', ');
    throw new ConfigError(`Live gate refused activation (${codes}): ${decision.message}`, {
      field: 'LIVE_ENABLED',
      value: decision.failures.map((item) => item.id),
    });
  }
  return decision;
}
