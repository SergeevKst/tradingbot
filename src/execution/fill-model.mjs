/**
 * FillModel — pluggable, deterministic simulated fill sizing.
 *
 * The paper executor never hardcodes how much of an order fills; it asks a
 * model. This mirrors `fee-model.mjs` and keeps the liquidity assumption
 * visible, configurable and testable. Nothing here talks to an exchange.
 *
 * Contract
 * --------
 *   resolveFill({ requestedQuantity, price, symbol, side, stage, instrument })
 *     -> { filledQuantity, unfilledQuantity, partial, reason }
 *
 * `filledQuantity` must be in [0, requestedQuantity]. A model may fill the whole
 * order (the default), a step-aligned fraction of it, or nothing. A partial fill
 * is deterministic: the same inputs always produce the same split, so a replay
 * of the journal reproduces the same account.
 *
 * A market order with insufficient simulated liquidity partially fills and the
 * remainder is cancelled (no resting order), which is exactly what a taker order
 * does. The unfilled remainder is reported on the fill and in the journal.
 *
 * @module execution/fill-model
 */
import { ConfigError } from '../config/config-error.mjs';
import { normalizeQuantity } from '../market/normalize.mjs';

/**
 * @typedef {object} FillRequest
 * @property {number} requestedQuantity already normalized to the instrument qtyStep
 * @property {number} price simulated fill price
 * @property {string} symbol
 * @property {'LONG' | 'SHORT'} side
 * @property {'entry' | 'exit'} stage
 * @property {Readonly<{ qtyStep: number, minOrderQty: number, maxOrderQty: number }>} instrument
 */

/**
 * @typedef {object} FillDecision
 * @property {number} filledQuantity
 * @property {number} unfilledQuantity
 * @property {boolean} partial
 * @property {string | null} reason
 */

/**
 * @typedef {object} FillModel
 * @property {() => string} kind
 * @property {(request: FillRequest) => FillDecision} resolveFill
 */

/**
 * The default: every requested unit fills. Preserves the original paper
 * behaviour and keeps the simulation free of an unstated liquidity assumption.
 *
 * @returns {FillModel}
 */
export function createFullFillModel() {
  return Object.freeze({
    kind: () => 'full',
    resolveFill({ requestedQuantity }) {
      return {
        filledQuantity: requestedQuantity,
        unfilledQuantity: 0,
        partial: false,
        reason: null,
      };
    },
  });
}

/**
 * A deterministic liquidity cap: no single market fill may exceed a fixed
 * notional. Anything beyond the cap is left unfilled (and cancelled).
 *
 * The cap is expressed in quote (USD) terms so it is independent of price. The
 * filled quantity is floored to the instrument's qtyStep, so it is always a
 * tradable size; the adapter independently refuses a fill below the instrument
 * minimum rather than inventing a micro-order.
 *
 * @param {{ maxNotionalPerFillUsd: number }} options
 * @returns {FillModel}
 */
export function createNotionalCapFillModel(options) {
  const maxNotionalPerFillUsd = options?.maxNotionalPerFillUsd;
  if (!Number.isFinite(maxNotionalPerFillUsd) || maxNotionalPerFillUsd <= 0) {
    throw new ConfigError(
      `FillModel.maxNotionalPerFillUsd must be a finite number > 0, got ${JSON.stringify(maxNotionalPerFillUsd)}`,
      { field: 'maxNotionalPerFillUsd', value: maxNotionalPerFillUsd },
    );
  }

  return Object.freeze({
    kind: () => 'notional-cap',
    maxNotionalPerFillUsd,

    resolveFill({ requestedQuantity, price, instrument }) {
      const capQuantity = maxNotionalPerFillUsd / price;

      // The cap does not bind: the whole order fills, as in the full model.
      if (capQuantity >= requestedQuantity) {
        return { filledQuantity: requestedQuantity, unfilledQuantity: 0, partial: false, reason: null };
      }

      const step = instrument?.qtyStep;
      if (!Number.isFinite(step) || step <= 0) {
        // Fail closed: a partial-fill model without a step cannot produce a
        // tradable size, and guessing one would be worse than refusing.
        throw new ConfigError('createNotionalCapFillModel requires instrument.qtyStep to size a partial fill', {
          field: 'instrument.qtyStep',
        });
      }

      const normalized = normalizeQuantity(capQuantity, step);
      if (!normalized.ok || normalized.value === null) {
        return { filledQuantity: 0, unfilledQuantity: requestedQuantity, partial: true, reason: 'NO_TRADABLE_FILL' };
      }

      const filledQuantity = normalized.value;
      if (filledQuantity >= requestedQuantity) {
        return { filledQuantity: requestedQuantity, unfilledQuantity: 0, partial: false, reason: null };
      }

      return {
        filledQuantity,
        unfilledQuantity: requestedQuantity - filledQuantity,
        partial: true,
        reason: 'LIQUIDITY_CAPPED',
      };
    },
  });
}

/**
 * @param {unknown} model
 * @returns {FillModel}
 * @throws {ConfigError}
 */
export function assertFillModel(model) {
  if (model === null || typeof model !== 'object') {
    throw new ConfigError('FillModel must be an object');
  }
  if (typeof /** @type {any} */ (model).resolveFill !== 'function') {
    throw new ConfigError('FillModel.resolveFill() is required');
  }
  if (typeof /** @type {any} */ (model).kind !== 'function') {
    throw new ConfigError('FillModel.kind() is required');
  }
  return /** @type {FillModel} */ (model);
}
