/**
 * Pipeline audit log (Phase 2–5).
 *
 * Every stage writes a structured, timestamped, secret-safe record so the whole
 * decision chain — market gathered → scout ideas → guard verdict → user approval
 * → order placed — can be reconstructed and debugged. Uses the project's
 * `createLogger` for redaction and greppable framing.
 *
 * Log lines go to stderr (so they don't mix with Telegram/JSON on stdout) AND,
 * when a file path is provided, as JSONL to that file.
 *
 * @module telegram/pipeline-log
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../util/logger.mjs';

/**
 * @param {{ file?: string }} [options]
 */
export function createPipelineLogger(options = {}) {
  const file = options.file;
  const logger = createLogger('PIPELINE');

  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      /* best effort — in-memory logging still works */
    }
  }

  /**
   * @param {string} stage one of MARKET / SCOUT / GUARD / APPROVE / EXECUTE
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  function record(stage, message, fields = {}) {
    const entry = {
      ts: new Date().toISOString(),
      stage,
      message,
      ...fields,
    };
    logger.info(`[${stage}] ${message}`, fields);
    if (file) {
      try {
        appendFileSync(file, `${JSON.stringify(entry)}\n`);
      } catch {
        /* never break the pipeline over a failed log write */
      }
    }
    return entry;
  }

  return Object.freeze({
    market: (m, f) => record('MARKET', m, f),
    scout: (m, f) => record('SCOUT', m, f),
    guard: (m, f) => record('GUARD', m, f),
    approve: (m, f) => record('APPROVE', m, f),
    execute: (m, f) => record('EXECUTE', m, f),
  });
}
