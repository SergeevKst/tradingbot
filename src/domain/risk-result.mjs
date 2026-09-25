/**
 * RiskResult — the structured outcome of a risk evaluation.
 *
 * Always carries a machine-readable `reasonCode`. A rejection also carries a
 * human-readable `message`; free text is supplementary and must never be the
 * only signal a caller can branch on.
 *
 * `ApprovedRiskResult` additionally carries the sizing the engine computed.
 * These numbers are advisory outputs for a future execution layer — Stage 1
 * never places an order with them.
 *
 * @module domain/risk-result
 */
import { REASON_CODE, coerceReasonCode } from './reason-code.mjs';

/**
 * @typedef {object} ApprovedRiskResult
 * @property {true} approved
 * @property {'APPROVED'} reasonCode
 * @property {number} riskAmountUsd money at risk if the stop is hit
 * @property {number} positionNotionalUsd resulting position notional in USD
 * @property {number} estimatedQuantity position size in base units (unrounded)
 * @property {number} stopLossDistance absolute price distance to the stop
 * @property {number} stopLossDistanceFraction stop distance as a fraction of entry
 * @property {number} riskReward reward/risk ratio
 * @property {number} maxAllowedLeverage leverage cap in force
 * @property {number} effectiveLeverage notional / equity (<= maxAllowedLeverage)
 * @property {string} symbol
 * @property {'LONG' | 'SHORT'} side
 * @property {string} strategyId
 * @property {string} evaluatedAt ISO timestamp of evaluation
 */

/**
 * @typedef {object} RejectedRiskResult
 * @property {false} approved
 * @property {string} reasonCode
 * @property {string} message
 * @property {string} [symbol]
 * @property {'LONG' | 'SHORT'} [side]
 * @property {string} [strategyId]
 * @property {number} [riskReward]
 * @property {number} [riskAmountUsd]
 * @property {number} [positionNotionalUsd]
 * @property {string[]} [issues] additional detail, one entry per failed check
 * @property {string} evaluatedAt ISO timestamp of evaluation
 */

/**
 * @typedef {ApprovedRiskResult | RejectedRiskResult} RiskResult
 */

/**
 * Build an approval result.
 *
 * @param {Omit<ApprovedRiskResult, 'approved' | 'reasonCode' | 'evaluatedAt'> & { evaluatedAt?: string }} fields
 * @returns {Readonly<ApprovedRiskResult>}
 */
export function approvedResult(fields) {
  return Object.freeze({
    approved: /** @type {true} */ (true),
    reasonCode: /** @type {'APPROVED'} */ (REASON_CODE.APPROVED),
    evaluatedAt: fields.evaluatedAt ?? new Date().toISOString(),
    riskAmountUsd: fields.riskAmountUsd,
    positionNotionalUsd: fields.positionNotionalUsd,
    estimatedQuantity: fields.estimatedQuantity,
    stopLossDistance: fields.stopLossDistance,
    stopLossDistanceFraction: fields.stopLossDistanceFraction,
    riskReward: fields.riskReward,
    maxAllowedLeverage: fields.maxAllowedLeverage,
    effectiveLeverage: fields.effectiveLeverage,
    symbol: fields.symbol,
    side: fields.side,
    strategyId: fields.strategyId,
  });
}

/**
 * Build a rejection result.
 *
 * @param {string} reasonCode
 * @param {string} message
 * @param {Partial<Omit<RejectedRiskResult, 'approved' | 'reasonCode' | 'message'>>} [details]
 * @returns {Readonly<RejectedRiskResult>}
 */
export function rejectedResult(reasonCode, message, details = {}) {
  return Object.freeze({
    approved: /** @type {false} */ (false),
    reasonCode: coerceReasonCode(reasonCode),
    message,
    evaluatedAt: details.evaluatedAt ?? new Date().toISOString(),
    ...(details.symbol !== undefined ? { symbol: details.symbol } : {}),
    ...(details.side !== undefined ? { side: details.side } : {}),
    ...(details.strategyId !== undefined ? { strategyId: details.strategyId } : {}),
    ...(details.riskReward !== undefined ? { riskReward: details.riskReward } : {}),
    ...(details.riskAmountUsd !== undefined ? { riskAmountUsd: details.riskAmountUsd } : {}),
    ...(details.positionNotionalUsd !== undefined ? { positionNotionalUsd: details.positionNotionalUsd } : {}),
    ...(details.issues !== undefined ? { issues: Object.freeze([...details.issues]) } : {}),
  });
}

/**
 * @param {RiskResult} result
 * @returns {result is ApprovedRiskResult}
 */
export function isApproved(result) {
  return result.approved === true && result.reasonCode === REASON_CODE.APPROVED;
}

/**
 * @param {RiskResult} result
 * @returns {result is RejectedRiskResult}
 */
export function isRejected(result) {
  return result.approved === false;
}