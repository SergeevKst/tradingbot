/**
 * Deterministic price/quantity normalization.
 *
 * Order prices and sizes must land exactly on the exchange's tick/step grid, and
 * must never be nudged by floating-point noise or a generic `toFixed`. All
 * arithmetic here converts through integer "step counts" so the result is exact
 * for the decimal steps exchanges actually use (1e-1 … 1e-8).
 *
 * Every function is pure and side-effect free.
 *
 * @module market/normalize
 */
import { ConfigError } from '../config/config-error.mjs';
import { decimalsForStep } from './instrument-info.mjs';

/**
 * Scale factor as an exact power of ten, avoiding `Math.pow` rounding surprises
 * where the exact value is representable.
 *
 * @param {number} decimals
 * @returns {number}
 */
function scaleFactor(decimals) {
  return Number(`1e${decimals}`);
}

/**
 * @typedef {object} NormalizeResult
 * @property {boolean} ok
 * @property {number | null} value normalized value (null when ok is false)
 * @property {string | null} reason why normalization failed
 */

/**
 * Snap a price DOWN to the nearest valid tick.
 *
 * Rounding direction is explicit and conservative rather than "nearest": for a
 * limit price, rounding toward the market is the safe direction, and a
 * documented rule beats `Math.round` behaviour at .5 boundaries.
 *
 * @param {number} price
 * @param {number} tickSize
 * @returns {NormalizeResult}
 */
export function normalizePrice(price, tickSize) {
  return snapDown(price, tickSize, 'price');
}

/**
 * Snap a quantity DOWN to the nearest valid step.
 *
 * Sizing is rounded down on purpose: rounding a size *up* would risk more money
 * than the Risk Engine approved, which would break the guarantee that a stop-out
 * costs at most `riskAmountUsd`.
 *
 * @param {number} quantity
 * @param {number} qtyStep
 * @returns {NormalizeResult}
 */
export function normalizeQuantity(quantity, qtyStep) {
  return snapDown(quantity, qtyStep, 'quantity');
}

/**
 * @param {number} value
 * @param {number} step
 * @param {string} label
 * @returns {NormalizeResult}
 */
function snapDown(value, step, label) {
  if (!Number.isFinite(value)) {
    return { ok: false, value: null, reason: `${label} must be a finite number, got ${JSON.stringify(value)}` };
  }
  if (!Number.isFinite(step) || step <= 0) {
    return { ok: false, value: null, reason: `step must be a positive finite number, got ${JSON.stringify(step)}` };
  }
  if (value <= 0) {
    return { ok: false, value: null, reason: `${label} must be > 0, got ${value}` };
  }

  let decimals;
  try {
    decimals = decimalsForStep(step);
  } catch (error) {
    return { ok: false, value: null, reason: error instanceof Error ? error.message : 'unsupported step size' };
  }

  const factor = scaleFactor(decimals);
  const stepUnits = Math.round(step * factor);

  // Work in integer step units so the result is exact. The tolerance is
  // relative, not absolute: 0.3 * 10 is 2.9999999999999996 in binary, and an
  // absolute epsilon large enough to fix that would also swallow genuine
  // differences at large magnitudes.
  const scaled = value * factor;
  const tolerance = Math.max(1e-9, Math.abs(scaled) * 1e-12);
  const valueUnits = Math.floor(scaled + tolerance);
  const snappedUnits = Math.floor(valueUnits / stepUnits) * stepUnits;

  if (snappedUnits <= 0) {
    return { ok: false, value: null, reason: `${label} ${value} is smaller than one step ${step}` };
  }

  const result = snappedUnits / factor;
  if (!Number.isFinite(result) || result <= 0) {
    return { ok: false, value: null, reason: `${label} normalized to a non-positive value` };
  }
  return { ok: true, value: result, reason: null };
}

/**
 * @typedef {object} StepValidation
 * @property {boolean} valid
 * @property {string | null} reason
 */

/**
 * Check that a price already lies exactly on the tick grid.
 *
 * @param {number} price
 * @param {number} tickSize
 * @returns {StepValidation}
 */
export function validatePriceStep(price, tickSize) {
  return validateStep(price, tickSize, 'price');
}

/**
 * Check that a quantity already lies exactly on the step grid.
 *
 * @param {number} quantity
 * @param {number} qtyStep
 * @returns {StepValidation}
 */
export function validateQuantityStep(quantity, qtyStep) {
  return validateStep(quantity, qtyStep, 'quantity');
}

/**
 * @param {number} value
 * @param {number} step
 * @param {string} label
 * @returns {StepValidation}
 */
