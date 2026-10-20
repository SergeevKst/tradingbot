/**
 * LiveSession — the audited boundary around live trading (MASTER_SPEC Phase 10,
 * §46).
 *
 * This is the ONLY session that may be constructed for the live mode, and it is
 * constructed only when `assertLiveReady`-equivalent checks pass. Activation is
 * not a boolean someone flips: construction runs the full §46 gate, records the
 * attempt, the evaluation and the outcome to the append-only journal, and throws
 * on any failure. A refused activation leaves an audit trail.
 *
 * It deliberately does NOT place orders. `LIVE_EXECUTION_IMPLEMENTED` is still
 * false, so `submit()` refuses every request with `LIVE_TRADING_DISABLED` and
 * records the refusal. The session exists to prove live is gated and audited,
 * not to arm it: live trading remains forbidden in this build.
 *
 * @module session/live-session
 */
import { ConfigError } from '../config/config-error.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';
import { LIVE_EXECUTION_IMPLEMENTED } from '../execution/live-guard.mjs';
import { createJournal, createJournalEvent, JOURNAL_EVENT } from '../state/journal.mjs';
import { createEmergencyControls } from '../safety/emergency-controls.mjs';
import { evaluateLiveReadiness } from '../safety/live-gate.mjs';

/** @type {{ info(): void, warn(): void, error(): void, debug(): void }} */
const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

/**
 * @typedef {object} LiveSessionOptions
 * @property {{ enabled?: boolean, mode?: string }} config resolved live config
 * @property {Record<string, unknown>} evidence the thirteen §46 attestations
 * @property {{ live: object, testnet?: object | null, testnetEnabled?: boolean }} credentials
 * @property {import('../config/risk.mjs').RiskLimits} riskConfig
 * @property {unknown} killSwitch operational emergency stop
 * @property {{ journalFile: string }} paths
 * @property {object} [fs] injectable filesystem, for tests
 * @property {() => string} [now] injected clock returning an ISO timestamp
 * @property {object} [logger]
 */

/**
 * Create a live session. Throws unless the §46 gate passes.
 *
 * @param {LiveSessionOptions} options
 * @returns {Promise<Readonly<object>>}
 * @throws {ConfigError}
 */
export async function createLiveSession(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createLiveSession requires options');
  }
  const now = options.now ?? (() => new Date().toISOString());
  const logger = options.logger ?? NOOP_LOGGER;
  const journal = createJournal({ filePath: options.paths?.journalFile, fs: options.fs });

  const gateInput = {
    config: options.config,
    evidence: options.evidence,
    credentials: options.credentials,
    riskConfig: options.riskConfig,
    killSwitch: options.killSwitch,
    journal,
  };

  // The attempt is recorded BEFORE the decision, so even a crash during
  // evaluation cannot hide that live activation was attempted.
  await journal.record(
    createJournalEvent({
      eventType: JOURNAL_EVENT.LIVE_ACTIVATION_ATTEMPTED,
      timestamp: now(),
      metadata: { mode: options.config?.mode ?? 'LIVE' },
    }),
  );

  const decision = evaluateLiveReadiness(gateInput);

  await journal.record(
    createJournalEvent({
      eventType: JOURNAL_EVENT.LIVE_GATE_EVALUATED,
      timestamp: now(),
      reason: decision.reasonCode,
      metadata: {
        allowed: decision.allowed,
        failures: decision.failures.map((item) => ({ id: item.id, code: item.code })),
        checklist: decision.checklist.map((item) => ({ id: item.id, satisfied: item.satisfied })),
        credentialSeparation: decision.credentialSeparation.code,
      },
    }),
  );

  if (!decision.allowed) {
    await journal.record(
      createJournalEvent({
        eventType: JOURNAL_EVENT.LIVE_ACTIVATION_REFUSED,
        timestamp: now(),
        reason: decision.reasonCode,
        metadata: { failures: decision.failures.map((item) => item.code) },
      }),
    );
    logger.warn('LIVE activation refused', { failures: decision.failures.map((item) => item.code) });
    throw new ConfigError(`Live activation refused (${decision.reasonCode}): ${decision.message}`, {
      field: 'LIVE_ENABLED',
      value: decision.failures.map((item) => item.id),
    });
  }

  await journal.record(
    createJournalEvent({
      eventType: JOURNAL_EVENT.LIVE_ACTIVATION_GRANTED,
      timestamp: now(),
      reason: decision.reasonCode,
      // Explicitly recorded: readiness does not mean an execution path exists.
      metadata: { executionImplemented: LIVE_EXECUTION_IMPLEMENTED },
    }),
  );

  const emergency = createEmergencyControls({ killSwitch: options.killSwitch, journal, now, logger });

  return Object.freeze({
    mode: 'LIVE',
    activated: true,
    executionImplemented: LIVE_EXECUTION_IMPLEMENTED,
    journalFile: journal.filePath,

    /** The readiness decision captured at activation. */
    activation: () => decision,

    /** Re-assert readiness. Fails closed if anything regressed or the stop is on. */
    assertCanTrade() {
      const readiness = evaluateLiveReadiness(gateInput);
      if (!readiness.allowed) {
        throw new ConfigError(`LIVE trading is disabled: ${readiness.message}`, {
          field: 'LIVE_ENABLED',
          value: readiness.failures.map((item) => item.id),
        });
      }
      return readiness;
    },

    emergencyState: () => emergency.state(),
    isEmergencyEngaged: () => emergency.isEngaged(),
    engageEmergency: (reason) => emergency.engage(reason),
    releaseEmergency: () => emergency.release(),

    /**
     * Refuse every live order. No live execution path exists in this build and
     * the refusal is audited, so a caller cannot mistake a gate pass for an
     * ability to trade.
     *
     * @param {unknown} [_request] deliberately unused: nothing is executed
     */
    async submit(_request) {
      const readiness = evaluateLiveReadiness(gateInput);
      const reasonCode = readiness.allowed ? REASON_CODE.LIVE_TRADING_DISABLED : readiness.reasonCode;
      const message = readiness.allowed
        ? 'No live execution path exists in this build; the order was not placed'
        : `Live trading is disabled: ${readiness.message}`;

      await journal.record(
        createJournalEvent({
          eventType: JOURNAL_EVENT.LIVE_SUBMIT_REFUSED,
          timestamp: now(),
          reason: reasonCode,
          metadata: { executionImplemented: LIVE_EXECUTION_IMPLEMENTED },
        }),
      );
      logger.warn('LIVE submit refused', { reason: reasonCode });
      return Object.freeze({ approved: false, executed: false, reasonCode, message });
    },
  });
}
