/**
 * Deterministic idempotency keys (MASTER_SPEC §14).
 *
 * The whole point of an idempotency key is that it survives a crash: the same
 * trading intent must hash to the same key before and after a restart, with no
 * clock and no randomness involved. The key is then sent to the exchange as the
 * `clientOrderId` (`orderLinkId` on Bybit), so that after an ambiguous failure
 * the order can be looked up instead of blindly resubmitted.
 *
 * @module reconciliation/idempotency
 */
import { createHash } from 'node:crypto';
import { ValidationError } from '../errors/taxonomy.mjs';

/** Bybit `orderLinkId` allows at most 36 characters; keep a fixed, safe shape. */
export const CLIENT_ORDER_ID_MAX_LENGTH = 36;
/** 24 hex chars = 96 bits of collision resistance, well inside the limit. */
const HASH_LENGTH = 24;
export const IDEMPOTENCY_KEY_PATTERN = /^idem-[0-9a-f]{24}$/;

/**
 * Stable, order-independent serialization of the fields that identify a trade
 * intent. Numbers are normalized so `1` and `1.0` cannot produce different keys.
 *
 * @param {object} intent
 * @returns {string}
 */
export function canonicalIntent(intent) {
  if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new ValidationError('Idempotency intent must be an object', { details: { field: 'intent' } });
  }
  const fields = {};
  for (const key of ['strategyId', 'intentId', 'symbol', 'side', 'type', 'quantity', 'price', 'stopLossPrice', 'takeProfitPrice']) {
    const value = /** @type {Record<string, unknown>} */ (intent)[key];
    if (value === undefined || value === null) continue;
    fields[key] = typeof value === 'number' ? normalizeNumber(value) : value;
  }
  return JSON.stringify(fields, Object.keys(fields).sort());
}

/**
 * @param {number} value
 * @returns {string}
 */
function normalizeNumber(value) {
  return Number(value).toFixed(12);
}

/**
 * Derive the idempotency key for a trade intent.
 *
 * Two genuinely distinct trades must differ by `intentId` (or `strategyId` plus
 * a caller-supplied identifier); two retries of the same trade must not.
 *
 * @param {object} intent
 * @returns {string}
 * @throws {ValidationError}
 */
export function createIdempotencyKey(intent) {
  const canonical = canonicalIntent(intent);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `idem-${digest.slice(0, HASH_LENGTH)}`;
}

/**
 * The exchange-facing client order id for a key. Deterministic, so the same key
 * always yields the same `orderLinkId` and the exchange itself can deduplicate.
 *
 * @param {string} key
 * @returns {string}
 * @throws {ValidationError}
 */
export function createClientOrderId(key) {
  assertIdempotencyKey(key);
  // The key shape is fixed and shorter than the limit, so this is exact.
  return key.slice(0, CLIENT_ORDER_ID_MAX_LENGTH);
}

/**
 * @param {unknown} key
 * @returns {boolean}
 */
export function isIdempotencyKey(key) {
  return typeof key === 'string' && IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * @param {unknown} key
 * @throws {ValidationError}
 */
export function assertIdempotencyKey(key) {
  if (!isIdempotencyKey(key)) {
    throw new ValidationError(`Invalid idempotency key ${JSON.stringify(key)}`, {
      details: { field: 'idempotencyKey', value: key },
    });
  }
}
