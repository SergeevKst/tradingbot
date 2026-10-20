/**
 * The §46 live-trading checklist (MASTER_SPEC Phase 10).
 *
 * The spec lists fourteen conditions that must hold before live trading may be
 * enabled. Thirteen of them describe something that was *verified* (tests pass,
 * backtest works, secrets verified, …); those are supplied as explicit
 * attestations. The fourteenth — "LIVE flag explicitly enabled" — is not an
 * attestation at all: it is read directly from configuration by the gate, so it
 * can never be satisfied by a caller simply claiming it.
 *
 * Evaluation FAILS CLOSED. A condition counts as satisfied only when its
 * attestation is the boolean `true`. Missing, `false`, `"yes"`, `1`, `null` and
 * every other value are failures — there is no coercion and no default.
 *
 * @module safety/checklist
 */

/**
 * Stable identifiers for the thirteen attestable checklist conditions.
 * @readonly
 */
export const LIVE_CHECK = Object.freeze({
  UNIT_TESTS: 'unit_tests',
  INTEGRATION_TESTS: 'integration_tests',
  BACKTEST: 'backtest',
  PAPER: 'paper_trading',
  TESTNET: 'testnet',
  RECONCILIATION: 'reconciliation',
  RESTART_RECOVERY: 'restart_recovery',
  DUPLICATE_ORDER_PROTECTION: 'duplicate_order_protection',
  RISK_LIMITS: 'risk_limits',
  KILL_SWITCH: 'kill_switch',
  LOGGING: 'logging',
  SECRETS: 'secrets',
  PRODUCTION_CREDENTIALS: 'production_credentials',
});

/**
 * @typedef {object} ChecklistItem
 * @property {string} id stable identifier
 * @property {string} label human-readable §46 line
 * @property {boolean} attestable true when the item is supplied as evidence
 */

/** The thirteen conditions an operator/CI must attest, in §46 order. */
export const LIVE_ATTESTATION_CHECKS = Object.freeze([
  { id: LIVE_CHECK.UNIT_TESTS, label: 'unit tests pass', attestable: true },
  { id: LIVE_CHECK.INTEGRATION_TESTS, label: 'integration tests pass', attestable: true },
  { id: LIVE_CHECK.BACKTEST, label: 'backtest works', attestable: true },
  { id: LIVE_CHECK.PAPER, label: 'paper trading works', attestable: true },
  { id: LIVE_CHECK.TESTNET, label: 'testnet works', attestable: true },
  { id: LIVE_CHECK.RECONCILIATION, label: 'reconciliation works', attestable: true },
  { id: LIVE_CHECK.RESTART_RECOVERY, label: 'restart recovery tested', attestable: true },
  { id: LIVE_CHECK.DUPLICATE_ORDER_PROTECTION, label: 'duplicate order protection tested', attestable: true },
  { id: LIVE_CHECK.RISK_LIMITS, label: 'risk limits tested', attestable: true },
  { id: LIVE_CHECK.KILL_SWITCH, label: 'kill switch tested', attestable: true },
  { id: LIVE_CHECK.LOGGING, label: 'logging verified', attestable: true },
  { id: LIVE_CHECK.SECRETS, label: 'secrets verified', attestable: true },
  { id: LIVE_CHECK.PRODUCTION_CREDENTIALS, label: 'production credentials verified', attestable: true },
]);

/** The fourteenth §46 line. Derived from configuration, never from evidence. */
export const LIVE_FLAG_CHECK = Object.freeze({
  id: 'live_flag',
  label: 'LIVE flag explicitly enabled',
  attestable: false,
});

/** All fourteen checklist lines, in §46 order. */
export const LIVE_CHECKLIST = Object.freeze([...LIVE_ATTESTATION_CHECKS, LIVE_FLAG_CHECK]);

/** True when `value` is a plain object (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Evaluate the thirteen attestable checklist conditions.
 *
 * Deterministic and side-effect free: the same evidence always yields the same
 * result. Only an explicit `true` satisfies a condition.
 *
 * @param {Record<string, unknown>} [evidence]
 * @returns {Readonly<{
 *   passed: boolean,
 *   satisfied: readonly string[],
 *   failed: readonly { id: string, label: string, code: string, message: string }[],
 *   missing: readonly string[],
 *   unexpected: readonly string[],
 * }>}
 */
export function evaluateChecklist(evidence) {
  const source = isPlainObject(evidence) ? evidence : {};

  /** @type {string[]} */
  const satisfied = [];
  /** @type {{ id: string, label: string, code: string, message: string }[]} */
  const failed = [];
  /** @type {string[]} */
  const missing = [];

  for (const check of LIVE_ATTESTATION_CHECKS) {
    const value = source[check.id];
    if (!(check.id in source)) {
      missing.push(check.id);
      failed.push({
        id: check.id,
        label: check.label,
        code: 'LIVE_CHECKLIST_MISSING',
        message: `No evidence recorded for "${check.label}"`,
      });
      continue;
    }
    if (value === true) {
      satisfied.push(check.id);
      continue;
    }
    failed.push({
      id: check.id,
      label: check.label,
      code: 'LIVE_CHECKLIST_NOT_TRUE',
      message: `"${check.label}" is not satisfied (expected an explicit true)`,
    });
  }

  const known = new Set(LIVE_ATTESTATION_CHECKS.map((check) => check.id));
  const unexpected = Object.keys(source).filter((key) => !known.has(key));

  return Object.freeze({
    passed: failed.length === 0,
    satisfied: Object.freeze(satisfied),
    failed: Object.freeze(failed),
    missing: Object.freeze(missing),
    unexpected: Object.freeze(unexpected),
  });
}
