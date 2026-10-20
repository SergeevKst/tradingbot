/**
 * OrderFill — a single executed match against an order (MASTER_SPEC §7, §21).
 *
 * The audit trail needs the actual fills, not just an order's terminal status:
 * fees, average price and realised PnL all come from here.
 *
 * @module domain/order-fill
 */
import {
  assertClosedFields,
  assertEnumValue,
  assertEpochMillis,
  assertOptionalNumber,
  assertPlainObject,
  assertRequiredNumber,
  assertRequiredString,
  assertSymbol,
} from '../types/primitives.mjs';
import { SIDE } from './side.mjs';

export const ORDER_FILL_FIELDS = Object.freeze([
  'fillId',
  'orderId',
  'tradeId',
  'symbol',
  'side',
  'quantity',
  'price',
  'feeUsd',
  'feeAsset',
  'timestamp',
]);

/**
 * @typedef {object} OrderFill
 * @property {string} [fillId] exchange-assigned execution id, when supplied
 * @property {string} orderId the order this fill belongs to
 * @property {string} [tradeId]
 * @property {string} symbol
 * @property {'LONG' | 'SHORT'} side
 * @property {number} quantity filled, > 0
 * @property {number} price execution price, > 0
 * @property {number} feeUsd fee paid in USD terms, >= 0
 * @property {string} [feeAsset] asset the fee was charged in
 * @property {number} timestamp epoch milliseconds
 */

/**
 * Validate and freeze an OrderFill.
 *
 * @param {unknown} raw
 * @returns {Readonly<OrderFill>}
 * @throws {ValidationError}
 */
export function createOrderFill(raw) {
  const input = assertPlainObject(raw, 'OrderFill');
  assertClosedFields(input, ORDER_FILL_FIELDS, 'OrderFill');

  return Object.freeze({
    fillId:
      input.fillId === undefined || input.fillId === null
        ? undefined
        : assertRequiredString(input.fillId, 'OrderFill.fillId'),
    orderId: assertRequiredString(input.orderId, 'OrderFill.orderId'),
    tradeId:
      input.tradeId === undefined || input.tradeId === null
        ? undefined
        : assertRequiredString(input.tradeId, 'OrderFill.tradeId'),
    symbol: assertSymbol(input.symbol, 'OrderFill.symbol'),
    side: assertEnumValue(input.side, SIDE, 'OrderFill.side', { uppercase: true }),
    quantity: assertRequiredNumber(input.quantity, 'OrderFill.quantity', { exclusiveMin: 0 }),
    price: assertRequiredNumber(input.price, 'OrderFill.price', { exclusiveMin: 0 }),
    feeUsd: assertRequiredNumber(input.feeUsd ?? 0, 'OrderFill.feeUsd', { min: 0 }),
    feeAsset:
      input.feeAsset === undefined || input.feeAsset === null
        ? undefined
        : assertRequiredString(input.feeAsset, 'OrderFill.feeAsset').toUpperCase(),
    timestamp: assertEpochMillis(input.timestamp, 'OrderFill.timestamp'),
  });
}
