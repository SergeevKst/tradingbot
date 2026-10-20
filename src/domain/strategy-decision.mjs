/**
 * StrategyDecision — the complete, auditable outcome of evaluating a strategy
 * (MASTER_SPEC §7, §25).
 *
 * "No signal" is a first-class decision, not an absence: recording it is what
 * lets the audit trail answer "why did the system consider this trade?" with
 * "it deliberately did not" (§21). The schema enforces that a NON-signal can
 * never carry a signal payload and an EMIT always carries one.
 *
 * @module domain/strategy-decision
 */
import { SIGNAL_ACTION } from '../types/enums.mjs';
import {
  assertClosedFields,
  assertEnumValue,
  assertEpochMillis,
  assertPlainObject,
  assertRequiredString,
  assertSymbol,
} from '../types/primitives.mjs';
import { ValidationError } from '../errors/taxonomy.mjs';
import { createTradingSignal } from './signal.mjs';

export const STRATEGY_DECISION_FIELDS = Object.freeze([
  'strategyId',
  'symbol',
  'action',
  'signal',
  'reason',
  'timestamp',
]);

/**
 * @typedef {object} StrategyDecision
 * @property {string} strategyId
 * @property {string} symbol
 * @property {'EMIT' | 'NO_SIGNAL'} action
 * @property {import('./signal.mjs').TradingSignal} [signal] present iff action is EMIT
 * @property {string} [reason]
 * @property {number} timestamp epoch milliseconds
 */

/**
 * Validate and freeze a StrategyDecision.
 *
 * @param {unknown} raw
 * @returns {Readonly<StrategyDecision>}
 * @throws {ValidationError}
 */
export function createStrategyDecision(raw) {
  const input = assertPlainObject(raw, 'StrategyDecision');
  assertClosedFields(input, STRATEGY_DECISION_FIELDS, 'StrategyDecision');

  const action = assertEnumValue(input.action, SIGNAL_ACTION, 'StrategyDecision.action', { uppercase: true });
  const hasSignal = input.signal !== undefined && input.signal !== null;

  if (action === SIGNAL_ACTION.EMIT && !hasSignal) {
    throw new ValidationError('StrategyDecision.action EMIT requires a signal', { details: { field: 'signal' } });
  }
  if (action === SIGNAL_ACTION.NO_SIGNAL && hasSignal) {
    throw new ValidationError('StrategyDecision.action NO_SIGNAL must not carry a signal', {
      details: { field: 'signal' },
    });
  }

  return Object.freeze({
    strategyId: assertRequiredString(input.strategyId, 'StrategyDecision.strategyId', { maxLength: 64 }),
    symbol: assertSymbol(input.symbol, 'StrategyDecision.symbol'),
    action,
    signal: hasSignal ? createTradingSignal(input.signal) : undefined,
    reason:
      input.reason === undefined || input.reason === null
        ? undefined
        : assertRequiredString(input.reason, 'StrategyDecision.reason', { maxLength: 280 }),
    timestamp: assertEpochMillis(input.timestamp, 'StrategyDecision.timestamp'),
  });
}
