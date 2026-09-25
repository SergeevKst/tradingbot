/**
 * Paper state persistence with FAIL-CLOSED recovery.
 *
 * The requirement this module exists to satisfy: after a restart the account
 * must come back exactly as it was — equity, open positions, `tradesToday`,
 * daily PnL — and it must NEVER silently reappear at the initial 340 USD.
 *
 * The distinction that makes that work is between two very different
 * situations that both technically mean "no usable state on disk":
 *
 *   1. NO state file at all  -> a genuinely new account. Legitimate, and the
 *      initial equity is used.
 *   2. A state file EXISTS but cannot be read, parsed, or validated -> the
 *      account's history is unknown. This is a hard failure. We refuse to
 *      start rather than fabricate a fresh account, because a silent reset
 *      would quietly erase realized losses and re-arm every daily limit.
 *
 * Corrupt state is never deleted or overwritten on the way out — it is left in
 * place for inspection, and the operator must resolve it explicitly.
 *
 * @module state/state-store
 */
import { ConfigError } from '../config/config-error.mjs';
import { readJson, writeJsonAtomic, fileExists, ensureDirectory, removeFile } from './jsonl-file.mjs';
import { validatePaperAccountState } from './paper-account.mjs';
import { validateDailyState } from './daily-state.mjs';

/** Bumped whenever the persisted shape changes incompatibly. */
export const STATE_SCHEMA_VERSION = 1;

/**
 * Raised when persisted state exists but is unusable. Distinguished from other
 * config errors so callers can present a specific, actionable message.
 */
export class CorruptStateError extends Error {
  /**
   * @param {string} message
   * @param {{ filePath?: string, cause?: unknown, detail?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'CorruptStateError';
    this.filePath = options.filePath;
    this.detail = options.detail;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * @typedef {object} PersistedPaperState
 * @property {number} schemaVersion
 * @property {string} savedAt
 * @property {import('./paper-account.mjs').PaperAccountState} account
 * @property {import('./daily-state.mjs').DailyState} daily
 */

/**
 * Validate a deserialized state document.
 *
 * @param {unknown} raw
 * @param {{ filePath?: string }} [options]
 * @returns {PersistedPaperState}
 * @throws {CorruptStateError}
 */
export function validatePersistedState(raw, options = {}) {
  const fail = (detail) => {
    return new CorruptStateError(
      `Paper state is unusable: ${detail}. Refusing to start rather than reset the account. ` +
        'Inspect the file, or reset deliberately with `npm run paper:reset -- --confirm-reset`.',
      { filePath: options.filePath, detail },
    );
  };

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('the file does not contain a JSON object');
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  if (input.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw fail(
      `schemaVersion is ${JSON.stringify(input.schemaVersion)}, but this build expects ${STATE_SCHEMA_VERSION}`,
    );
  }

  let account;
  try {
    account = validatePaperAccountState(input.account);
  } catch (error) {
    throw fail(`the account block is invalid (${error instanceof Error ? error.message : String(error)})`);
  }

  let daily;
  try {
    daily = validateDailyState(input.daily);
  } catch (error) {
    throw fail(`the daily block is invalid (${error instanceof Error ? error.message : String(error)})`);
  }

  // Cross-check: the account and the daily block both carry the day's counters
  // and must agree. A mismatch means one of them was hand-edited or the state
  // was written by two different processes.
  if (account.tradesToday !== daily.tradesToday) {
    throw fail(
      `tradesToday disagrees between the account (${account.tradesToday}) and the daily block (${daily.tradesToday})`,
    );
  }
  if (Math.abs(account.dailyRealizedPnlUsd - daily.dailyRealizedPnlUsd) > 1e-6) {
    throw fail('dailyRealizedPnlUsd disagrees between the account and the daily block');
  }

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    savedAt: typeof input.savedAt === 'string' ? input.savedAt : new Date().toISOString(),
    account,
    daily,
  };
}

/**
 * Load persisted state.
 *
 * @param {{ filePath: string, fs?: object, logger?: { warn: Function, info: Function } }} options
 * @returns {Promise<{ kind: 'fresh' } | { kind: 'restored', state: PersistedPaperState }>}
 * @throws {CorruptStateError}
 */
export async function loadPaperState(options) {
  const { filePath, fs } = options;

  if (!(await fileExists(filePath, fs))) {
    return { kind: 'fresh' };
  }

  let raw;
  try {
    raw = await readJson(filePath, fs);
  } catch (error) {
    throw new CorruptStateError(
      `Paper state exists at ${filePath} but could not be read as JSON: ` +
        `${error instanceof Error ? error.message : String(error)}. Refusing to start rather than reset the account.`,
      { filePath, cause: error },
    );
  }

  // An empty file is corruption, not a fresh account: something created the
  // file and then failed to write it. Resetting here would be exactly the
  // silent 340 USD reset this module exists to prevent.
  if (raw === null) {
    throw new CorruptStateError(
      `Paper state exists at ${filePath} but is empty. Refusing to start rather than reset the account.`,
      { filePath },
    );
  }

  const state = validatePersistedState(raw, { filePath });
  return { kind: 'restored', state };
}

/**
 * Persist state atomically.
 *
 * @param {{ filePath: string, fs?: object }} options
 * @param {{ account: unknown, daily: unknown, savedAt?: string }} state
 * @returns {Promise<string>} the serialized document
 */
export async function savePaperState(options, state) {
  const { filePath, fs } = options;
  const document = {
    schemaVersion: STATE_SCHEMA_VERSION,
    savedAt: state.savedAt ?? new Date().toISOString(),
    account: state.account,
    daily: state.daily,
  };
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  await ensureDirectory(filePath, fs);
  await writeJsonAtomic(filePath, serialized, fs);
  return serialized;
}

/**
 * Delete persisted state. Requires an explicit confirmation flag.
 *
 * The confirmation is checked here, inside the store, not only in the CLI — so
 * no future caller can delete a trading account by accident.
 *
 * @param {{ filePath: string, fs?: object, confirmed: boolean }} options
 * @returns {Promise<boolean>} true when a file was removed
 * @throws {ConfigError} when `confirmed` is not exactly true
 */
export async function resetPaperState(options) {
  if (options.confirmed !== true) {
    throw new ConfigError(
      'resetPaperState requires confirmed === true (CLI: --confirm-reset). Refusing to delete trading state.',
      { field: 'confirmed' },
    );
  }
  const existed = await fileExists(options.filePath, options.fs);
  await removeFile(options.filePath, options.fs);
  return existed;
}

/**
 * A state store bound to a file path.
 *
 * @param {{ filePath: string, fs?: object }} options
 */
export function createStateStore(options) {
  if (options === null || typeof options !== 'object' || typeof options.filePath !== 'string') {
    throw new ConfigError('createStateStore requires a filePath');
  }

  return Object.freeze({
    filePath: options.filePath,

    load() {
      return loadPaperState(options);
    },

    save(state) {
      return savePaperState(options, state);
    },

    reset(confirmed) {
      return resetPaperState({ ...options, confirmed });
    },

    exists() {
      return fileExists(options.filePath, options.fs);
    },
  });
}