/**
 * Live emergency controls (MASTER_SPEC Phase 10, §44).
 *
 * The runtime kill switch already exists in `risk/kill-switch.mjs`. This module
 * binds it to the live audit journal: on the live path an emergency action must
 * always leave a record, so engaging or releasing the stop appends a
 * `LIVE_EMERGENCY_*` event before returning. Engagement always succeeds — a
 * missing journal is refused at construction, never at the moment of an
 * emergency.
 *
 * @module safety/emergency-controls
 */
import { ConfigError } from '../config/config-error.mjs';
import { assertKillSwitch } from '../risk/kill-switch.mjs';
import { JOURNAL_EVENT, createJournalEvent } from '../state/journal.mjs';

/** @type {{ info(): void, warn(): void, error(): void, debug(): void }} */
const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

/**
 * @typedef {object} EmergencyControlsOptions
 * @property {unknown} killSwitch the operational emergency stop
 * @property {{ record: (event: object) => Promise<void> }} journal append-only audit sink
 * @property {() => string} [now] injected clock returning an ISO timestamp
 * @property {object} [logger]
 */

/**
 * Create audited emergency controls for the live path.
 *
 * @param {EmergencyControlsOptions} options
 * @returns {Readonly<{
 *   state: () => { engaged: boolean, reason: string | null, engagedAt: string | null },
 *   isEngaged: () => boolean,
 *   engage: (reason?: string) => Promise<{ engaged: boolean, reason: string | null, engagedAt: string | null }>,
 *   release: () => Promise<{ engaged: boolean, reason: string | null, engagedAt: string | null }>,
 * }>}
 * @throws {ConfigError} when the kill switch or journal is missing or malformed
 */
export function createEmergencyControls(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createEmergencyControls requires an options object');
  }
  const killSwitch = assertKillSwitch(options.killSwitch);
  const journal = options.journal;
  if (journal === null || typeof journal !== 'object' || typeof journal.record !== 'function') {
    throw new ConfigError('createEmergencyControls requires an append-only journal; live is never unaudited');
  }
  const now = options.now ?? (() => new Date().toISOString());
  const logger = options.logger ?? NOOP_LOGGER;

  return Object.freeze({
    state: () => killSwitch.snapshot(),
    isEngaged: () => killSwitch.isEngaged(),

    /** Engage the stop and record it. Engagement always succeeds. */
    async engage(reason) {
      const state = killSwitch.engage(reason);
      await journal.record(
        createJournalEvent({
          eventType: JOURNAL_EVENT.LIVE_EMERGENCY_ENGAGED,
          timestamp: now(),
          reason: state.reason,
          metadata: { engaged: state.engaged, engagedAt: state.engagedAt },
        }),
      );
      logger.warn('LIVE emergency stop engaged', { reason: state.reason });
      return state;
    },

    /** Release the stop and record it. This is the only path back to trading. */
    async release() {
      const state = killSwitch.disengage();
      await journal.record(
        createJournalEvent({
          eventType: JOURNAL_EVENT.LIVE_EMERGENCY_RELEASED,
          timestamp: now(),
          metadata: { engaged: state.engaged },
        }),
      );
      logger.info('LIVE emergency stop released', {});
      return state;
    },
  });
}
