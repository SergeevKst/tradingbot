/**
 * Recovery layer (MASTER_SPEC §14-15, Phase 9).
 *
 * Deterministic restart state reload from the journal, plus the fail-closed
 * startup reconciliation gate that keeps trading disabled until local and
 * exchange state agree.
 *
 * @module recovery
 */
export { recoverOrderState, replayOrderEvents, restoreGuard } from './journal-replay.mjs';
export { createStartupReconciler } from './startup-reconciler.mjs';
