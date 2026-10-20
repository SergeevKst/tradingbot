/**
 * TradingSignal — a strategy's directional view (MASTER_SPEC §7).
 *
 * A signal is explicitly NOT an order and NOT a sized position. It carries no
 * quantity and no leverage, because sizing is the Risk Engine's job alone. It
 * is the object a signal engine or strategy produces before any TradeProposal
 * is formed.
 *
 * @module domain/signal
 */
import {
  assertClosedFields,
  assertEnumValue,
  assertEpochMillis,
  assertOptionalNumber,
  assertPlainObject,
  assertRequiredString,
  assertSymbol,
  assertUnitInterval,
} from '../types/primitives.mjs';
import { SIDE } from './side.mjs';

export const TRADING_SIGNAL_FIELDS = Object.freeze([
  'strategyId',
  'symbol',
  'side',
  'confidence',
  'entryPrice',
  'stopLossPrice',
  'takeProfitPrice',
  'reason',
  'timestamp',
]);

/**
 * @typedef {object} TradingSignal
 * @property {string} strategyId
 * @property {string} symbol
 * @property {'LONG' | 'SHORT'} side
 * @property {number} confidence [0, 1], informational only
 * @property {number} [entryPrice]
 * @property {number} [stopLossPrice]
 * @property {number} [takeProfitPrice]
 * @property {string} [reason]
 * @property {number} timestamp epoch milliseconds
 */

/**
 * Validate and freeze a TradingSignal.
 *
 * @param {unknown} raw
 * @returns {Readonly<TradingSignal>}
 * @throws {import('../errors/taxonomy.mjs').ValidationError}
 */
export function createTradingSignal(raw) {
  const input = assertPlainObject(raw, 'TradingSignal');
  assertClosedFields(input, TRADING_SIGNAL_FIELDS, 'TradingSignal');

  return Object.freeze({
    strategyId: assertRequiredString(input.strategyId, 'TradingSignal.strategyId', { maxLength: 64 }),
    symbol: assertSymbol(input.symbol, 'TradingSignal.symbol'),
    side: assertEnumValue(input.side, SIDE, 'TradingSignal.side', { uppercase: true }),
    confidence: assertUnitInterval(input.confidence, 'TradingSignal.confidence'),
    entryPrice: assertOptionalNumber(input.entryPrice, 'TradingSignal.entryPrice', { exclusiveMin: 0 }),
    stopLossPrice: assertOptionalNumber(input.stopLossPrice, 'TradingSignal.stopLossPrice', { exclusiveMin: 0 }),
    takeProfitPrice: assertOptionalNumber(input.takeProfitPrice, 'TradingSignal.takeProfitPrice', { exclusiveMin: 0 }),
    reason:
      input.reason === undefined || input.reason === null
        ? undefined
        : assertRequiredString(input.reason, 'TradingSignal.reason', { maxLength: 280 }),
    timestamp: assertEpochMillis(input.timestamp, 'TradingSignal.timestamp'),
  });
}
