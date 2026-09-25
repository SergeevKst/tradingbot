/**
 * MarketState — the market context a proposal is evaluated against.
 *
 * Stage 1 uses a deliberately small surface: instrument constraints that affect
 * whether a sized position is even representable, and the current mark price
 * used to sanity-check that an entry is not absurdly far from the market.
 *
 * Nothing here is fetched by the Risk Engine — market data belongs to the
 * Market Data Engine planned for Stage 2.
 *
 * @module domain/market-state
 */
import { REASON_CODE } from './reason-code.mjs';

/**
 * @typedef {object} InstrumentConstraints
 * @property {string} [symbol]
 * @property {number} [tickSize] minimum price increment
 * @property {number} [qtyStep] minimum quantity increment
 * @property {number} [minOrderQty] minimum order quantity
 * @property {number} [minNotionalUsd] minimum order notional
 * @property {number} [maxOrderQty] maximum order quantity
 */

/**
 * @typedef {object} MarketState
 * @property {number | null} [markPrice] latest mark/last price, when known
 * @property {number | null} [bestBid]
 * @property {number | null} [bestAsk]
 * @property {InstrumentConstraints} [instrument]
 */

/**
 * @typedef {object} MarketValidationResult
 * @property {boolean} valid
 * @property {string | null} reasonCode
 * @property {MarketState} state
 */

/**
 * Validate and normalise a market snapshot.
 *
 * A missing market snapshot is *not* an error: Stage 1 sizes positions without
 * exchange constraints, and the result simply omits the constraint-dependent
 * fields. A present-but-malformed value is an error, though — it means somebody
 * handed us broken data.
 *
 * @param {unknown} raw
 * @returns {MarketValidationResult}
 */
export function validateMarketState(raw) {
  if (raw === undefined || raw === null) {
    return { valid: true, reasonCode: null, state: Object.freeze({}) };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reasonCode: REASON_CODE.INVALID_MARKET_STATE, state: Object.freeze({}) };
  }

  const input = /** @type {Record<string, unknown>} */ (raw);
  const markPrice = optionalPositive(input.markPrice);
  const bestBid = optionalPositive(input.bestBid);
  const bestAsk = optionalPositive(input.bestAsk);

  if (markPrice === INVALID || bestBid === INVALID || bestAsk === INVALID) {
    return { valid: false, reasonCode: REASON_CODE.INVALID_MARKET_STATE, state: Object.freeze({}) };
  }

  /** @type {InstrumentConstraints} */
  let instrument = {};
  if (input.instrument !== undefined && input.instrument !== null) {
    if (typeof input.instrument !== 'object' || Array.isArray(input.instrument)) {
      return { valid: false, reasonCode: REASON_CODE.INVALID_MARKET_STATE, state: Object.freeze({}) };
    }
    const rawInstrument = /** @type {Record<string, unknown>} */ (input.instrument);
    const constraints = {};
    for (const key of ['tickSize', 'qtyStep', 'minOrderQty', 'minNotionalUsd', 'maxOrderQty']) {
      const value = optionalPositive(rawInstrument[key]);
      if (value === INVALID) {
        return { valid: false, reasonCode: REASON_CODE.INVALID_MARKET_STATE, state: Object.freeze({}) };
      }
      if (value !== null) constraints[key] = value;
    }
    if (typeof rawInstrument.symbol === 'string') constraints.symbol = rawInstrument.symbol.trim().toUpperCase();
    instrument = Object.freeze(constraints);
  }

  /** @type {MarketState} */
  const state = Object.freeze({
    markPrice: markPrice === undefined ? null : markPrice,
    bestBid: bestBid === undefined ? null : bestBid,
    bestAsk: bestAsk === undefined ? null : bestAsk,
    instrument,
  });

  return { valid: true, reasonCode: null, state };
}

const INVALID = Symbol('invalid');

/**
 * @returns {number | null | undefined | typeof INVALID}
 */
function optionalPositive(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < 0) return INVALID;
  return parsed;
}