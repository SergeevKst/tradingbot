/**
 * Order and OrderRequest — the execution-layer domain objects (MASTER_SPEC §7, §13).
 *
 * `OrderRequest` is what a *risk-approved* intent becomes immediately before it
 * is handed to an execution adapter. `Order` is the record of what the exchange
 * accepted and its lifecycle. Neither type is reachable by a strategy or an AI
 * model: they are produced only after the Risk Engine says APPROVED.
 *
 * Both schemas are CLOSED — unknown fields are rejected, never ignored.
 *
 * @module domain/order
 */
import { ORDER_STATUS, ORDER_TYPE, TIME_IN_FORCE } from '../types/enums.mjs';
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
import { ValidationError } from '../errors/taxonomy.mjs';
import { SIDE } from './side.mjs';

export const ORDER_REQUEST_FIELDS = Object.freeze([
  'symbol',
  'side',
  'type',
  'quantity',
  'price',
  'stopLossPrice',
  'takeProfitPrice',
  'leverage',
  'timeInForce',
  'clientOrderId',
  'timestamp',
]);

export const ORDER_FIELDS = Object.freeze([
  'orderId',
  'clientOrderId',
  'symbol',
  'side',
  'type',
  'status',
  'quantity',
  'filledQuantity',
  'price',
  'averagePrice',
  'stopLossPrice',
  'takeProfitPrice',
  'timeInForce',
  'createdAt',
  'updatedAt',
]);

/**
 * @typedef {object} OrderRequest
 * @property {string} symbol
 * @property {'LONG' | 'SHORT'} side
 * @property {'MARKET' | 'LIMIT'} type
 * @property {number} quantity base-asset quantity, always > 0
 * @property {number} [price] required for LIMIT, forbidden for MARKET
 * @property {number} [stopLossPrice]
 * @property {number} [takeProfitPrice]
 * @property {number} [leverage] >= 1 when present
 * @property {'GTC' | 'IOC' | 'FOK' | 'POST_ONLY'} timeInForce
 * @property {string} [clientOrderId]
 * @property {number} timestamp epoch milliseconds
 */

/**
 * @typedef {object} Order
 * @property {string} orderId exchange order id
 * @property {string} [clientOrderId]
 * @property {string} symbol
 * @property {'LONG' | 'SHORT'} side
 * @property {'MARKET' | 'LIMIT'} type
 * @property {'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED'} status
 * @property {number} quantity
 * @property {number} filledQuantity
 * @property {number} [price]
 * @property {number} [averagePrice] required once anything has filled
 * @property {number} [stopLossPrice]
 * @property {number} [takeProfitPrice]
 * @property {'GTC' | 'IOC' | 'FOK' | 'POST_ONLY'} timeInForce
 * @property {number} createdAt epoch milliseconds
 * @property {number} updatedAt epoch milliseconds
 */

/**
 * Validate and freeze an OrderRequest.
 *
 * @param {unknown} raw
 * @returns {Readonly<OrderRequest>}
 * @throws {ValidationError}
 */
