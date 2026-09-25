/**
 * Position side.
 *
 * Only directional sides appear here. `FLAT` is deliberately NOT a side of a
 * trade proposal: it describes an intent to hold no exposure, which is not an
 * order, so it must never reach sizing or execution. Modelling exit intent
 * belongs to the execution/position layer in a later stage.
 *
 * @module domain/side
 */
import { ConfigError } from '../config/config-error.mjs';

export const SIDE = Object.freeze({
  LONG: 'LONG',
  SHORT: 'SHORT',
});

/** @type {readonly string[]} */
export const SIDES = Object.freeze(Object.values(SIDE));

/**
 * @param {unknown} value
 * @returns {value is 'LONG' | 'SHORT'}
 */
export function isSide(value) {
  return typeof value === 'string' && SIDES.includes(value);
}

/**
 * @param {unknown} raw
 * @param {{ field?: string }} [options]
 * @returns {'LONG' | 'SHORT'}
 * @throws {ConfigError}
 */
export function resolveSide(raw, options = {}) {
  const field = options.field ?? 'side';
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new ConfigError(`Missing required field "${field}"`, { field, value: raw });
  }
  const value = String(raw).trim().toUpperCase();
  if (!isSide(value)) {
    throw new ConfigError(`Field "${field}" must be one of: ${SIDES.join(', ')} — got ${JSON.stringify(raw)}`, {
      field,
      value: raw,
    });
  }
  return /** @type {'LONG' | 'SHORT'} */ (value);
}

/**
 * Unit direction: +1 for LONG, -1 for SHORT.
 *
 * Used to express both stop/target placement and risk distance with a single
 * formula instead of branching on side everywhere.
 *
 * @param {'LONG' | 'SHORT'} side
 * @returns {1 | -1}
 */
export function sideDirection(side) {
  if (side === SIDE.LONG) return 1;
  if (side === SIDE.SHORT) return -1;
  throw new ConfigError(`Unknown side ${JSON.stringify(side)}`, { field: 'side', value: side });
}