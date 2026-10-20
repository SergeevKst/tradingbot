/**
 * Phase 9 idempotency + duplicate-guard tests.
 *
 * The key contract: the same intent hashes to the same key with no clock or
 * randomness, and the guard refuses a second submission of a key that has not
 * provably failed.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ValidationError } from '../src/errors/taxonomy.mjs';
import {
  CLIENT_ORDER_ID_MAX_LENGTH,
  assertIdempotencyKey,
  createClientOrderId,
  createIdempotencyKey,
  isIdempotencyKey,
} from '../src/reconciliation/idempotency.mjs';
import { GUARD_STATE, createDuplicateGuard } from '../src/reconciliation/duplicate-guard.mjs';

const INTENT = Object.freeze({
  symbol: 'BTCUSDT',
  side: 'LONG',
  type: 'LIMIT',
  quantity: 0.01,
  price: 50000,
  strategyId: 'trend',
  intentId: 'trade-1',
});

test('IDEMPOTENCY: the same intent always yields the same key', () => {
  const a = createIdempotencyKey(INTENT);
  const b = createIdempotencyKey({ ...INTENT });
  assert.equal(a, b);
  assert.ok(isIdempotencyKey(a));
  assert.ok(a.startsWith('idem-'));
});

test('IDEMPOTENCY: distinct intents yield distinct keys', () => {
  const base = createIdempotencyKey(INTENT);
  assert.notEqual(base, createIdempotencyKey({ ...INTENT, intentId: 'trade-2' }));
  assert.notEqual(base, createIdempotencyKey({ ...INTENT, symbol: 'ETHUSDT' }));
  assert.notEqual(base, createIdempotencyKey({ ...INTENT, side: 'SHORT' }));
});

test('IDEMPOTENCY: numeric representation does not change the key', () => {
  assert.equal(createIdempotencyKey({ ...INTENT, quantity: 1 }), createIdempotencyKey({ ...INTENT, quantity: 1.0 }));
});

test('IDEMPOTENCY: keys are rejected unless well formed', () => {
  assert.throws(() => assertIdempotencyKey('nope'), ValidationError);
  assert.throws(() => assertIdempotencyKey(undefined), ValidationError);
  assert.equal(isIdempotencyKey('idem-nothex'), false);
});

test('IDEMPOTENCY: client order ids are deterministic and exchange-safe', () => {
  const key = createIdempotencyKey(INTENT);
  const clientOrderId = createClientOrderId(key);
  assert.equal(clientOrderId, createClientOrderId(key));
  assert.ok(clientOrderId.length <= CLIENT_ORDER_ID_MAX_LENGTH);
  assert.equal(clientOrderId, key);
});

test('GUARD: a reserved key blocks a second reservation', () => {
  const guard = createDuplicateGuard({ now: () => '2026-10-01T00:00:00.000Z' });
  const key = createIdempotencyKey(INTENT);
  assert.equal(guard.reserve(key, { symbol: 'BTCUSDT' }).reserved, true);
  const second = guard.reserve(key, { symbol: 'BTCUSDT' });
  assert.equal(second.reserved, false);
  assert.equal(second.existing.state, GUARD_STATE.RESERVED);
  assert.equal(guard.blocks(key), true);
});

test('GUARD: a provably failed key may be retried; an unknown one may not', () => {
  const guard = createDuplicateGuard();
  const key = createIdempotencyKey(INTENT);
  guard.reserve(key);
  guard.markFailed(key, { reason: 'VALIDATION_ERROR' });
  assert.equal(guard.blocks(key), false);
  assert.equal(guard.reserve(key).reserved, true);

  const unknownKey = createIdempotencyKey({ ...INTENT, intentId: 'trade-unknown' });
  guard.reserve(unknownKey);
  guard.markUnknown(unknownKey, { reason: 'ORDER_STATE_UNKNOWN' });
  assert.equal(guard.blocks(unknownKey), true);
  assert.equal(guard.reserve(unknownKey).reserved, false);
});

test('GUARD: snapshot/restore survives a restart', () => {
  const guard = createDuplicateGuard();
  const key = createIdempotencyKey(INTENT);
  guard.reserve(key, { symbol: 'BTCUSDT' });
  guard.confirm(key, { orderId: 'o-1', status: 'NEW', filledQuantity: 0 });

  const restored = createDuplicateGuard();
  const count = restored.restore(guard.snapshot());
  assert.equal(count, 1);
  assert.equal(restored.blocks(key), true);
  assert.equal(restored.get(key).orderId, 'o-1');
});