function validateStep(value, step, label) {
  if (!Number.isFinite(value) || value <= 0) {
    return { valid: false, reason: `${label} must be a positive finite number, got ${JSON.stringify(value)}` };
  }
  if (!Number.isFinite(step) || step <= 0) {
    return { valid: false, reason: `step must be a positive finite number, got ${JSON.stringify(step)}` };
  }

  let decimals;
  try {
    decimals = decimalsForStep(step);
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'unsupported step size' };
  }

  const factor = scaleFactor(decimals);
  const stepUnits = Math.round(step * factor);

  // Compare in integer units with a relative tolerance, so a value like 86000.1
  // (stored as 86000.09999999999) is still recognized as exactly "860001 ticks".
  const scaled = value * factor;
  const tolerance = Math.max(1e-6, Math.abs(scaled) * 1e-9);
  const nearestUnits = Math.round(scaled);

  if (Math.abs(scaled - nearestUnits) > tolerance) {
    return { valid: false, reason: `${label} ${value} is finer than the step ${step}` };
  }
  if (nearestUnits % stepUnits !== 0) {
    return { valid: false, reason: `${label} ${value} is not a multiple of the step ${step}` };
  }
  return { valid: true, reason: null };
}

/**
 * @typedef {object} OrderSizeValidation
 * @property {boolean} valid
 * @property {string | null} reason
 */

/**
 * Validate a quantity against order-size limits.
 *
 * @param {number} quantity
 * @param {{ qtyStep: number, minOrderQty: number, maxOrderQty: number }} instrument
 * @returns {OrderSizeValidation}
 */
export function validateOrderQuantity(quantity, instrument) {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { valid: false, reason: `quantity must be > 0, got ${JSON.stringify(quantity)}` };
  }

  const stepCheck = validateQuantityStep(quantity, instrument.qtyStep);
  if (!stepCheck.valid) return stepCheck;

  if (quantity < instrument.minOrderQty) {
    return { valid: false, reason: `quantity ${quantity} is below minOrderQty ${instrument.minOrderQty}` };
  }
  if (quantity > instrument.maxOrderQty) {
    return { valid: false, reason: `quantity ${quantity} exceeds maxOrderQty ${instrument.maxOrderQty}` };
  }
  return { valid: true, reason: null };
}

/**
 * Validate a price against the tick grid and the exchange's price bounds.
 *
 * @param {number} price
 * @param {Readonly<{ tickSize: number, minPrice?: number, maxPrice?: number }>} instrument
 * @returns {OrderSizeValidation}
 */
export function validateOrderPrice(price, instrument) {
  if (!Number.isFinite(price) || price <= 0) {
    return { valid: false, reason: `price must be > 0, got ${JSON.stringify(price)}` };
  }

  const stepCheck = validatePriceStep(price, instrument.tickSize);
  if (!stepCheck.valid) return stepCheck;

  if (Number.isFinite(instrument.minPrice) && price < /** @type {number} */ (instrument.minPrice)) {
    return { valid: false, reason: `price ${price} is below minPrice ${instrument.minPrice}` };
  }
  if (Number.isFinite(instrument.maxPrice) && price > /** @type {number} */ (instrument.maxPrice)) {
    return { valid: false, reason: `price ${price} exceeds maxPrice ${instrument.maxPrice}` };
  }
  return { valid: true, reason: null };
}

/**
 * Validate a notional against the instrument minimum.
 *
 * @param {number} notionalUsd
 * @param {{ minNotionalUsd?: number }} instrument
 * @returns {OrderSizeValidation}
 */
export function validateNotional(notionalUsd, instrument) {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
    return { valid: false, reason: `notional must be > 0, got ${JSON.stringify(notionalUsd)}` };
  }
  if (Number.isFinite(instrument.minNotionalUsd) && notionalUsd < /** @type {number} */ (instrument.minNotionalUsd) - 1e-9) {
    return {
      valid: false,
      reason: `notional ${notionalUsd} is below the instrument minimum ${instrument.minNotionalUsd}`,
    };
  }
  return { valid: true, reason: null };
}

/**
 * Convenience: normalize a quantity and report why it failed, if it did.
 *
 * @param {number} quantity
 * @param {Readonly<{ qtyStep: number, minOrderQty: number, maxOrderQty: number }>} instrument
 * @returns {{ ok: true, quantity: number } | { ok: false, reason: string }}
 */
export function normalizeAndValidateQuantity(quantity, instrument) {
  const normalized = normalizeQuantity(quantity, instrument.qtyStep);
  if (!normalized.ok || normalized.value === null) {
    return { ok: false, reason: normalized.reason ?? 'quantity normalization failed' };
  }
  const validation = validateOrderQuantity(normalized.value, instrument);
  if (!validation.valid) {
    return { ok: false, reason: validation.reason ?? 'quantity validation failed' };
  }
  return { ok: true, quantity: normalized.value };
}

export { ConfigError };