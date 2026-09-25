/**
 * Daily session state (UTC).
 *
 * Owns the counters that the Risk Engine needs but must not compute itself:
 * `tradesToday`, `dailyRealizedPnlUsd`, `dayStartEquityUsd`.
 *
 * Timezone is explicit and UTC-only in this stage. The machine's local clock
 * must never decide a trading day: two processes in different timezones would
 * otherwise disagree about when limits reset, which is a safety-critical
 * inconsistency rather than a cosmetic one.
 *
 * `now` is injected rather than read from `Date.now()` at the call site so the
 * day-rollover logic is testable without waiting for midnight.
 *
 * @module state/daily-state
 */
import { ConfigError } from '../config/config-error.mjs';

/** @type {readonly string[]} */
export const SUPPORTED_TIMEZONES = Object.freeze(['UTC']);

/**
 * @typedef {object} DailyState
 * @property {string} tradingDay current UTC day, "YYYY-MM-DD"
 * @property {number} tradesToday approved entries taken today
 * @property {number} dailyRealizedPnlUsd realized PnL since the UTC day started
 * @property {number} dayStartEquityUsd equity at the moment the UTC day started
 * @property {string} timezone always "UTC" in this stage
 * @property {string} updatedAt ISO timestamp
 */

/**
 * UTC calendar day for a timestamp, as "YYYY-MM-DD".
 *
 * @param {number | Date} timestamp
 * @returns {string}
 */
export function utcDayKey(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new ConfigError(`utcDayKey: invalid timestamp ${JSON.stringify(timestamp)}`);
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Start a fresh UTC-day session.
 *
 * @param {{ equityUsd: number, timestamp: number | Date, timezone?: string }} input
 * @returns {Readonly<DailyState>}
 */
export function createDailyState(input) {
  const timezone = input.timezone ?? 'UTC';
  if (!SUPPORTED_TIMEZONES.includes(timezone)) {
    throw new ConfigError(`Unsupported session timezone ${JSON.stringify(timezone)}; supported: ${SUPPORTED_TIMEZONES.join(', ')}`, {
      field: 'timezone',
      value: timezone,
    });
  }
  if (!Number.isFinite(input.equityUsd)) {
    throw new ConfigError(`createDailyState: equityUsd must be finite, got ${JSON.stringify(input.equityUsd)}`);
  }

  return Object.freeze({
    tradingDay: utcDayKey(input.timestamp),
    tradesToday: 0,
    dailyRealizedPnlUsd: 0,
    dayStartEquityUsd: input.equityUsd,
    timezone,
    updatedAt: toIso(input.timestamp),
  });
}

/**
 * Advance the daily state to `timestamp`, resetting counters if the UTC day
 * changed.
 *
 * Returns the same object when no rollover occurred, so callers can cheaply
 * detect that nothing happened.
 *
 * @param {Readonly<DailyState>} state
 * @param {{ timestamp: number | Date, equityUsd: number }} input
 * @returns {Readonly<DailyState>}
 */
export function rollDailyStateIfNeeded(state, input) {
  const nextDay = utcDayKey(input.timestamp);
  if (nextDay === state.tradingDay) {
    return state;
  }

  // A new UTC day: counters clear and the day's opening equity is re-based on
  // current equity. Note that equity carries over — only the *day* resets.
  return Object.freeze({
    tradingDay: nextDay,
    tradesToday: 0,
    dailyRealizedPnlUsd: 0,
    dayStartEquityUsd: input.equityUsd,
    timezone: state.timezone,
    updatedAt: toIso(input.timestamp),
  });
}

/**
 * Record a realized result against the current day.
 *
 * @param {Readonly<DailyState>} state
 * @param {{ realizedPnlUsd: number, countTrade?: boolean, timestamp: number | Date }} input
 * @returns {Readonly<DailyState>}
 */
export function recordDailyActivity(state, input) {
  const realizedPnlUsd = Number(input.realizedPnlUsd);
  if (!Number.isFinite(realizedPnlUsd)) {
    throw new ConfigError(`recordDailyActivity: realizedPnlUsd must be finite, got ${JSON.stringify(input.realizedPnlUsd)}`);
  }

  return Object.freeze({
    ...state,
    tradesToday: state.tradesToday + (input.countTrade ? 1 : 0),
    dailyRealizedPnlUsd: state.dailyRealizedPnlUsd + realizedPnlUsd,
    updatedAt: toIso(input.timestamp),
  });
}

/**
 * @param {unknown} raw
 * @returns {Readonly<DailyState>}
 * @throws {ConfigError}
 */
export function validateDailyState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('DailyState must be an object', { field: 'daily' });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  const day = String(input.tradingDay ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new ConfigError(`DailyState.tradingDay must look like YYYY-MM-DD, got ${JSON.stringify(input.tradingDay)}`, {
      field: 'daily.tradingDay',
      value: input.tradingDay,
    });
  }

  const timezone = String(input.timezone ?? 'UTC');
  if (!SUPPORTED_TIMEZONES.includes(timezone)) {
    throw new ConfigError(`DailyState.timezone ${JSON.stringify(timezone)} is not supported`, {
      field: 'daily.timezone',
      value: timezone,
    });
  }

  const numeric = {};
  for (const field of ['tradesToday', 'dailyRealizedPnlUsd', 'dayStartEquityUsd']) {
    const value = Number(input[field]);
    if (!Number.isFinite(value)) {
      throw new ConfigError(`DailyState.${field} must be a finite number, got ${JSON.stringify(input[field])}`, {
        field: `daily.${field}`,
        value: input[field],
      });
    }
    numeric[field] = value;
  }

  if (numeric.tradesToday < 0 || !Number.isInteger(numeric.tradesToday)) {
    throw new ConfigError(`DailyState.tradesToday must be a non-negative integer, got ${numeric.tradesToday}`, {
      field: 'daily.tradesToday',
    });
  }
  if (numeric.dayStartEquityUsd < 0) {
    throw new ConfigError(`DailyState.dayStartEquityUsd must be >= 0, got ${numeric.dayStartEquityUsd}`, {
      field: 'daily.dayStartEquityUsd',
    });
  }

  return Object.freeze({
    tradingDay: day,
    tradesToday: numeric.tradesToday,
    dailyRealizedPnlUsd: numeric.dailyRealizedPnlUsd,
    dayStartEquityUsd: numeric.dayStartEquityUsd,
    timezone,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
  });
}

/**
 * @param {number | Date} timestamp
 * @returns {string}
 */
function toIso(timestamp) {
  return timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
}