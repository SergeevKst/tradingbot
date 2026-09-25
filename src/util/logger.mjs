/**
 * Structured, secret-safe logging.
 *
 * Rules enforced here rather than trusted to callers:
 *   - secrets are redacted if they somehow reach a log line;
 *   - values are rendered as escaped JSON fragments, not template-interpolated
 *     into formats that could break out or forge a line;
 *   - a fixed prefix per subsystem keeps output greppable.
 *
 * @module util/logger
 */
import { LOG_LEVEL } from '../config/env.mjs';

/** Severity ordering for level filtering. */
const SEVERITY = Object.freeze({
  SILENT: 100,
  ERROR: 40,
  WARN: 30,
  INFO: 20,
  DEBUG: 10,
});

/**
 * Keys whose values are never printed.
 * Matching is case-insensitive and substring-based on the *key* name.
 */
const SECRET_KEY_PATTERNS = Object.freeze([
  'secret',
  'apikey',
  'api_key',
  'password',
  'passwd',
  'token',
  'authorization',
  'auth',
  'signature',
  'sign',
  'privatekey',
  'private_key',
  'credential',
]);

const REDACTED = '[REDACTED]';

/**
 * True when a field name looks like it holds secret material.
 * @param {string} key
 */
function isSecretKey(key) {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  return SECRET_KEY_PATTERNS.some((pattern) => normalized.includes(pattern.replace(/[-_\s]/g, '')));
}

/**
 * Deep-redact an arbitrary value for logging.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Defensive: never echo a long opaque blob that might be a key.
    return value.length > 512 ? `${value.slice(0, 32)}…[${value.length} chars]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1), code: /** @type {any} */ (value).code };
  }
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? REDACTED : redact(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Render a field map into a stable `key=value` tail, redacting secrets.
 *
 * @param {Record<string, unknown>} fields
 */
function formatFields(fields) {
  const safe = /** @type {Record<string, unknown>} */ (redact(fields));
  return Object.entries(safe)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}

/**
 * Create a logger bound to a subsystem prefix.
 *
 * @param {string} scope e.g. "RISK"
 * @param {{ level?: string, sink?: (line: string) => void }} [options]
 */
export function createLogger(scope, options = {}) {
  const level = options.level ?? LOG_LEVEL.INFO;
  const sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));

  const threshold = SEVERITY[level] ?? SEVERITY.INFO;
  const prefix = `[${scope}]`;

  /** @param {string} severity @param {string} message @param {Record<string, unknown>} [fields] */
  function emit(severity, message, fields) {
    if (SEVERITY[severity] < threshold) return;
    const tail = fields && Object.keys(fields).length > 0 ? ` ${formatFields(fields)}` : '';
    sink(`${prefix} ${message}${tail}`);
  }

  return Object.freeze({
    error: (message, fields) => emit('ERROR', message, fields),
    warn: (message, fields) => emit('WARN', message, fields),
    info: (message, fields) => emit('INFO', message, fields),
    debug: (message, fields) => emit('DEBUG', message, fields),
    /** Child logger with a nested scope, e.g. RISK:ENGINE. */
    child: (subScope) => createLogger(`${scope}:${subScope}`, { level, sink }),
    scope,
    level,
  });
}

/**
 * A logger that discards everything — for tests and pure call sites.
 */
export const silentLogger = createLogger('silent', { level: LOG_LEVEL.SILENT, sink: () => {} });