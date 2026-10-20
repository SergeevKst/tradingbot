/**
 * Position — an open exposure on one symbol (MASTER_SPEC §7).
 *
 * Distinct from `account-state.mjs`'s `OpenPosition`: that is a deliberately
 * thin summary the Risk Engine consumes, while this is the full portfolio-level
 * record (entry, mark, leverage, protection, unrealised PnL).
 *
 * @module domain/position
 */
import { POSITION_STATUS } from '../types/enums.mjs';
import {
  assertClosedFields,
  assertEnumValue,
  assertEpochMillis,
  assertOptionalNumber,
  assertPlainObject,
  assertRequiredNumber,
  assertSymbol,
} from '../types/primitives.mjs';
import { SIDE } from './side.mjs';

export const POSITION_FIELDS = Object.freeze([
  'symbol',
  'side',
  'quantity',
  'entryPrice',
  'markPrice',
  'leverage',
  'stopLossPrice',
  'takeProfitPrice',
  'liquidationPrice',
  'unrealizedPnlUsd',
  'openedAt',
  'status',
]);

/**
 * @typedef {object} Position
 * @property {string} symbol
 * @property {'LONG' | 'SHORT'} side
 * @property {number} quantity base-asset quantity, > 0
 * @property {number} entryPrice
 * @property {number} [markPrice]
 * @property {number} leverage >= 1
 * @property {number} [stopLossPrice]
 * @property {number} [takeProfitPrice]
 * @property {number} [liquidationPrice]
 * @property {number} [unrealizedPnlUsd] signed, finite
 * @property {number} openedAt epoch milliseconds
 * @property {'OPEN' | 'CLOSED'} status
 */

/**
 * Validate and freeze a Position.
 *
 * @param {unknown} raw
 * @returns {Readonly<Position>}
 * @throws {ValidationError}
 */
export function createPosition(raw) {
  const input = assertPlainObject(raw, 'Position');
  assertClosedFields(input, POSITION_FIELDS, 'Position');

  return Object.freeze({
    symbol: assertSymbol(input.symbol, 'Position.symbol'),
    side: assertEnumValue(input.side, SIDE, 'Position.side', { uppercase: true }),
    quantity: assertRequiredNumber(input.quantity, 'Position.quantity', { exclusiveMin: 0 }),
    entryPrice: assertRequiredNumber(input.entryPrice, 'Position.entryPrice', { exclusiveMin: 0 }),
    markPrice: assertOptionalNumber(input.markPrice, 'Position.markPrice', { min: 0 }),
    leverage: assertRequiredNumber(input.leverage ?? 1, 'Position.leverage', { min: 1 }),
    stopLossPrice: assertOptionalNumber(input.stopLossPrice, 'Position.stopLossPrice', { exclusiveMin: 0 }),
    takeProfitPrice: assertOptionalNumber(input.takeProfitPrice, 'Position.takeProfitPrice', { exclusiveMin: 0 }),
    liquidationPrice: assertOptionalNumber(input.liquidationPrice, 'Position.liquidationPrice', { min: 0 }),
    unrealizedPnlUsd: assertOptionalNumber(input.unrealizedPnlUsd, 'Position.unrealizedPnlUsd'),
    openedAt: assertEpochMillis(input.openedAt, 'Position.openedAt'),
    status: assertEnumValue(input.status ?? POSITION_STATUS.OPEN, POSITION_STATUS, 'Position.status', {
      uppercase: true,
    }),
  });
}
