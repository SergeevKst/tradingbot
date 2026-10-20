/**
 * Position sizing and price geometry.
 *
 * Pure functions only: no I/O, no exchange, no AI, no clock. Everything here is
 * a deterministic function of its arguments, which is exactly what makes the
 * risk layer testable and auditable.
 *
 * Sign convention
 * ---------------
 * `sideDirection` is +1 for LONG and -1 for SHORT, which lets stop placement,
 * reward and risk all be expressed with one formula each instead of branching:
 *
 *   stopDistance = (entry - stopLoss) * direction   > 0
 *   riskDistance = -stopDistance                    > 0
 *   reward       = (takeProfit - entry) * direction > 0
 *
 * @module risk/position-sizing
 */
import { SIDE, sideDirection } from '../domain/side.mjs';

/**
 * @typedef {object} PriceGeometry
 * @property {'LONG' | 'SHORT'} side
 * @property {number} entryPrice
 * @property {number} stopLossPrice
 * @property {number} takeProfitPrice
 * @property {number} direction +1 for LONG, -1 for SHORT
 * @property {number} rewardDistance price distance to take profit (positive when valid)
 * @property {number} riskDistance price distance to stop loss (positive when valid)
 * @property {number} stopLossDistanceFraction riskDistance / entryPrice
 * @property {number} riskReward rewardDistance / riskDistance
 * @property {boolean} stopLossOnCorrectSide
 * @property {boolean} takeProfitOnCorrectSide
 */

/**
 * Compute side-aware price geometry for a proposal.
 *
 * Reports validity through the two `*OnCorrectSide` flags rather than throwing,
 * so the Risk Engine can emit a precise reason code for the caller.
 *
 * @param {{ side: 'LONG' | 'SHORT', entryPrice: number, stopLossPrice: number, takeProfitPrice: number }} input
 * @returns {PriceGeometry}
 */
export function computePriceGeometry(input) {
  const { side, entryPrice, stopLossPrice, takeProfitPrice } = input;
  const direction = sideDirection(side);

  // Positive when the protective level sits on the profitable-protection side.
  const stopDelta = entryPrice - stopLossPrice;
  const stopLossOnCorrectSide = stopDelta * direction > 0;

  const tpDelta = takeProfitPrice - entryPrice;
  const takeProfitOnCorrectSide = tpDelta * direction > 0;

  const riskDistance = Math.abs(stopDelta);
  const rewardDistance = Math.abs(tpDelta);

  const stopLossDistanceFraction = entryPrice > 0 ? riskDistance / entryPrice : 0;
  const riskReward = riskDistance > 0 ? rewardDistance / riskDistance : 0;

  return {
    side,
    entryPrice,
    stopLossPrice,
    takeProfitPrice,
    direction,
    rewardDistance,
    riskDistance,
    stopLossDistanceFraction,
    riskReward,
    stopLossOnCorrectSide,
    takeProfitOnCorrectSide,
  };
}

/**
 * @typedef {object} SizingInput
 * @property {number} equityUsd account equity the risk is derived from
 * @property {number} riskPerTradePct percent of equity risked if the stop is hit
 * @property {number} stopLossDistanceFraction stop distance / entry price (> 0)
 * @property {number} entryPrice
 * @property {number} maxLeverage leverage cap
 * @property {number} availableBalanceUsd free margin
 * @property {number} [maxNotionalUsd] exposure headroom cap (symbol/total); omit for no exposure cap
 */

/**
 * @typedef {object} SizingOutput
 * @property {number} riskAmountUsd
 * @property {number} positionNotionalUsd notional after applying every cap
 * @property {number} rawPositionNotionalUsd notional before the leverage cap
 * @property {number} estimatedQuantity unrounded base-unit size
 * @property {number} effectiveLeverage notional / equity
 * @property {boolean} leverageCapped true when the leverage cap reduced the size
 * @property {boolean} exposureCapped true when the exposure headroom reduced the size
 * @property {boolean} balanceCapped true when available balance reduced the size
 */

/**
 * Size a position from the money at risk and the stop distance.
 *
 * The core identity is that a stop-out costs exactly `riskAmountUsd`:
 *
 *   riskAmountUsd         = equity * riskPerTradePct / 100
 *   positionNotionalUsd   = riskAmountUsd / stopLossDistanceFraction
 *
 * The result is then reduced by, in order: the leverage cap, the exposure
 * headroom, and the available balance. Every reduction is reported so the
 * caller can see when a limit actually bound.
 *
 * Note that `confidence` is deliberately absent from this signature: position
 * size must never be a function of a model's self-reported certainty.
 *
 * @param {SizingInput} input
 * @returns {SizingOutput}
 */
export function calculatePositionSize(input) {
  const { equityUsd, riskPerTradePct, stopLossDistanceFraction, entryPrice, maxLeverage, availableBalanceUsd } = input;
  const maxNotionalUsd = input.maxNotionalUsd;

  const riskAmountUsd = (equityUsd * riskPerTradePct) / 100;

  // Guarded by the caller, but a zero/negative distance here would produce an
  // infinite or negative size, so it fails to zero rather than propagating.
  const rawPositionNotionalUsd =
    stopLossDistanceFraction > 0 ? riskAmountUsd / stopLossDistanceFraction : 0;

  const maxNotionalByLeverage = equityUsd * maxLeverage;
  let positionNotionalUsd = rawPositionNotionalUsd;
  let leverageCapped = false;
  if (positionNotionalUsd > maxNotionalByLeverage) {
    positionNotionalUsd = maxNotionalByLeverage;
    leverageCapped = true;
  }

  let exposureCapped = false;
  if (Number.isFinite(maxNotionalUsd) && positionNotionalUsd > maxNotionalUsd) {
    positionNotionalUsd = Math.max(0, /** @type {number} */ (maxNotionalUsd));
    exposureCapped = true;
  }

  let balanceCapped = false;
  if (positionNotionalUsd > availableBalanceUsd) {
    positionNotionalUsd = availableBalanceUsd;
    balanceCapped = true;
  }

  if (positionNotionalUsd < 0) positionNotionalUsd = 0;

  const estimatedQuantity = entryPrice > 0 ? positionNotionalUsd / entryPrice : 0;
  const effectiveLeverage = equityUsd > 0 ? positionNotionalUsd / equityUsd : 0;

  return {
    riskAmountUsd,
    positionNotionalUsd,
    rawPositionNotionalUsd,
    estimatedQuantity,
    effectiveLeverage,
    leverageCapped,
    exposureCapped,
    balanceCapped,
  };
}

/**
 * The actual loss if the stop is hit, given the notional that survived caps.
 *
 * When the leverage or balance cap shrinks the position, the realised risk is
 * *less* than the configured per-trade risk. Returning it explicitly keeps the
 * reported `riskAmountUsd` honest instead of echoing the requested figure.
 *
 * @param {{ positionNotionalUsd: number, stopLossDistanceFraction: number }} input
 * @returns {number}
 */
export function actualRiskAtStop(input) {
  const { positionNotionalUsd, stopLossDistanceFraction } = input;
  return positionNotionalUsd * stopLossDistanceFraction;
}

export { SIDE };