/**
 * Duplicate order prevention (MASTER_SPEC §13-14).
 *
 * An in-memory ledger of order intents, keyed by idempotency key. The contract
 * is at-most-once submission: once a key is RESERVED, a second submission of the
 * same intent is refused until the first is provably FAILED (never reached the
 * exchange). UNKNOWN keys are never released automatically — that is precisely
 * the state reconciliation exists to resolve.
 *
 * The ledger is pure and snapshot/restorable so a restart can rebuild it from
 * the journal and keep refusing duplicates across process boundaries.
 *
 * @module reconciliation/duplicate-guard
 */
import { ValidationError } from '../errors/taxonomy.mjs';
import { assertIdempotencyKey } from './idempotency.mjs';

/** Resolved outcomes a key can hold. `RESERVED` means submission is in flight. */
export const GUARD_STATE = Object.freeze({
  RESERVED: 'RESERVED',
  SUBMITTED: 'SUBMITTED',
  UNKNOWN: 'UNKNOWN',
  FAILED: 'FAILED',
});

/** States that block a retry of the same key. */
const BLOCKING = Object.freeze([GUARD_STATE.RESERVED, GUARD_STATE.SUBMITTED, GUARD_STATE.UNKNOWN]);

/**
 * @param {{ now?: () => string }} [options]
 */
export function createDuplicateGuard(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  /** @type {Map<string, object>} */
  const ledger = new Map();

  /**
   * @param {object} meta
   * @param {string} state
   */
  function record(meta, state) {
    const existing = ledger.get(meta.idempotencyKey);
    return Object.freeze({
      ...(existing ?? {}),
      ...meta,
      state,
      updatedAt: now(),
    });
  }

  return {
    /**
     * Claim a key before submission. Returns `{ reserved: false, existing }` when
     * the intent was already claimed and not provably failed.
     *
     * @param {string} idempotencyKey
     * @param {object} [meta]
     * @returns {{ reserved: boolean, existing?: object }}
     */
    reserve(idempotencyKey, meta = {}) {
      assertIdempotencyKey(idempotencyKey);
      const existing = ledger.get(idempotencyKey);
      if (existing !== undefined && BLOCKING.includes(existing.state)) {
        return { reserved: false, existing };
      }
      ledger.set(idempotencyKey, record({ ...meta, idempotencyKey }, GUARD_STATE.RESERVED));
      return { reserved: true };
    },

    /**
     * Record an exchange-confirmed order.
     *
     * @param {string} idempotencyKey
     * @param {object} [order]
     * @returns {object}
     */
    confirm(idempotencyKey, order = {}) {
      assertIdempotencyKey(idempotencyKey);
      const next = record({ ...order, idempotencyKey }, GUARD_STATE.SUBMITTED);
      ledger.set(idempotencyKey, next);
      return next;
    },

    /**
     * Record a submission whose outcome is unknown (ambiguous failure).
     *
     * @param {string} idempotencyKey
     * @param {object} [meta]
     * @returns {object}
     */
    markUnknown(idempotencyKey, meta = {}) {
      assertIdempotencyKey(idempotencyKey);
      const next = record({ ...meta, idempotencyKey }, GUARD_STATE.UNKNOWN);
      ledger.set(idempotencyKey, next);
      return next;
    },

    /**
     * Record a submission that provably never reached the exchange. The key is
     * released for a future retry.
     *
     * @param {string} idempotencyKey
     * @param {{ reason?: string }} [meta]
     * @returns {object}
     */
    markFailed(idempotencyKey, meta = {}) {
      assertIdempotencyKey(idempotencyKey);
      const next = record({ ...meta, idempotencyKey }, GUARD_STATE.FAILED);
      ledger.set(idempotencyKey, next);
      return next;
    },

    /**
     * Update a tracked record in place (used by reconciliation).
     *
     * @param {string} idempotencyKey
     * @param {object} patch
     * @returns {object | undefined}
     */
    update(idempotencyKey, patch) {
      assertIdempotencyKey(idempotencyKey);
      const existing = ledger.get(idempotencyKey);
      if (existing === undefined) return undefined;
      const next = Object.freeze({ ...existing, ...patch, idempotencyKey, updatedAt: now() });
      ledger.set(idempotencyKey, next);
      return next;
    },

    /** @param {string} idempotencyKey */
    get(idempotencyKey) {
      return ledger.get(idempotencyKey);
    },

    /** @param {string} idempotencyKey */
    has(idempotencyKey) {
      return ledger.has(idempotencyKey);
    },

    /** True when a key exists and would block a resubmission. */
    blocks(idempotencyKey) {
      const existing = ledger.get(idempotencyKey);
      return existing !== undefined && BLOCKING.includes(existing.state);
    },

    /** @returns {object[]} every record, in insertion order */
    entries() {
      return [...ledger.values()];
    },

    size() {
      return ledger.size;
    },

    /** Synchronous snapshot for persistence in a state file. */
    snapshot() {
      return [...ledger.values()];
    },

    /**
     * Rebuild the ledger from a snapshot. Deterministic: later records win.
     *
     * @param {object[]} records
     */
    restore(records) {
      if (!Array.isArray(records)) {
        throw new ValidationError('duplicate guard restore requires an array', { details: { field: 'records' } });
      }
      for (const entry of records) {
        if (entry === null || typeof entry !== 'object' || typeof entry.idempotencyKey !== 'string') continue;
        if (!/^idem-[0-9a-f]{24}$/.test(entry.idempotencyKey)) continue;
        if (!Object.values(GUARD_STATE).includes(entry.state)) continue;
        ledger.set(entry.idempotencyKey, Object.freeze({ ...entry }));
      }
      return ledger.size;
    },
  };
}
