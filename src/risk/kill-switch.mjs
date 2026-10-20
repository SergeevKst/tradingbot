/**
 * Kill switch — the deterministic emergency stop (MASTER_SPEC §44).
 *
 * Two layers feed one predicate:
 *
 *   CONFIG      `riskLimits.killSwitchEnabled` is a validated, static flag.
 *   OPERATIONAL `createKillSwitch()` is a runtime control the session can
 *               engage or release without a restart or a config edit.
 *
 * Both fail closed. `isKillSwitchEngaged` treats anything other than an explicit
 * `false` as engaged, so a missing or malformed limit stops trading rather than
 * silently permitting it. `engage()` always engages, even with no reason: the
 * safety-critical action must never fail because the caller forgot an argument.
 *
 * This module imports only the config error type — the risk layer stays pure
 * (no I/O, no clock dependency on the decision path; `now` is injectable).
 *
 * @module risk/kill-switch
 */
import { ConfigError } from '../config/config-error.mjs';

/**
 * Config-level check: is the static kill switch engaged?
 *
 * Fail closed — only an explicit `false` disengages.
 *
 * @param {{ killSwitchEnabled?: boolean } | null | undefined} limits
 * @returns {boolean}
 */
export function isKillSwitchEngaged(limits) {
  return limits?.killSwitchEnabled !== false;
}

/**
 * A runtime emergency stop the session can engage and release.
 *
 * @param {{ engaged?: boolean, reason?: string, now?: () => string }} [options]
 * @returns {{
 *   isEngaged: () => boolean,
 *   engage: (reason?: string) => { engaged: boolean, reason: string | null, engagedAt: string | null },
 *   disengage: () => { engaged: boolean, reason: string | null, engagedAt: string | null },
 *   snapshot: () => { engaged: boolean, reason: string | null, engagedAt: string | null },
 * }}
 * @throws {ConfigError} when the options shape is not an object
 */
export function createKillSwitch(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createKillSwitch requires an options object');
  }
  const now = options.now ?? (() => new Date().toISOString());
  let engaged = options.engaged === true;
  let reason = engaged ? normalizeReason(options.reason) : null;
  let engagedAt = engaged ? now() : null;

  function snapshot() {
    return Object.freeze({ engaged, reason, engagedAt });
  }

  return Object.freeze({
    isEngaged: () => engaged,

    /** Engage unconditionally; a missing reason is recorded as UNSPECIFIED. */
    engage(input) {
      engaged = true;
      reason = normalizeReason(input);
      engagedAt = now();
      return snapshot();
    },

    /** Release the stop. This is the only path back to trading. */
    disengage() {
      engaged = false;
      reason = null;
      engagedAt = null;
      return snapshot();
    },

    snapshot,
  });
}

/**
 * Assert an object satisfies the operational kill-switch contract.
 *
 * Fail closed: an injected control that cannot be engaged is refused at
 * construction rather than surfacing as a crash on the first trade.
 *
 * @param {unknown} control
 * @returns {{ isEngaged: () => boolean, engage: Function, disengage: Function, snapshot: Function }}
 * @throws {ConfigError}
 */
export function assertKillSwitch(control) {
  if (
    control === null ||
    typeof control !== 'object' ||
    typeof (/** @type {any} */ (control).isEngaged) !== 'function' ||
    typeof (/** @type {any} */ (control).engage) !== 'function' ||
    typeof (/** @type {any} */ (control).disengage) !== 'function' ||
    typeof (/** @type {any} */ (control).snapshot) !== 'function'
  ) {
    throw new ConfigError('KillSwitch must expose isEngaged(), engage(), disengage() and snapshot()');
  }
  return /** @type {any} */ (control);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeReason(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return 'UNSPECIFIED';
}
