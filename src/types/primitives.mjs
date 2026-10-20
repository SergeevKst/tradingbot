/**
 * Dependency-free validation primitives shared by the domain types.
 *
 * Every domain constructor is CLOSED: unknown fields are rejected and every
 * value is checked before it is frozen. These helpers keep that policy in one
 * place instead of re-implementing it per type, and they throw the typed
 * `ValidationError` from the §22 taxonomy rather than a bare `Error`.
 *
 * @module types/primitives
 */
import { ValidationError } from '../errors/taxonomy.mjs';

/**
 * Parse a finite number, accepting the numeric strings that exchange/JSON
 * payloads frequently carry. Returns null when the value is not finite.
 *
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseFiniteNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** @param {unknown} value */
export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {unknown} value */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {Record<string, unknown>}
 * @throws {ValidationError}
 */
export function assertPlainObject(raw, label) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    const kind = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
    throw new ValidationError(`${label} must be an object, got ${kind}`, { details: { field: label } });
  }
  return /** @type {Record<string, unknown>} */ (raw);
}

/**
 * Reject any field not in the allowed list. Closed schemas are a safety
 * property: a smuggled field must fail, not be silently ignored.
 *
 * @param {Record<string, unknown>} raw
 * @param {readonly string[]} allowed
 * @param {string} label
 * @throws {ValidationError}
 */
export function assertClosedFields(raw, allowed, label) {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ValidationError(`${label} has unknown field(s): ${unknown.join(', ')}`, {
      details: { field: unknown[0], unknown },
    });
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{ maxLength?: number }} [options]
 * @returns {string}
 * @throws {ValidationError}
 */
export function assertRequiredString(value, field, options = {}) {
  if (!isNonEmptyString(value)) {
    throw new ValidationError(`"${field}" must be a non-empty string`, { details: { field, value } });
  }
  const trimmed = /** @type {string} */ (value).trim();
  if (options.maxLength !== undefined && trimmed.length > options.maxLength) {
    throw new ValidationError(`"${field}" must be at most ${options.maxLength} characters`, {
      details: { field, value: trimmed },
    });
  }
  return trimmed;
}

/** Conservative charset for a tradable symbol, matching the proposal schema. */
const SYMBOL_PATTERN = /^[A-Z0-9]{2,30}$/;

/**
 * Normalise and validate a symbol into upper-case.
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string}
 * @throws {ValidationError}
 */
export function assertSymbol(value, field = 'symbol') {
  const symbol = assertRequiredString(value, field).toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw new ValidationError(`"${field}" must match ${SYMBOL_PATTERN} (e.g. "BTCUSDT"), got ${JSON.stringify(value)}`, {
      details: { field, value },
    });
  }
  return symbol;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{ min?: number, max?: number, exclusiveMin?: number, exclusiveMax?: number, integer?: boolean }} [bounds]
 * @returns {number}
 * @throws {ValidationError}
 */
export function assertRequiredNumber(value, field, bounds = {}) {
  const parsed = parseFiniteNumber(value);
  if (parsed === null) {
    throw new ValidationError(`"${field}" must be a finite number, got ${JSON.stringify(value)}`, {
      details: { field, value },
    });
  }
  const { min, max, exclusiveMin, exclusiveMax, integer } = bounds;
  if (integer && !Number.isInteger(parsed)) {
    throw new ValidationError(`"${field}" must be an integer, got ${parsed}`, { details: { field, value: parsed } });
  }
  if (exclusiveMin !== undefined && parsed <= exclusiveMin) {
    throw new ValidationError(`"${field}" must be greater than ${exclusiveMin}, got ${parsed}`, {
      details: { field, value: parsed },
    });
  }
  if (exclusiveMax !== undefined && parsed >= exclusiveMax) {
    throw new ValidationError(`"${field}" must be less than ${exclusiveMax}, got ${parsed}`, {
      details: { field, value: parsed },
    });
  }
  if (min !== undefined && parsed < min) {
    throw new ValidationError(`"${field}" must be >= ${min}, got ${parsed}`, { details: { field, value: parsed } });
  }
  if (max !== undefined && parsed > max) {
    throw new ValidationError(`"${field}" must be <= ${max}, got ${parsed}`, { details: { field, value: parsed } });
  }
  return parsed;
}

/**
 * Like `assertRequiredNumber`, but absent (undefined/null/'') yields undefined.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {{ min?: number, max?: number, exclusiveMin?: number, exclusiveMax?: number, integer?: boolean }} [bounds]
 * @returns {number | undefined}
 * @throws {ValidationError}
 */
export function assertOptionalNumber(value, field, bounds = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  return assertRequiredNumber(value, field, bounds);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} field
 * @param {{ uppercase?: boolean }} [options]
 * @returns {string}
 * @throws {ValidationError}
 */
export function assertEnum(value, allowed, field, options = {}) {
  if (typeof value !== 'string') {
    throw new ValidationError(`"${field}" must be one of: ${allowed.join(', ')} — got ${JSON.stringify(value)}`, {
      details: { field, value },
    });
  }
  const normalized = options.uppercase ? value.trim().toUpperCase() : value.trim();
  if (!allowed.includes(normalized)) {
    throw new ValidationError(`"${field}" must be one of: ${allowed.join(', ')} — got ${JSON.stringify(value)}`, {
      details: { field, value },
    });
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {Record<string, string>} enumObject
 * @param {string} field
 * @param {{ uppercase?: boolean }} [options]
 * @returns {string}
 * @throws {ValidationError}
 */
export function assertEnumValue(value, enumObject, field, options = {}) {
  return assertEnum(value, Object.values(enumObject), field, options);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number} positive epoch milliseconds
 * @throws {ValidationError}
 */
export function assertEpochMillis(value, field) {
  const parsed = parseFiniteNumber(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`"${field}" must be positive epoch milliseconds, got ${JSON.stringify(value)}`, {
      details: { field, value },
    });
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number | undefined}
 * @throws {ValidationError}
 */
export function assertOptionalEpochMillis(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  return assertEpochMillis(value, field);
}

/**
 * Assert a finite number within [0, 1].
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 * @throws {ValidationError}
 */
export function assertUnitInterval(value, field) {
  return assertRequiredNumber(value, field, { min: 0, max: 1 });
}
