/**
 * Normalized instrument metadata.
 *
 * The trading core works with THIS shape and never with Bybit's raw payload.
 * Every value is supplied by market data — none is invented or defaulted,
 * because a guessed tickSize silently corrupts order prices.
 *
 * @module market/instrument-info
 */
import { ConfigError } from '../config/config-error.mjs';

/**
 * @typedef {object} InstrumentInfo
 * @property {string} symbol e.g. "BTCUSDT"
 * @property {string} status exchange trading status, e.g. "Trading"
 * @property {string} baseCoin e.g. "BTC"
 * @property {string} quoteCoin e.g. "USDT"
 * @property {string} settleCoin e.g. "USDT"
 * @property {number} tickSize minimum price increment (> 0)
 * @property {number} qtyStep minimum quantity increment (> 0)
 * @property {number} minOrderQty minimum order quantity (> 0)
 * @property {number} maxOrderQty maximum order quantity (>= minOrderQty)
 * @property {number} maxLeverage maximum leverage offered by the exchange
 * @property {number} [minNotionalUsd] minimum order value, when the exchange states it
 * @property {string} receivedAt ISO timestamp of when this metadata was read
 */

/** Instrument statuses that permit trading. */
const TRADABLE_STATUSES = Object.freeze(['Trading']);

/**
 * Deepest decimal step this build supports (1e-12).
 *
 * Real venues publish steps no finer than 1e-8; the bound exists so a garbage
 * value cannot make the search loop long.
 */
const MAX_STEP_DECIMALS = 12;

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: number } | { ok: false, field: string, message: string }}
 */
function positiveNumber(raw, field) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, field, message: 'is required but was not provided' };
  }
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) {
    return { ok: false, field, message: `must be a finite number, got ${JSON.stringify(raw)}` };
  }
  if (value <= 0) {
    return { ok: false, field, message: `must be > 0, got ${value}` };
  }
  return { ok: true, value };
}

/**
 * Validate and freeze instrument metadata.
 *
 * @param {unknown} raw
 * @returns {Readonly<InstrumentInfo>}
 * @throws {ConfigError} when any required field is missing or malformed
 */
export function normalizeInstrumentInfo(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('InstrumentInfo must be an object', { field: 'instrument' });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  for (const field of ['symbol', 'baseCoin', 'quoteCoin', 'settleCoin']) {
    if (typeof input[field] !== 'string' || String(input[field]).trim() === '') {
      throw new ConfigError(`InstrumentInfo.${field} is required and must be a non-empty string`, {
        field: `instrument.${field}`,
        value: input[field],
      });
    }
  }

  const numeric = {};
  for (const field of ['tickSize', 'qtyStep', 'minOrderQty', 'maxOrderQty', 'maxLeverage']) {
    const result = positiveNumber(input[field], `instrument.${field}`);
    if (!result.ok) {
      throw new ConfigError(`InstrumentInfo.${field} ${result.message}`, { field: result.field, value: input[field] });
    }
    numeric[field] = result.value;
  }

  if (numeric.maxOrderQty < numeric.minOrderQty) {
    throw new ConfigError(
      `InstrumentInfo.maxOrderQty (${numeric.maxOrderQty}) must be >= minOrderQty (${numeric.minOrderQty})`,
      { field: 'instrument.maxOrderQty' },
    );
  }

  let minNotionalUsd;
  if (input.minNotionalUsd !== undefined && input.minNotionalUsd !== null && input.minNotionalUsd !== '') {
    const result = positiveNumber(input.minNotionalUsd, 'instrument.minNotionalUsd');
    if (!result.ok) {
      throw new ConfigError(`InstrumentInfo.minNotionalUsd ${result.message}`, { field: result.field });
    }
    minNotionalUsd = result.value;
  }

  return Object.freeze({
    symbol: String(input.symbol).trim().toUpperCase(),
    status: String(input.status ?? 'Trading').trim(),
    baseCoin: String(input.baseCoin).trim().toUpperCase(),
    quoteCoin: String(input.quoteCoin).trim().toUpperCase(),
    settleCoin: String(input.settleCoin).trim().toUpperCase(),
    tickSize: numeric.tickSize,
    qtyStep: numeric.qtyStep,
    minOrderQty: numeric.minOrderQty,
    maxOrderQty: numeric.maxOrderQty,
    maxLeverage: numeric.maxLeverage,
    ...(minNotionalUsd !== undefined ? { minNotionalUsd } : {}),
    receivedAt: typeof input.receivedAt === 'string' ? input.receivedAt : new Date().toISOString(),
  });
}

/**
 * @param {Readonly<InstrumentInfo>} instrument
 * @returns {boolean}
 */
export function isTradableInstrument(instrument) {
  return TRADABLE_STATUSES.includes(instrument.status);
}

/**
 * Number of decimal places implied by a step size (e.g. 0.001 -> 3).
 *
 * Found by searching for the smallest power of ten that makes the step an
 * integer. Deliberately NOT done with `toFixed(18)`, which exposes binary
 * floating-point noise: `(0.1).toFixed(18)` is "0.100000000000000006", which
 * would report 18 decimals and wreck every downstream rounding step.
 *
 * @param {number} step
 * @returns {number}
 * @throws {ConfigError} when the step is not a finite decimal step
 */
export function decimalsForStep(step) {
  if (!Number.isFinite(step) || step <= 0) {
    throw new ConfigError(`Step size must be a positive number, got ${JSON.stringify(step)}`, { field: 'step' });
  }

  for (let decimals = 0; decimals <= MAX_STEP_DECIMALS; decimals += 1) {
    const scaled = step * 10 ** decimals;
    // The scaled value must be a whole number AND at least 1. Without the lower
    // bound, an absolute tolerance would make a step of 1e-16 look like the
    // integer 0 at `decimals = 0` and be misreported as a whole-number step.
    if (scaled >= 1 - 1e-9 && Math.abs(scaled - Math.round(scaled)) <= 1e-9) {
      return decimals;
    }
  }

  throw new ConfigError(
    `Step size ${step} is not a supported decimal step (expected a power-of-ten-scaled value, up to 12 decimals)`,
    { field: 'step', value: step },
  );
}

/**
 * Derive the tickSize/qtyStep shape the Risk Engine's optional `market.instrument`
 * block expects, so exchange constraints flow into sizing checks.
 *
 * @param {Readonly<InstrumentInfo>} instrument
 * @returns {{ symbol: string, tickSize: number, qtyStep: number, minOrderQty: number, maxOrderQty: number, minNotionalUsd?: number }}
 */
export function toRiskInstrumentView(instrument) {
  return {
    symbol: instrument.symbol,
    tickSize: instrument.tickSize,
    qtyStep: instrument.qtyStep,
    minOrderQty: instrument.minOrderQty,
    maxOrderQty: instrument.maxOrderQty,
    ...(instrument.minNotionalUsd !== undefined ? { minNotionalUsd: instrument.minNotionalUsd } : {}),
  };
}