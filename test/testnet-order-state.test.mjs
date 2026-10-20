/**
 * Phase 8 order mapping + state machine tests.
 *
 * The mapper is pinned to Bybit's vocabulary and the reducer is pinned to the
 * legal lifecycle. Unknown statuses and impossible transitions must fail closed.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DataError, OrderError, ValidationError } from '../src/errors/taxonomy.mjs';
import { ORDER_STATUS, ORDER_TYPE, TIME_IN_FORCE } from '../src/types/enums.mjs';
import { createOrderRequest } from '../src/domain/order.mjs';
import { mapBybitOrder, mapBybitOrderStatus, mapBybitTimeInForce, toBybitOrderParams, toBybitSide } from '../src/testnet/order-mapper.mjs';
import { initialOrderStatus, isTerminalOrderStatus, reduceOrderStatus } from '../src/testnet/order-state-machine.mjs';

const TS = 1_700_000_000_000;

test('ORDER MAP: every documented Bybit status maps to a domain status', () => {
  assert.equal(mapBybitOrderStatus('New'), ORDER_STATUS.NEW);
  assert.equal(mapBybitOrderStatus('Untraded'), ORDER_STATUS.NEW);
  assert.equal(mapBybitOrderStatus('PartiallyFilled'), ORDER_STATUS.PARTIALLY_FILLED);
  assert.equal(mapBybitOrderStatus('Filled'), ORDER_STATUS.FILLED);
  assert.equal(mapBybitOrderStatus('Cancelled'), ORDER_STATUS.CANCELED);
  assert.equal(mapBybitOrderStatus('PartiallyFilledCanceled'), ORDER_STATUS.CANCELED);
  assert.equal(mapBybitOrderStatus('Rejected'), ORDER_STATUS.REJECTED);
  assert.equal(mapBybitOrderStatus('Deactivated'), ORDER_STATUS.EXPIRED);
  assert.throws(() => mapBybitOrderStatus('MadeUp'), DataError);
});

test('ORDER MAP: time-in-force maps both directions', () => {
  assert.equal(mapBybitTimeInForce('GTC'), TIME_IN_FORCE.GTC);
  assert.equal(mapBybitTimeInForce('PostOnly'), TIME_IN_FORCE.POST_ONLY);
  assert.throws(() => mapBybitTimeInForce('Banana'), DataError);
});

test('ORDER MAP: a domain OrderRequest becomes Bybit parameters', () => {
  const request = createOrderRequest({
    symbol: 'BTCUSDT',
    side: 'LONG',
    type: 'LIMIT',
    quantity: 0.01,
    price: 50000,
    timeInForce: 'POST_ONLY',
    clientOrderId: 'cid-1',
    timestamp: TS,
  });
  const params = toBybitOrderParams(request);
  assert.equal(params.symbol, 'BTCUSDT');
  assert.equal(params.side, 'Buy');
  assert.equal(params.orderType, 'Limit');
  assert.equal(params.qty, '0.01');
  assert.equal(params.price, '50000');
  assert.equal(params.timeInForce, 'PostOnly');
  assert.equal(params.orderLinkId, 'cid-1');

  assert.equal(toBybitSide('SHORT'), 'Sell');
  assert.throws(() => toBybitSide('SIDEWAYS'), ValidationError);
});

test('ORDER MAP: a raw Bybit order becomes a validated domain Order', () => {
  const order = mapBybitOrder({
    orderId: 'abc-1',
    orderLinkId: '',
    symbol: 'BTCUSDT',
    side: 'Buy',
    orderType: 'Limit',
    orderStatus: 'PartiallyFilled',
    qty: '0.02',
    cumExecQty: '0.01',
    price: '50000',
    avgPrice: '50010',
    timeInForce: 'GTC',
    createdTime: TS,
    updatedTime: TS + 500,
  });
  assert.equal(order.orderId, 'abc-1');
  assert.equal(order.status, ORDER_STATUS.PARTIALLY_FILLED);
  assert.equal(order.type, ORDER_TYPE.LIMIT);
  assert.equal(order.filledQuantity, 0.01);
  assert.equal(order.averagePrice, 50010);
  assert.equal(order.clientOrderId, undefined);

  assert.throws(() => mapBybitOrder({ orderStatus: 'New', side: 'Buy', orderType: 'Limit', qty: '1' }), DataError, 'missing times must fail closed');
});

test('FSM: legal transitions reduce forward', () => {
  assert.equal(initialOrderStatus(), ORDER_STATUS.NEW);
  assert.equal(reduceOrderStatus(ORDER_STATUS.NEW, ORDER_STATUS.PARTIALLY_FILLED), ORDER_STATUS.PARTIALLY_FILLED);
  assert.equal(reduceOrderStatus(ORDER_STATUS.PARTIALLY_FILLED, ORDER_STATUS.FILLED), ORDER_STATUS.FILLED);
  assert.equal(reduceOrderStatus(ORDER_STATUS.NEW, ORDER_STATUS.CANCELED), ORDER_STATUS.CANCELED);
  assert.equal(reduceOrderStatus(ORDER_STATUS.NEW, ORDER_STATUS.NEW), ORDER_STATUS.NEW, 'a repeated update is idempotent');
});

test('FSM: impossible transitions and unknown states fail closed', () => {
  assert.throws(() => reduceOrderStatus(ORDER_STATUS.FILLED, ORDER_STATUS.NEW), OrderError);
  assert.throws(() => reduceOrderStatus(ORDER_STATUS.CANCELED, ORDER_STATUS.FILLED), OrderError);
  assert.throws(() => reduceOrderStatus(ORDER_STATUS.PARTIALLY_FILLED, ORDER_STATUS.NEW), OrderError);
  assert.throws(() => reduceOrderStatus('NOPE', ORDER_STATUS.NEW), OrderError);
});

test('FSM: terminal states are recognised', () => {
  assert.equal(isTerminalOrderStatus(ORDER_STATUS.FILLED), true);
  assert.equal(isTerminalOrderStatus(ORDER_STATUS.CANCELED), true);
  assert.equal(isTerminalOrderStatus(ORDER_STATUS.NEW), false);
  assert.throws(() => isTerminalOrderStatus('NOPE'), OrderError);
});
