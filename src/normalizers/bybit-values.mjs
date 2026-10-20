/**
 * Shared numeric parsing for the Bybit normalizers.
 *
 * Bybit sends every market number as a decimal string. The core must never see
 * a string and must never see a NaN or Infinity: a value that cannot be parsed
 * becomes a typed `DataError`, so bad exchange data is refused instead of
 * flowing into a strategy or a size calculation.
 *
 * @module normalizers/bybit-values
 */
import { DataError } from '../errors/taxonomy.mjs';
import { parseFiniteNumber } from '../types/primitives.mjs';

/**
 * Parse a finite number, returning null when the value is absent or malformed.
 *
 * @param {unknown} raw
 * @returns {number | null}
 */
export function toFiniteNumber(raw) {
  return parseFiniteNumber(raw);
}

/**
 * Parse a required finite number, refusing anything that is not one.
 *
 * @param {unknown} raw
 * @param {string} field
 * @returns {number}
 * @throws {DataError}
 */
export function requireNumber(raw, field) {
  const value = parseFiniteNumber(raw);
  if (value === null) {
    throw new DataError(`Bybit ${field} must be a finite number, got ${JSON.stringify(raw)}`, {
      details: { field },
    });
  }
  return value;
}

/**
 * Convert any error raised while normalizing an exchange payload into a typed
 * `DataError`, preserving the original as `cause`.
 *
 * Domain constructors throw `ValidationError`; at the exchange boundary the
 * useful classification is "this market data is unusable" (MASTER_SPEC §22).
 *
 * @param {unknown} error
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {DataError}
 */
export function toDataError(error, message, details = {}) {
  if (error instanceof DataError) return error;
  return new DataError(message, {
    details: { ...details, cause: error instanceof Error ? error.message : String(error) },
    cause: error,
  });
}
