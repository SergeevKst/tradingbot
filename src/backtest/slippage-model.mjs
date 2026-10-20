/**
 * SlippageModel — pluggable, deterministic simulated market impact.
 *
 * A backtest that ignores slippage reports a strategy the market would never
 * have let you execute. This module makes the assumption explicit and
 * configurable, exactly like `fee-model.mjs` and `fill-model.mjs` do for their
 * costs. It models impact the only way an OHLC bar lets us: it widens the
 * executable book adversarially, so a BUY pays more and a SELL receives less.
 *
 * The model never invents liquidity and never touches an exchange; it only
 * adjusts the synthetic bid/ask the simulator presents to the (unchanged) paper
 * executor.
 *
 * @module backtest/slippage-model
 */
import { ConfigError } from '../config/config-error.mjs';

/**
 * @typedef {object} SlippageBook
 * @property {number} mid the reference (mark/last) price the book is centred on
 * @property {number} bid best bid before impact
 * @property {number} ask best ask before impact
 */

/**
 * @typedef {object} SlippageModel
 * @property {() => string} kind
 * @property {(book: SlippageBook) => { bid: number, ask: number }} adjustBook
 */

/**
 * No simulated market impact. The raw spread still applies; this only removes
 * the additional slippage term.
 *
 * @returns {SlippageModel}
 */
export function createZeroSlippageModel() {
  return Object.freeze({
    kind: () => 'zero',
    rate: 0,
    adjustBook({ bid, ask }) {
      return { bid, ask };
    },
  });
}

/**
 * A flat adverse rate applied to the price on both sides of the book.
 *
 * `rate` is a fraction of the reference price (0.0005 = 5 bps). A BUY fills
 * `rate` above the un-impacted ask; a SELL fills `rate` below the un-impacted
 * bid. Widening both sides is the pessimistic convention: whichever way the
 * position turns out to trade, it pays the impact.
 *
 * @param {{ rate?: number }} [options]
 * @returns {SlippageModel}
 */
export function createRateSlippageModel(options = {}) {
  const rate = options.rate ?? 0.0005;
  if (!Number.isFinite(rate) || rate < 0) {
    throw new ConfigError(`SlippageModel.rate must be a finite number >= 0, got ${JSON.stringify(rate)}`, {
      field: 'rate',
      value: rate,
    });
  }

  return Object.freeze({
    kind: () => 'rate',
    rate,
    adjustBook({ mid, bid, ask }) {
      if (!Number.isFinite(mid) || mid <= 0) {
        throw new ConfigError(`SlippageModel: mid must be > 0, got ${JSON.stringify(mid)}`, { field: 'mid', value: mid });
      }
      const shift = mid * rate;
      return {
        // A book side may not cross zero; prices are bounded below by a hair.
        bid: Math.max(bid - shift, mid * 1e-9),
        ask: ask + shift,
      };
    },
  });
}

/**
 * @param {unknown} model
 * @returns {SlippageModel}
 * @throws {ConfigError}
 */
export function assertSlippageModel(model) {
  if (model === null || typeof model !== 'object') {
    throw new ConfigError('SlippageModel must be an object');
  }
  if (typeof /** @type {any} */ (model).adjustBook !== 'function') {
    throw new ConfigError('SlippageModel.adjustBook() is required');
  }
  if (typeof /** @type {any} */ (model).kind !== 'function') {
    throw new ConfigError('SlippageModel.kind() is required');
  }
  return /** @type {SlippageModel} */ (model);
}
