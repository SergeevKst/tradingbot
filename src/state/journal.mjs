/**
 * Append-only trading journal.
 *
 * Every paper-trading event is written as one JSON object per line (JSONL), so
 * the file can be appended to without parsing it, survives partial writes at the
 * tail, and can be replayed with `readline`. No database dependency: the volume
 * here is a handful of records per trade.
 *
 * The journal is the historical record. It is never rewritten or truncated by
 * normal operation — only `paper:reset`, with an explicit confirmation flag,
 * removes it.
 *
 * @module state/journal
 */
import { ConfigError } from '../config/config-error.mjs';
import { appendLine, ensureDirectory, fileExists, readLines } from './jsonl-file.mjs';

/** The complete set of event types this stage emits. */
export const JOURNAL_EVENT = Object.freeze({
  SIGNAL_RECEIVED: 'SIGNAL_RECEIVED',
  RISK_ACCEPTED: 'RISK_ACCEPTED',
  RISK_REJECTED: 'RISK_REJECTED',
  ORDER_SUBMITTED: 'ORDER_SUBMITTED',
  ORDER_FILLED: 'ORDER_FILLED',
  POSITION_OPENED: 'POSITION_OPENED',
  POSITION_UPDATED: 'POSITION_UPDATED',
  STOP_LOSS_FILLED: 'STOP_LOSS_FILLED',
  TAKE_PROFIT_FILLED: 'TAKE_PROFIT_FILLED',
  POSITION_CLOSED: 'POSITION_CLOSED',
});

/** @type {readonly string[]} */
export const JOURNAL_EVENT_TYPES = Object.freeze(Object.values(JOURNAL_EVENT));

/**
 * @typedef {object} JournalEvent
 * @property {string} timestamp ISO timestamp
 * @property {string} eventType one of JOURNAL_EVENT
 * @property {string | null} symbol
 * @property {string | null} side
 * @property {number | null} quantity
 * @property {number | null} price
 * @property {number | null} pnl
 * @property {number | null} fee
 * @property {string | null} reason reason code or short explanation
 * @property {object} metadata free-form structured detail
 */

/**
 * Build a journal event with every field present (nulls rather than omissions),
 * so downstream consumers can rely on a stable shape.
 *
 * @param {{ eventType: string, timestamp?: string, symbol?: string | null, side?: string | null, quantity?: number | null, price?: number | null, pnl?: number | null, fee?: number | null, reason?: string | null, metadata?: object }} input
 * @returns {JournalEvent}
 */
export function createJournalEvent(input) {
  if (!JOURNAL_EVENT_TYPES.includes(input.eventType)) {
    throw new ConfigError(`Unknown journal eventType ${JSON.stringify(input.eventType)}; expected one of ${JOURNAL_EVENT_TYPES.join(', ')}`, {
      field: 'eventType',
      value: input.eventType,
    });
  }

  return {
    timestamp: input.timestamp ?? new Date().toISOString(),
    eventType: input.eventType,
    symbol: input.symbol ?? null,
    side: input.side ?? null,
    quantity: finite(input.quantity),
    price: finite(input.price),
    pnl: finite(input.pnl),
    fee: finite(input.fee),
    reason: input.reason ?? null,
    metadata: sanitizeMetadata(input.metadata ?? {}),
  };
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finite(value) {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Redact anything that looks like a credential before it reaches the disk.
 *
 * The paper layer never receives secrets, but the journal is long-lived and
 * appending raw metadata is an easy way to leak one later. This is defence in
 * depth, matching the logger's policy.
 *
 * @param {object} metadata
 * @returns {object}
 */
function sanitizeMetadata(metadata) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (/secret|apikey|api_key|password|token|authorization|signature|privatekey|credential/i.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = sanitizeMetadata(/** @type {object} */ (value));
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read every event from a journal file.
 *
 * A malformed *final* line is tolerated (it is the signature of a crash mid
 * append); a malformed line anywhere else means the file is corrupt and throws,
 * because silently skipping records would falsify the trading history.
 *
 * @param {string} filePath
 * @returns {Promise<{ events: JournalEvent[], skippedTail: boolean }>}
 * @throws {ConfigError}
 */
export async function readJournal(filePath) {
  if (!(await fileExists(filePath))) {
    return { events: [], skippedTail: false };
  }

  const lines = await readLines(filePath);
  const events = [];
  let skippedTail = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;

    try {
      const parsed = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.eventType !== 'string') {
        throw new Error('missing eventType');
      }
      events.push(/** @type {JournalEvent} */ (parsed));
    } catch (error) {
      const isLast = index === lines.length - 1;
      if (isLast) {
        skippedTail = true;
        break;
      }
      throw new ConfigError(
        `Journal ${filePath} is corrupt at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        { field: 'journal' },
      );
    }
  }

  return { events, skippedTail };
}

/**
 * Append-only journal writer.
 *
 * @param {{ filePath: string, fs?: object }} options
 * @returns {{
 *   filePath: string,
 *   record: (event: JournalEvent) => Promise<void>,
 *   recordMany: (events: JournalEvent[]) => Promise<void>,
 *   read: () => Promise<{ events: JournalEvent[], skippedTail: boolean }>,
 *   count: () => Promise<number>,
 * }}
 */
export function createJournal(options) {
  if (options === null || typeof options !== 'object' || typeof options.filePath !== 'string') {
    throw new ConfigError('createJournal requires a filePath');
  }
  const filePath = options.filePath;
  const fs = options.fs;

  return {
    filePath,

    /** Append one event. Serialized as a single line; never rewrites history. */
    async record(event) {
      if (event === null || typeof event !== 'object') {
        throw new ConfigError('Journal.record requires an event object');
      }
      if (!JOURNAL_EVENT_TYPES.includes(/** @type {any} */ (event).eventType)) {
        throw new ConfigError(`Journal.record refuses unknown eventType ${JSON.stringify(/** @type {any} */ (event).eventType)}`);
      }
      await ensureDirectory(filePath, fs);
      await appendLine(filePath, JSON.stringify(event), fs);
    },

    async recordMany(events) {
      for (const event of events) {
        await this.record(event);
      }
    },

    async read() {
      return readJournal(filePath);
    },

    async count() {
      const { events } = await readJournal(filePath);
      return events.length;
    },
  };
}