/**
 * Bybit <-> domain order mapping for the TESTNET layer (MASTER_SPEC §13, §48).
 *
 * The exchange speaks its own vocabulary (`Buy`, `PartiallyFilledCanceled`,
 * `PostOnly`); the core speaks the domain enums. Mapping is explicit and
 * fail-closed: an unknown status or time-in-force raises a `DataError` rather
 * than being coerced into a plausible-looking value.
 *
 * @module testnet/order-mapper
 */
import { ORDER_STATUS, ORDER_TYPE, TIME_IN_FORCE } from '../types/enums.mjs';
import { createOrder } from '../domain/order.mjs';
import { SIDE } from '../domain/side.mjs';
import { DataError, ValidationError } from '../errors/taxonomy.mjs';
import { parseFiniteNumber } from '../types/primitives.mjs';

/** Bybit order status -> domain status. Anything unlisted is a DataError. */
const STATUS_MAP = Object.freeze({
  New: ORDER_STATUS.NEW,
  Untraded: ORDER_STATUS.NEW,
  Active: ORDER_STATUS.NEW,
  PartiallyFilled: ORDER_STATUS.PARTIALLY_FILLED,
  Filled: ORDER_STATUS.FILLED,
  Cancelled: ORDER_STATUS.CANCELED,
  PartiallyFilledCanceled: ORDER_STATUS.CANCELED,
  Rejected: ORDER_STATUS.REJECTED,
  Deactivated: ORDER_STATUS.EXPIRED,
});

/** Domain time-in-force -> Bybit spelling. */
const TIF_TO_BYBIT = Object.freeze({
  [TIME_IN_FORCE.GTC]: 'GTC',
  [TIME_IN_FORCE.IOC]: 'IOC',
  [TIME_IN_FORCE.FOK]: 'FOK',
  [TIME_IN_FORCE.POST_ONLY]: 'PostOnly',
});

/** Bybit time-in-force -> domain spelling. */
const TIF_FROM_BYBIT = Object.freeze({
  GTC: TIME_IN_FORCE.GTC,
  IOC: TIME_IN_FORCE.IOC,
  FOK: TIME_IN_FORCE.FOK,
  PostOnly: TIME_IN_FORCE.POST_ONLY,
});

/**
 * @param {unknown} side
 * @returns {'Buy' | 'Sell'}
 * @throws {ValidationError}
 */
export function toBybitSide(side) {
  if (side === SIDE.LONG) return 'Buy';
  if (side === SIDE.SHORT) return 'Sell';
  throw new ValidationError(`OrderRequest.side must be ${SIDE.LONG} or ${SIDE.SHORT} — got ${JSON.stringify(side)}`, {
    details: { field: 'side', value: side },
  });
}

/**
 * @param {unknown} bybitStatus
 * @returns {string} a domain ORDER_STATUS
 * @throws {DataError}
 */
export function mapBybitOrderStatus(bybitStatus) {
  if (typeof bybitStatus === 'string' && Object.prototype.hasOwnProperty.call(STATUS_MAP, bybitStatus)) {
    return STATUS_MAP[/** @type {keyof typeof STATUS_MAP} */ (bybitStatus)];
  }
  throw new DataError(`Unknown Bybit order status ${JSON.stringify(bybitStatus)}`, {
    details: { field: 'orderStatus', value: bybitStatus },
  });
}

/**
 * @param {unknown} bybitTif
 * @returns {string} a domain TIME_IN_FORCE
 * @throws {DataError}
 */
export function mapBybitTimeInForce(bybitTif) {
  if (typeof bybitTif === 'string' && Object.prototype.hasOwnProperty.call(TIF_FROM_BYBIT, bybitTif)) {
    return TIF_FROM_BYBIT[/** @type {keyof typeof TIF_FROM_BYBIT} */ (bybitTif)];
  }
  throw new DataError(`Unknown Bybit timeInForce ${JSON.stringify(bybitTif)}`, {
    details: { field: 'timeInForce', value: bybitTif },
  });
}

/**
 * Convert a risk-approved domain OrderRequest into Bybit V5 order parameters.
 *
 * @param {import('../domain/order.mjs').OrderRequest} request
 * @returns {Readonly<Record<string, string>>}
 * @throws {ValidationError}
 */
export function toBybitOrderParams(request) {
  if (request === null || typeof request !== 'object') {
    throw new ValidationError('toBybitOrderParams requires an OrderRequest', { details: { field: 'request' } });
  }
  /** @type {Record<string, string>} */
  const params = {
    symbol: request.symbol,
    side: toBybitSide(request.side),
    orderType: request.type === ORDER_TYPE.MARKET ? 'Market' : 'Limit',
    qty: String(request.quantity),
    timeInForce: TIF_TO_BYBIT[request.timeInForce] ?? 'GTC',
  };
  if (request.type === ORDER_TYPE.LIMIT && request.price !== undefined) params.price = String(request.price);
  if (request.clientOrderId !== undefined) params.orderLinkId = request.clientOrderId;
  if (request.stopLossPrice !== undefined) params.stopLoss = String(request.stopLossPrice);
  if (request.takeProfitPrice !== undefined) params.takeProfit = String(request.takeProfitPrice);
  return Object.freeze(params);
}

/**
 * Map a Bybit V5 order object into a validated domain Order.
 *
 * @param {Record<string, unknown>} raw
 * @returns {Readonly<import('../domain/order.mjs').Order>}
 * @throws {DataError} on a missing/unknown essential field
 */
export function mapBybitOrder(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DataError('Bybit order payload must be an object', { details: { field: 'order' } });
  }
  const createdTime = parseFiniteNumber(raw.createdTime);
  const updatedTime = parseFiniteNumber(raw.updatedTime) ?? createdTime;
  if (createdTime === null || updatedTime === null) {
    throw new DataError('Bybit order is missing createdTime/updatedTime', {
      details: { field: 'createdTime', value: raw.createdTime },
    });
  }

  const side = raw.side === 'Buy' ? SIDE.LONG : raw.side === 'Sell' ? SIDE.SHORT : undefined;
  const type = raw.orderType === 'Market' ? ORDER_TYPE.MARKET : raw.orderType === 'Limit' ? ORDER_TYPE.LIMIT : undefined;
  if (side === undefined) throw new DataError(`Unknown Bybit order side ${JSON.stringify(raw.side)}`, { details: { field: 'side', value: raw.side } });
  if (type === undefined) throw new DataError(`Unknown Bybit order type ${JSON.stringify(raw.orderType)}`, { details: { field: 'orderType', value: raw.orderType } });

  return createOrder({
    orderId: raw.orderId,
    clientOrderId: raw.orderLinkId === '' || raw.orderLinkId === undefined ? undefined : raw.orderLinkId,
    symbol: raw.symbol,
    side,
    type,
    status: mapBybitOrderStatus(raw.orderStatus),
    quantity: raw.qty,
    filledQuantity: raw.cumExecQty ?? 0,
    price: raw.price,
    averagePrice: raw.avgPrice,
    timeInForce: mapBybitTimeInForce(raw.timeInForce ?? 'GTC'),
    createdAt: createdTime,
    updatedAt: updatedTime,
  });
}
