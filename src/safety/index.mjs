/**
 * Live safety layer barrel (MASTER_SPEC Phase 10, §46).
 *
 * Everything exported here exists to keep live trading forbidden until an
 * explicit, fully-attested checklist passes. Importing this module grants no
 * execution capability: it evaluates readiness and audits safety acts only.
 *
 * @module safety
 */
export {
  LIVE_ATTESTATION_CHECKS,
  LIVE_CHECK,
  LIVE_CHECKLIST,
  LIVE_FLAG_CHECK,
  evaluateChecklist,
} from './checklist.mjs';
export {
  CREDENTIAL_SEPARATION,
  SEPARATION_REASON_CODE,
  assertCredentialSeparation,
  checkCredentialSeparation,
} from './credential-separation.mjs';
export { assertLiveReady, evaluateLiveReadiness } from './live-gate.mjs';
export { createEmergencyControls } from './emergency-controls.mjs';
