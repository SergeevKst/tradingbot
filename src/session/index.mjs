/**
 * Session layer — wires proposal -> risk -> paper execution -> persistence,
 * and gates resumption on startup order reconciliation (MASTER_SPEC §15).
 * @module session
 */
export * from './paper-session.mjs';
export * from './testnet-session.mjs';
export * from './trading-session.mjs';
export * from './recovery-session.mjs';
// `session/live-session.mjs` is deliberately NOT re-exported here: importing this
// barrel must never pull the live boundary (or its live-credential types) into a
// non-live path. Live code is reached only by direct import, behind the §46 gate.