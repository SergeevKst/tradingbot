/**
 * Phase 9 restart / recovery tests.
 *
 * A restart must rebuild in-flight order state from the journal, keep refusing
 * duplicates, and refuse to enable trading until the exchange agrees. Every
 * failure mode leaves trading disabled.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { NetworkError } from '../src/errors/taxonomy.mjs';
import { createJournalEvent, JOURNAL_EVENT } from '../src/state/journal.mjs';
import { createDuplicateGuard } from '../src/reconciliation/duplicate-guard.mjs';
import { createIdempotencyKey } from '../src/reconciliation/idempotency.mjs';
import { recoverOrderState, replayOrderEvents, restoreGuard } from '../src/recovery/journal-replay.mjs';
import { createStartupReconciler } from '../src/recovery/startup-reconciler.mjs';
import { createRecoverySession } from '../src/session/recovery-session.mjs';

const INTENT = Object.freeze({
  symbol: 'BTCUSDT',
  side: 'LONG',
  type: 'MARKET',
  quantity: 0.01,
  strategyId: 'trend',
  intentId: 'restart-1',
});
const KEY = createIdempotencyKey(INTENT);
const CLIENT_ID = 'idem-000000000000000000000000';

function event(eventType, fields) {
  return createJournalEvent({ eventType, ...fields });
}

function memoryJournal(seed = []) {
  const events = [...seed];
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

function remoteOrder(overrides = {}) {
  return {
    orderId: 'o-1',
    symbol: 'BTCUSDT',
    side: 'LONG',
    type: 'MARKET',
    status: 'NEW',
    quantity: 0.01,
    filledQuantity: 0,
    averagePrice: undefined,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test('REPLAY: a journal rebuilds reserved, submitted and unknown orders', () => {
  const events = [
    event(JOURNAL_EVENT.ORDER_SUBMIT_ATTEMPTED, {
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: 0.01,
      metadata: { idempotencyKey: KEY, clientOrderId: CLIENT_ID },
    }),
    event(JOURNAL_EVENT.ORDER_SUBMITTED, {
      symbol: 'BTCUSDT',
      metadata: { idempotencyKey: KEY, clientOrderId: CLIENT_ID, orderId: 'o-1', status: 'NEW' },
    }),
    event(JOURNAL_EVENT.ORDER_SUBMIT_ATTEMPTED, {
      symbol: 'ETHUSDT',
      quantity: 0.5,
      metadata: { idempotencyKey: 'idem-aaaaaaaaaaaaaaaaaaaaaaaa', clientOrderId: 'idem-aaaaaaaaaaaaaaaaaaaaaaaa' },
    }),
    event(JOURNAL_EVENT.ORDER_SUBMIT_UNKNOWN, {
      symbol: 'ETHUSDT',
      metadata: { idempotencyKey: 'idem-aaaaaaaaaaaaaaaaaaaaaaaa', clientOrderId: 'idem-aaaaaaaaaaaaaaaaaaaaaaaa' },
    }),
  ];

  const replay = replayOrderEvents(events);
  assert.equal(replay.orders.length, 2);
  assert.equal(replay.byKey.get(KEY).orderId, 'o-1');
  assert.equal(replay.unknownOrders.length, 1);
  assert.equal(replay.openOrders.length, 2, 'both the live and the unknown order stay open');
});

test('REPLAY: repeated attempts of one key are flagged as duplicates', () => {
  const attempt = event(JOURNAL_EVENT.ORDER_SUBMIT_ATTEMPTED, {
    symbol: 'BTCUSDT',
    metadata: { idempotencyKey: KEY, clientOrderId: CLIENT_ID },
  });
  const replay = replayOrderEvents([attempt, attempt, attempt]);
  assert.deepEqual(replay.duplicates, [KEY]);
  assert.equal(replay.orders.length, 1, 'a duplicate attempt must not create a second order');
});

test('REPLAY: terminal orders are not left open', () => {
  const events = [
    event(JOURNAL_EVENT.ORDER_SUBMIT_ATTEMPTED, { symbol: 'BTCUSDT', metadata: { idempotencyKey: KEY, clientOrderId: CLIENT_ID } }),
    event(JOURNAL_EVENT.ORDER_SUBMITTED, { symbol: 'BTCUSDT', metadata: { idempotencyKey: KEY, orderId: 'o-1', status: 'NEW' } }),
    event(JOURNAL_EVENT.ORDER_RECONCILED, {
      symbol: 'BTCUSDT',
      metadata: { idempotencyKey: KEY, orderId: 'o-1', status: 'FILLED', filledQuantity: 0.01 },
    }),
  ];
  const replay = replayOrderEvents(events);
  assert.equal(replay.byKey.get(KEY).status, 'FILLED');
  assert.equal(replay.byKey.get(KEY).filledQuantity, 0.01);
  assert.equal(replay.openOrders.length, 0);
});

test('REPLAY: the guard is rebuilt from the journal and still blocks', () => {
  const replay = replayOrderEvents([
    event(JOURNAL_EVENT.ORDER_SUBMIT_ATTEMPTED, { symbol: 'BTCUSDT', metadata: { idempotencyKey: KEY, clientOrderId: CLIENT_ID } }),
    event(JOURNAL_EVENT.ORDER_SUBMITTED, { symbol: 'BTCUSDT', metadata: { idempotencyKey: KEY, orderId: 'o-1', status: 'NEW' } }),
  ]);
  const guard = createDuplicateGuard();
  assert.equal(restoreGuard(guard, replay), 1);
  assert.equal(guard.reserve(KEY).reserved, false, 'a duplicate after restart must be refused');
});

test('STARTUP: all orders agree -> trading enabled', async () => {
  const journal = memoryJournal([
    event(JOURNAL_EVENT.ORDER_SUBMIT_ATTEMPTED, { symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, metadata: { idempotencyKey: KEY, clientOrderId: CLIENT_ID } }),
    event(JOURNAL_EVENT.ORDER_SUBMITTED, { symbol: 'BTCUSDT', metadata: { idempotencyKey: KEY, orderId: 'o-1', status: 'NEW' } }),
  ]);
  const exchange = {
    async getOrder() {
      return remoteOrder();
    },
    async getWalletBalance() {
      return { balance: 1000 };
    },
    async getPositions() {
      return { list: [] };
    },
    async getOpenOrders() {
      return { list: [] };
    },
    async placeOrder() {
      throw new Error('must not place during recovery');
    },
  };

  const reconciler = createStartupReconciler({ exchange, journal });
  const result = await reconciler.start();
  assert.equal(result.tradingEnabled, true);
  assert.equal(result.reasonCode, 'APPROVED');
  assert.ok(journal.events.some((e) => e.eventType === JOURNAL_EVENT.RECOVERY_COMPLETED));
});

test('STARTUP: an order the exchange cannot confirm disables trading', async () => {
  const journal = memoryJournal([
    event(JOURNAL_EVENT.ORDER_SUBMIT_ATTEMPTED, { symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, metadata: { idempotencyKey: KEY, clientOrderId: CLIENT_ID } }),
  ]);
  const exchange = {
    async getOrder() {
      return null;
    },
  };
  const result = await createStartupReconciler({ exchange, journal }).start();
  assert.equal(result.tradingEnabled, false);
  assert.equal(result.reconcile.unknowns.length, 1);
  assert.ok(journal.events.some((e) => e.eventType === JOURNAL_EVENT.RECOVERY_FAILED));
});

test('STARTUP: a transport failure while fetching state disables trading', async () => {
  const journal = memoryJournal([]);
  const exchange = {
    async getOrder() {
      return null;
    },
    async getOpenOrders() {
      throw new NetworkError('boom');
    },
  };
  const result = await createStartupReconciler({ exchange, journal }).start();
  assert.equal(result.tradingEnabled, false);
  assert.equal(result.reasonCode, 'RECONCILIATION_FAILED');
});

test('RECOVERY SESSION: trades are gated on a successful reconciliation', async () => {
  const journal = memoryJournal([]);
  const okExchange = { async getOrder() { return null; } };
  const session = createRecoverySession({ exchange: okExchange, journal });
  assert.throws(() => session.assertCanTrade(), /disabled/);
  await session.start();
  assert.equal(session.tradingEnabled(), true);
  assert.doesNotThrow(() => session.assertCanTrade());
});
