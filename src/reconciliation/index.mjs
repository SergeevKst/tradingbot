/**
 * Reconciliation and idempotency layer (MASTER_SPEC §13-15, Phase 9).
 *
 * Pure building blocks plus the injected-exchange engine that makes order
 * submission safe across crashes, timeouts, duplicate attempts and partial
 * fills. Nothing here talks to a real exchange on its own.
 *
 * @module reconciliation
 */
export {
  CLIENT_ORDER_ID_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  assertIdempotencyKey,
  canonicalIntent,
  createClientOrderId,
  createIdempotencyKey,
  isIdempotencyKey,
} from './idempotency.mjs';
export { GUARD_STATE, createDuplicateGuard } from './duplicate-guard.mjs';
export {
  RECONCILE_OUTCOME,
  isResolvedStatus,
  reconcileOrder,
} from './order-reconciler.mjs';
export { FAILURE_DECISION, classifyReadFailure, classifySubmissionFailure } from './failure-policy.mjs';
export {
  QUERY_STATUS,
  createReconciliationEngine,
} from './reconciliation-engine.mjs';