export function createOrderRequest(raw) {
  const input = assertPlainObject(raw, 'OrderRequest');
  assertClosedFields(input, ORDER_REQUEST_FIELDS, 'OrderRequest');

  const type = assertEnumValue(input.type ?? ORDER_TYPE.LIMIT, ORDER_TYPE, 'OrderRequest.type', { uppercase: true });
  const price = assertOptionalNumber(input.price, 'OrderRequest.price', { exclusiveMin: 0 });
  if (type === ORDER_TYPE.LIMIT && price === undefined) {
    throw new ValidationError('OrderRequest.price is required for a LIMIT order', {
      details: { field: 'price' },
    });
  }
  if (type === ORDER_TYPE.MARKET && price !== undefined) {
    throw new ValidationError('OrderRequest.price must be omitted for a MARKET order', {
      details: { field: 'price', value: price },
    });
  }

  return Object.freeze({
    symbol: assertSymbol(input.symbol, 'OrderRequest.symbol'),
    side: assertEnumValue(input.side, SIDE, 'OrderRequest.side', { uppercase: true }),
    type,
    quantity: assertRequiredNumber(input.quantity, 'OrderRequest.quantity', { exclusiveMin: 0 }),
    price,
    stopLossPrice: assertOptionalNumber(input.stopLossPrice, 'OrderRequest.stopLossPrice', { exclusiveMin: 0 }),
    takeProfitPrice: assertOptionalNumber(input.takeProfitPrice, 'OrderRequest.takeProfitPrice', { exclusiveMin: 0 }),
    leverage: assertOptionalNumber(input.leverage, 'OrderRequest.leverage', { min: 1 }),
    timeInForce: assertEnumValue(input.timeInForce ?? TIME_IN_FORCE.GTC, TIME_IN_FORCE, 'OrderRequest.timeInForce', {
      uppercase: true,
    }),
    clientOrderId:
      input.clientOrderId === undefined || input.clientOrderId === null
        ? undefined
        : assertRequiredString(input.clientOrderId, 'OrderRequest.clientOrderId'),
    timestamp: assertEpochMillis(input.timestamp, 'OrderRequest.timestamp'),
  });
}

/**
 * Validate and freeze an Order record.
 *
 * @param {unknown} raw
 * @returns {Readonly<Order>}
 * @throws {ValidationError}
 */
export function createOrder(raw) {
  const input = assertPlainObject(raw, 'Order');
  assertClosedFields(input, ORDER_FIELDS, 'Order');

  const quantity = assertRequiredNumber(input.quantity, 'Order.quantity', { exclusiveMin: 0 });
  const filledQuantity = assertRequiredNumber(input.filledQuantity ?? 0, 'Order.filledQuantity', { min: 0 });
  if (filledQuantity > quantity) {
    throw new ValidationError(`Order.filledQuantity (${filledQuantity}) must not exceed quantity (${quantity})`, {
      details: { field: 'filledQuantity', value: filledQuantity },
    });
  }

  const averagePrice = assertOptionalNumber(input.averagePrice, 'Order.averagePrice', { exclusiveMin: 0 });
  if (filledQuantity > 0 && averagePrice === undefined) {
    throw new ValidationError('Order.averagePrice is required once any quantity has filled', {
      details: { field: 'averagePrice' },
    });
  }

  const createdAt = assertEpochMillis(input.createdAt, 'Order.createdAt');
  const updatedAt = assertEpochMillis(input.updatedAt, 'Order.updatedAt');
  if (updatedAt < createdAt) {
    throw new ValidationError(`Order.updatedAt (${updatedAt}) must not precede createdAt (${createdAt})`, {
      details: { field: 'updatedAt', value: updatedAt },
    });
  }

  return Object.freeze({
    orderId: assertRequiredString(input.orderId, 'Order.orderId'),
    clientOrderId:
      input.clientOrderId === undefined || input.clientOrderId === null
        ? undefined
        : assertRequiredString(input.clientOrderId, 'Order.clientOrderId'),
    symbol: assertSymbol(input.symbol, 'Order.symbol'),
    side: assertEnumValue(input.side, SIDE, 'Order.side', { uppercase: true }),
    type: assertEnumValue(input.type, ORDER_TYPE, 'Order.type', { uppercase: true }),
    status: assertEnumValue(input.status, ORDER_STATUS, 'Order.status', { uppercase: true }),
    quantity,
    filledQuantity,
    price: assertOptionalNumber(input.price, 'Order.price', { exclusiveMin: 0 }),
    averagePrice,
    stopLossPrice: assertOptionalNumber(input.stopLossPrice, 'Order.stopLossPrice', { exclusiveMin: 0 }),
    takeProfitPrice: assertOptionalNumber(input.takeProfitPrice, 'Order.takeProfitPrice', { exclusiveMin: 0 }),
    timeInForce: assertEnumValue(input.timeInForce ?? TIME_IN_FORCE.GTC, TIME_IN_FORCE, 'Order.timeInForce', {
      uppercase: true,
    }),
    createdAt,
    updatedAt,
  });
}
