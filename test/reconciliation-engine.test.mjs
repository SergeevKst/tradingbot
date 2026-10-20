/**
 * Phase 9 reconciliation engine tests.
 *
 * Every failure scenario in the phase brief is exercised with a mocked exchange:
 * restart (guard restore is covered in recovery-restart), network failure, API
 * timeout, duplicate prevention, partial fills and unknown order state.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DataError, NetworkError, OrderError } from '../src/errors/taxonomy.mjs';
import { createDuplicateGuard, GUARD_STATE } from '../src/reconciliation/duplicate-guard.mjs';
import { createIdempotencyKey } from '../src/reconciliation/idempotency.mjs';
import { RECONCILE_OUTCOME } from '../src/reconciliation/order-reconciler.mjs';
import { createReconciliationEngine } from '../src/reconciliation/reconciliation-engine.mjs';
import { JOURNAL_EVENT } from '../src/state/journal.mjs';

const TS = 1_700_000_000_000;
const REQUEST = Object.freeze({
  symbol: 'BTCUSDT',
  side: 'LONG',
  type: 'MARKET',
  quantity: 0.01,
  timeInForce: 'IOC',
  timestamp: TS,
});
const INTENT = Object.freeze({ ...REQUEST, strategyId: 'trend', intentId: 'trade-1' });
const KEY = createIdempotencyKey(INTENT);

function memoryJournal() {
  const events = [];
  return {
    events,
    async record(entry) {
      events.push(entry);
    },
    async read() {
      return { events: [...events], skippedTail: false };
    },
  };
}

function remote(status, filledQuantity, overrides = {}) {
  return { orderId: 'o-1', symbol: 'BTCUSDT', status, quantity: 0.01, filledQuantity, ...overrides };
}

function engineWith(exchange, options = {}) {
  const journal = options.journal ?? memoryJournal();
  const engine = createReconciliationEngine({
    exchange,
    journal,
    sleep: async () => {},
    maxQueryAttempts: 3,
    ...options,
  });
  return { engine, journal };
}

test('ENGINE: a first submission is placed once and confirmed', async () => {
  let calls = 0;
  const exchange = { async placeOrder() { calls += 1; return { orderId: 'o-1' }; } };
  const { engine, journal } = engineWith(exchange);

  const result = await engine.submitOrder({ request: REQUEST, intent: INTENT });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(engine.guard.get(KEY).state, GUARD_STATE.SUBMITTED);
  assert.ok(journal.events.some((e) => e.eventType === JOURNAL_EVENT.ORDER_SUBMITTED));
});

test('ENGINE: the same intent is never placed twice (duplicate prevention)', async () => {
  let calls = 0;
  const exchange = { async placeOrder() { calls += 1; return { orderId: 'o-1' }; } };
  const { engine, journal } = engineWith(exchange);

  await engine.submitOrder({ request: REQUEST, intent: INTENT });
  const second = await engine.submitOrder({ request: REQUEST, intent: INTENT });
  assert.equal(second.ok, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.reasonCode, 'DUPLICATE_ORDER');
  assert.equal(calls, 1, 'the exchange must only ever see one create');
  assert.ok(journal.events.some((e) => e.eventType === JOURNAL_EVENT.DUPLICATE_ORDER_BLOCKED));
});

test('ENGINE: keys are deterministic across engines (restart safety)', async () => {
  const a = engineWith({ async placeOrder() { return { orderId: 'o-1' }; } });
  const b = engineWith({ async placeOrder() { return { orderId: 'o-2' }; } });
  await a.engine.submitOrder({ request: REQUEST, intent: INTENT });
  await b.engine.submitOrder({ request: REQUEST, intent: INTENT });
  const keysOf = (journal) => journal.events.filter((e) => e.eventType === JOURNAL_EVENT.ORDER_SUBMIT_ATTEMPTED).map((e) => e.metadata.idempotencyKey);
  assert.deepEqual(keysOf(a.journal), keysOf(b.journal));
  assert.deepEqual(keysOf(a.journal), [KEY]);
});

test('ENGINE: an exchange refusal releases the key for a safe retry', async () => {
  let calls = 0;
  const exchange = {
    async placeOrder() {
      calls += 1;
      if (calls === 1) throw new OrderError('rejected', { details: { retCode: 110007 } });
      return { orderId: 'o-1' };
    },
  };
  const { engine, journal } = engineWith(exchange);

  const refused = await engine.submitOrder({ request: REQUEST, intent: INTENT });
  assert.equal(refused.refused, true);
  assert.equal(engine.guard.get(KEY).state, GUARD_STATE.FAILED);

  const retry = await engine.submitOrder({ request: REQUEST, intent: INTENT });
  assert.equal(retry.ok, true);
  assert.equal(calls, 2);
  assert.ok(journal.events.some((e) => e.eventType === JOURNAL_EVENT.ORDER_SUBMIT_FAILED));
});

test('ENGINE: a timeout that actually placed the order is recovered by clientOrderId', async () => {
  let queried = null;
  const exchange = {
    async placeOrder() {
      throw new NetworkError('timeout');
    },
    async getOrder(params) {
      queried = params;
      return remote('NEW', 0);
    },
  };
  const { engine, journal } = engineWith(exchange);

  const result = await engine.submitOrder({ request: REQUEST, intent: INTENT });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(queried.clientOrderId, KEY);
  assert.equal(engine.guard.get(KEY).state, GUARD_STATE.SUBMITTED);
  const submitted = journal.events.find((e) => e.eventType === JOURNAL_EVENT.ORDER_SUBMITTED);
  assert.equal(submitted.reason, 'RECOVERED_AFTER_AMBIGUOUS_FAILURE');
});

test('ENGINE: an ambiguous failure with no trace stays UNKNOWN and blocks a resubmit', async () => {
  const exchange = {
    async placeOrder() {
      throw new NetworkError('timeout');
    },
    async getOrder() {
      throw new DataError('Bybit testnet returned no order for getOrder');
    },
  };
  const { engine, journal } = engineWith(exchange);

  const first = await engine.submitOrder({ request: REQUEST, intent: INTENT });
  assert.equal(first.ok, false);
  assert.equal(first.unknown, true);
  assert.equal(engine.guard.get(KEY).state, GUARD_STATE.UNKNOWN);

  const second = await engine.submitOrder({ request: REQUEST, intent: INTENT });
  assert.equal(second.duplicate, true, 'an unknown order must never be resubmitted');
  assert.ok(journal.events.some((e) => e.eventType === JOURNAL_EVENT.ORDER_SUBMIT_UNKNOWN));
});

test('ENGINE: an undetermined query after a timeout leaves the order UNKNOWN', async () => {
  let queries = 0;
  const exchange = {
    async placeOrder() {
      throw new NetworkError('timeout');
    },
    async getOrder() {
      queries += 1;
      throw new NetworkError('still down');
    },
  };
  const { engine } = engineWith(exchange, { maxQueryAttempts: 3 });

  const result = await engine.submitOrder({ request: REQUEST, intent: INTENT });
  assert.equal(result.unknown, true);
  assert.equal(queries, 3, 'the lookup is bounded');
  assert.equal(engine.guard.get(KEY).state, GUARD_STATE.UNKNOWN);
});

test('ENGINE: a partial fill advances the local quantity by the delta', async () => {
  const guard = createDuplicateGuard();
  guard.reserve(KEY, { symbol: 'BTCUSDT', quantity: 1, clientOrderId: KEY });
  guard.confirm(KEY, { orderId: 'o-1', status: 'PARTIALLY_FILLED', filledQuantity: 0.4, quantity: 1, symbol: 'BTCUSDT' });

  const exchange = { async getOrder() { return { orderId: 'o-1', symbol: 'BTCUSDT', status: 'PARTIALLY_FILLED', quantity: 1, filledQuantity: 0.7 }; } };
  const { engine } = engineWith(exchange, { guard });

  const result = await engine.reconcileOrder({ idempotencyKey: KEY, clientOrderId: KEY, orderId: 'o-1', symbol: 'BTCUSDT', quantity: 1, status: 'PARTIALLY_FILLED', filledQuantity: 0.4 });
  assert.equal(result.outcome, RECONCILE_OUTCOME.ADVANCED);
  assert.equal(result.filledQuantity, 0.7);
  assert.equal(result.filledDelta, 0.3);
  assert.equal(engine.guard.get(KEY).filledQuantity, 0.7, 'the local ledger adopts the exchange fill');
});

test('ENGINE: a filled order on the exchange resolves the local partial fill', async () => {
  const guard = createDuplicateGuard();
  guard.reserve(KEY, { symbol: 'BTCUSDT', quantity: 1, clientOrderId: KEY });
  guard.confirm(KEY, { orderId: 'o-1', status: 'PARTIALLY_FILLED', filledQuantity: 0.4, quantity: 1, symbol: 'BTCUSDT' });

  const exchange = { async getOrder() { return { orderId: 'o-1', symbol: 'BTCUSDT', status: 'FILLED', quantity: 1, filledQuantity: 1 }; } };
  const { engine } = engineWith(exchange, { guard });
  const result = await engine.reconcileOrder({ idempotencyKey: KEY, clientOrderId: KEY, symbol: 'BTCUSDT', quantity: 1, status: 'PARTIALLY_FILLED', filledQuantity: 0.4 });
  assert.equal(result.status, 'FILLED');
  assert.equal(result.filledDelta, 0.6);
  assert.equal(engine.guard.get(KEY).status, 'FILLED');
});

test('ENGINE: an exchange regression is a mismatch and disables trading', async () => {
  const guard = createDuplicateGuard();
  guard.reserve(KEY, { symbol: 'BTCUSDT', quantity: 1, clientOrderId: KEY });
  guard.confirm(KEY, { orderId: 'o-1', status: 'PARTIALLY_FILLED', filledQuantity: 0.4, quantity: 1, symbol: 'BTCUSDT' });

  const exchange = { async getOrder() { return { orderId: 'o-1', symbol: 'BTCUSDT', status: 'PARTIALLY_FILLED', quantity: 1, filledQuantity: 0.2 }; } };
  const { engine, journal } = engineWith(exchange, { guard });

  const reconcile = await engine.reconcileOpenOrders();
  assert.equal(reconcile.tradingEnabled, false);
  assert.equal(reconcile.mismatches.length, 1);
  assert.equal(reconcile.mismatches[0].reason, 'FILLED_QUANTITY_REGRESSION');
  assert.ok(journal.events.some((e) => e.eventType === JOURNAL_EVENT.ORDER_RECONCILE_MISMATCH));
});

test('ENGINE: an unknown order state disables trading until resolved', async () => {
  const guard = createDuplicateGuard();
  guard.reserve(KEY, { symbol: 'BTCUSDT', quantity: 1, clientOrderId: KEY });
  guard.confirm(KEY, { orderId: 'o-1', status: 'NEW', filledQuantity: 0, quantity: 1, symbol: 'BTCUSDT' });

  const exchange = { async getOrder() { return null; } };
  const { engine } = engineWith(exchange, { guard });

  const reconcile = await engine.reconcileOpenOrders();
  assert.equal(reconcile.tradingEnabled, false);
  assert.equal(reconcile.unknowns.length, 1);
  assert.equal(reconcile.reasonCode, 'ORDER_STATE_UNKNOWN');
});

test('ENGINE: a network timeout during reconciliation is undetermined, not success', async () => {
  const guard = createDuplicateGuard();
  guard.reserve(KEY, { symbol: 'BTCUSDT', quantity: 1, clientOrderId: KEY });
  guard.confirm(KEY, { orderId: 'o-1', status: 'NEW', filledQuantity: 0, quantity: 1, symbol: 'BTCUSDT' });

  const exchange = { async getOrder() { throw new NetworkError('timeout'); } };
  const { engine } = engineWith(exchange, { guard, maxQueryAttempts: 2 });

  const reconcile = await engine.reconcileOpenOrders();
  assert.equal(reconcile.tradingEnabled, false);
  assert.equal(reconcile.unknowns.length, 1);
});
