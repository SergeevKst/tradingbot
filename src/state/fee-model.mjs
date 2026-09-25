/**
 * FeeModel — pluggable simulated trading costs.
 *
 * The executor never hardcodes a fee; it asks a model. This keeps the cost
 * assumption visible and configurable, and leaves an obvious seam for a future
 * stage that reads REAL rates from exchange/account data.
 *
 * IMPORTANT: the default rates are SYNTHETIC PLACEHOLDERS chosen to be
 * pessimistic, not Bybit's actual schedule. Nothing here should be quoted as a
 * real fee, and no test asserts that these match any exchange.
 *
 * @module state/fee-model
 */
import { ConfigError } from '../config/config-error.mjs';

/**
 * @typedef {object} FeeModel
 * @property {() => string} kind
 * @property {(input: { notionalUsd: number, price: number, quantity: number, symbol: string }) => number} getEntryFee
 * @property {(input: { notionalUsd: number, price: number, quantity: number, symbol: string }) => number} getExitFee
 * @property {number} entryRate
 * @property {number} exitRate
 */

/**
 * A flat rate-per-notional fee model.
 *
 * @param {{ entryRate?: number, exitRate?: number }} [options]
 * @returns {FeeModel}
 */
export function createRateFeeModel(options = {}) {
  const entryRate = options.entryRate ?? 0.001;
  const exitRate = options.exitRate ?? 0.001;

  for (const [field, value] of Object.entries({ entryRate, exitRate })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new ConfigError(`FeeModel.${field} must be a finite number >= 0, got ${JSON.stringify(value)}`, {
        field,
        value,
      });
    }
  }

  return Object.freeze({
    kind: () => 'rate',
    entryRate,
    exitRate,
    getEntryFee({ notionalUsd }) {
      return charge(notionalUsd, entryRate, 'entry');
    },
    getExitFee({ notionalUsd }) {
      return charge(notionalUsd, exitRate, 'exit');
    },
  });
}

/**
 * A zero-fee model, for isolating PnL arithmetic in tests.
 *
 * @returns {FeeModel}
 */
export function createZeroFeeModel() {
  return Object.freeze({
    kind: () => 'zero',
    entryRate: 0,
    exitRate: 0,
    getEntryFee() {
      return 0;
    },
    getExitFee() {
      return 0;
    },
  });
}

/**
 * @param {number} notionalUsd
 * @param {number} rate
 * @param {string} label
 * @returns {number}
 */
function charge(notionalUsd, rate, label) {
  if (!Number.isFinite(notionalUsd) || notionalUsd < 0) {
    throw new ConfigError(`FeeModel: ${label} notional must be >= 0, got ${JSON.stringify(notionalUsd)}`);
  }
  return notionalUsd * rate;
}

/**
 * @param {unknown} model
 * @returns {FeeModel}
 * @throws {ConfigError}
 */
export function assertFeeModel(model) {
  if (model === null || typeof model !== 'object') {
    throw new ConfigError('FeeModel must be an object');
  }
  for (const method of ['getEntryFee', 'getExitFee', 'kind']) {
    if (typeof /** @type {any} */ (model)[method] !== 'function') {
      throw new ConfigError(`FeeModel.${method}() is required`);
    }
  }
  return /** @type {FeeModel} */ (model);
}