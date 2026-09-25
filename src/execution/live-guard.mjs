/**
 * Live-execution guard — the single chokepoint that refuses real trading.
 *
 * Stage 1 has no live execution path at all. This module exists so that the
 * *absence* of that capability is an enforced, testable property rather than a
 * comment someone could forget: any future code that wants to place a real
 * order must call `assertLiveExecutionAllowed()` first, and that assertion
 * currently always fails.
 *
 * It has no imports beyond the config error type, and no side effects.
 *
 * @module execution/live-guard
 */
import { ConfigError } from '../config/config-error.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';
import { TRADING_MODE } from '../config/trading-mode.mjs';

/**
 * Whether a live execution path exists in this build.
 *
 * Hard-coded `false` for Stage 1. Changing it is a deliberate, reviewable act —
 * it cannot be flipped by configuration, environment variable or caller.
 */
export const LIVE_EXECUTION_IMPLEMENTED = false;

/**
 * @typedef {object} LiveGuardDecision
 * @property {boolean} allowed
 * @property {string} reasonCode
 * @property {string} message
 */

/**
 * Decide whether live execution may proceed. Pure — it only inspects its input.
 *
 * @param {{ tradingMode: string, liveTradingAllowed?: boolean, acknowledgedLiveRisk?: boolean }} context
 * @returns {Readonly<LiveGuardDecision>}
 */
export function checkLiveExecution(context) {
  const tradingMode = context?.tradingMode;
  const liveTradingAllowed = context?.liveTradingAllowed === true;
  const acknowledgedLiveRisk = context?.acknowledgedLiveRisk === true;

  if (!LIVE_EXECUTION_IMPLEMENTED) {
    return Object.freeze({
      allowed: false,
      reasonCode: REASON_CODE.LIVE_TRADING_DISABLED,
      message: 'Live execution is not implemented in Stage 1; no live order path exists in this build',
    });
  }

  if (tradingMode !== TRADING_MODE.LIVE) {
    return Object.freeze({
      allowed: false,
      reasonCode: REASON_CODE.UNSUPPORTED_MODE,
      message: `Live execution requires TRADING_MODE=LIVE, got ${JSON.stringify(tradingMode)}`,
    });
  }

  if (!liveTradingAllowed) {
    return Object.freeze({
      allowed: false,
      reasonCode: REASON_CODE.LIVE_TRADING_DISABLED,
      message: 'Live execution requires the explicit ALLOW_LIVE_TRADING=true opt-in',
    });
  }

  if (!acknowledgedLiveRisk) {
    return Object.freeze({
      allowed: false,
      reasonCode: REASON_CODE.LIVE_TRADING_DISABLED,
      message: 'Live execution requires an explicit risk acknowledgement from the caller',
    });
  }

  return Object.freeze({
    allowed: true,
    reasonCode: REASON_CODE.APPROVED,
    message: 'Live execution permitted',
  });
}

/**
 * Throw unless live execution is permitted. Throws today by construction.
 *
 * @param {Parameters<typeof checkLiveExecution>[0]} context
 * @throws {ConfigError}
 */
export function assertLiveExecutionAllowed(context) {
  const decision = checkLiveExecution(context);
  if (!decision.allowed) {
    throw new ConfigError(`Live execution blocked (${decision.reasonCode}): ${decision.message}`, {
      field: 'tradingMode',
      value: context?.tradingMode,
    });
  }
}