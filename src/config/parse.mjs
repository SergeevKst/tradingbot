/**
 * Strict environment-variable parsing helpers.
 *
 * Configuration must never guess: a value that is present but malformed is an
 * error, not something to silently replace with a default. Only genuinely
 * absent values (undefined / empty string) fall back to a default.
 */
import { ConfigError } from './config-error.mjs';

/** True when the raw value counts as "not supplied". */
export function isAbsent(raw) {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
}

/**
 * Parse a finite number.
 *
 * @param {unknown} raw
 * @param {{ field: string, fallback?: number, min?: number, max?: number, exclusiveMin?: number, integer?: boolean }} options
 * @returns {number}
 */
export function parseNumber(raw, options) {
  const { field, fallback, min, max, exclusiveMin, integer = false } = options;

  if (isAbsent(raw)) {
    if (fallback === undefined) {
      throw new ConfigError(`Missing required numeric configuration "${field}"`, { field, value: raw });
    }
    return fallback;
  }

  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());

  if (!Number.isFinite(value)) {
    throw new ConfigError(`Configuration "${field}" must be a finite number, got ${JSON.stringify(raw)}`, {
      field,
      value: raw,
    });
  }
  if (integer && !Number.isInteger(value)) {
    throw new ConfigError(`Configuration "${field}" must be an integer, got ${value}`, { field, value: raw });
  }
  if (exclusiveMin !== undefined && value <= exclusiveMin) {
    throw new ConfigError(`Configuration "${field}" must be greater than ${exclusiveMin}, got ${value}`, {
      field,
      value: raw,
    });
  }
  if (min !== undefined && value < min) {
    throw new ConfigError(`Configuration "${field}" must be >= ${min}, got ${value}`, { field, value: raw });
  }
  if (max !== undefined && value > max) {
    throw new ConfigError(`Configuration "${field}" must be <= ${max}, got ${value}`, { field, value: raw });
  }

  return value;
}

/**
 * Parse a boolean from the usual textual spellings.
 *
 * @param {unknown} raw
 * @param {{ field: string, fallback?: boolean }} options
 * @returns {boolean}
 */
export function parseBoolean(raw, options) {
  const { field, fallback } = options;

  if (isAbsent(raw)) {
    if (fallback === undefined) {
      throw new ConfigError(`Missing required boolean configuration "${field}"`, { field, value: raw });
    }
    return fallback;
  }
  if (typeof raw === 'boolean') return raw;

  const value = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;

  throw new ConfigError(`Configuration "${field}" must be a boolean, got ${JSON.stringify(raw)}`, {
    field,
    value: raw,
  });
}

/**
 * Parse a string restricted to a fixed set of allowed values.
 *
 * @param {unknown} raw
 * @param {{ field: string, allowed: readonly string[], fallback?: string, uppercase?: boolean }} options
 * @returns {string}
 */
export function parseEnum(raw, options) {
  const { field, allowed, fallback, uppercase = false } = options;

  if (isAbsent(raw)) {
    if (fallback === undefined) {
      throw new ConfigError(`Missing required configuration "${field}"`, { field, value: raw });
    }
    return fallback;
  }

  const value = uppercase ? String(raw).trim().toUpperCase() : String(raw).trim();
  if (!allowed.includes(value)) {
    throw new ConfigError(
      `Configuration "${field}" must be one of: ${allowed.join(', ')} — got ${JSON.stringify(raw)}`,
      { field, value: raw },
    );
  }
  return value;
}