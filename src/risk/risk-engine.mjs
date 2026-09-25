/**
 * Risk Engine — the deterministic authority on whether a trade may be opened
 * and how large it may be.
 *
 * Isolation contract (enforced by tests in test/security.test.mjs):
 *   - imports NOTHING from the exchange, MCP, network or AI layers;
 *   - performs no I/O and has no clock dependency in its decision path;
 *   - exposes no write capability of any kind.
 *
 * The engine receives a proposal plus account/market snapshots and returns a
 * structured APPROVED / REJECTED result. It never fetches data, never mutates
 * its inputs, and never widens a configured limit.
 *
 * Two invariants are worth stating explicitly because they are the point of the
 * whole module:
 *
 *   FAIL CLOSED — every unexpected condition, thrown error or unreadable input
 *   resolves to a rejection. There is no code path where an unknown state ends
 *   in `approved: true`.
 *
 *   CONFIDENCE IS INERT — `proposal.confidence` never influences sizing. A
 *   model may be `99%` sure or `51%` sure; the position size is identical.
 *
 * @module risk/risk-engine
 */
import { ConfigError } from '../config/config-error.mjs';
import { DEFAULT_RISK_LIMITS, validateRiskLimits } from '../config/risk.mjs';
import { SIDE } from '../domain/side.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';
import { validateProposal } from '../domain/proposal.mjs';
import { validateAccountState } from '../domain/account-state.mjs';
import { validateMarketState } from '../domain/market-state.mjs';
import { approvedResult, rejectedResult } from '../domain/risk-result.mjs';
import { actualRiskAtStop, calculatePositionSize, computePriceGeometry } from './position-sizing.mjs';
import { silentLogger } from '../util/logger.mjs';

/**
 * @typedef {object} EvaluateTradeInput
 * @property {unknown} proposal raw or pre-validated TradeProposal
 * @property {unknown} account AccountState snapshot
 * @property {unknown} [market] MarketState snapshot (optional)
 * @property {import('../config/risk.mjs').RiskLimits} [riskConfig] overrides; defaults to the conservative profile
 */

/**
 * Evaluate a trade proposal against hard risk limits.
 *
 * Deterministic: the same inputs always produce the same decision (modulo the
 * `evaluatedAt` stamp).
 *
 * @param {EvaluateTradeInput} input
 * @returns {import('../domain/risk-result.mjs').RiskResult}
 */
export function evaluateTrade(input) {
  try {
    return evaluateTradeUnsafe(input);
  } catch (error) {
    // Fail closed: an unexpected throw must never surface as an approval.
    return rejectedResult(
      REASON_CODE.INTERNAL_ERROR,
      `Risk evaluation failed closed: ${error instanceof Error ? error.message : String(error)}`,
      { issues: [error instanceof Error ? error.name : 'UnknownError'] },
    );
  }
}

/**
 * The engine proper. Kept separate so `evaluateTrade` can enforce fail-closed
 * semantics around every possible throw.
 *
 * @param {EvaluateTradeInput} input
 * @returns {import('../domain/risk-result.mjs').RiskResult}
 */
function evaluateTradeUnsafe(input) {
  if (input === null || typeof input !== 'object') {
    return rejectedResult(REASON_CODE.MALFORMED_PROPOSAL, 'evaluateTrade requires an input object');
  }

  // --- risk configuration ---------------------------------------------------
  let riskLimits;
  try {
    riskLimits = input.riskConfig ? normalizeRiskLimits(input.riskConfig) : DEFAULT_RISK_LIMITS;
  } catch (error) {
    return rejectedResult(
      REASON_CODE.INVALID_RISK_CONFIG,
      `Risk configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // --- proposal -------------------------------------------------------------
  const proposalResult = validateProposal(input.proposal);
  if (!proposalResult.valid || proposalResult.proposal === null) {
    const first = proposalResult.issues[0];
    return rejectedResult(first?.code ?? REASON_CODE.MALFORMED_PROPOSAL, first?.message ?? 'Proposal failed validation', {
      issues: proposalResult.issues.map((i) => `${i.field}: ${i.message}`),
    });
  }
  const proposal = proposalResult.proposal;

  const context = { symbol: proposal.symbol, side: proposal.side, strategyId: proposal.strategyId };

  // --- account --------------------------------------------------------------
  const accountResult = validateAccountState(input.account);
  if (!accountResult.valid || accountResult.state === null) {
    return rejectedResult(
      REASON_CODE.INVALID_ACCOUNT_STATE,
      'Account snapshot is missing or malformed — refusing to size a position without reliable equity',
      context,
    );
  }
  const account = accountResult.state;

  // --- market (optional) ----------------------------------------------------
  const marketResult = validateMarketState(input.market);
  if (!marketResult.valid) {
    return rejectedResult(REASON_CODE.INVALID_MARKET_STATE, 'Market snapshot is malformed', context);
  }
  const market = marketResult.state;

  // --- protective orders required ------------------------------------------
  if (riskLimits.requireStopLoss && !Number.isFinite(proposal.stopLossPrice)) {
    return rejectedResult(
      REASON_CODE.MISSING_STOP_LOSS,
      'A stop loss is required by risk configuration, but the proposal has none',
      context,
    );
  }
  if (riskLimits.requireTakeProfit && !Number.isFinite(proposal.takeProfitPrice)) {
    return rejectedResult(
      REASON_CODE.MISSING_TAKE_PROFIT,
      'A take profit is required by risk configuration, but the proposal has none',
      context,
    );
  }

  // --- price geometry -------------------------------------------------------
  const geometry = computePriceGeometry({
    side: proposal.side,
    entryPrice: proposal.entryPrice,
    stopLossPrice: proposal.stopLossPrice,
    takeProfitPrice: proposal.takeProfitPrice,
  });

  if (geometry.riskDistance <= 0) {
    return rejectedResult(
      REASON_CODE.ZERO_RISK_DISTANCE,
      `Stop loss is at the entry price (distance ${geometry.riskDistance})`,
      context,
    );
  }
  if (!geometry.stopLossOnCorrectSide) {
    return rejectedResult(
      REASON_CODE.STOP_LOSS_ON_WRONG_SIDE,
      `Stop loss ${proposal.stopLossPrice} is on the wrong side of entry ${proposal.entryPrice} for a ${proposal.side}`,
      context,
    );
  }
  if (!geometry.takeProfitOnCorrectSide) {
    return rejectedResult(
      REASON_CODE.TAKE_PROFIT_ON_WRONG_SIDE,
      `Take profit ${proposal.takeProfitPrice} is on the wrong side of entry ${proposal.entryPrice} for a ${proposal.side}`,
      context,
    );
  }

  // --- risk/reward ----------------------------------------------------------
  if (geometry.riskReward < riskLimits.minRiskReward) {
    return rejectedResult(
      REASON_CODE.INVALID_RISK_REWARD,
      `Risk/reward ${geometry.riskReward.toFixed(4)} is below the configured minimum ${riskLimits.minRiskReward}`,
      { ...context, riskReward: geometry.riskReward },
    );
  }

  // --- daily loss limit -----------------------------------------------------
  const dailyLossLimitUsd = -(account.equityUsd * riskLimits.maxDailyLossPct) / 100;
  if (account.dailyRealizedPnlUsd <= dailyLossLimitUsd) {
    return rejectedResult(
      REASON_CODE.DAILY_LOSS_LIMIT,
      `Daily realised PnL ${account.dailyRealizedPnlUsd.toFixed(2)} USD has reached the daily loss limit ${dailyLossLimitUsd.toFixed(2)} USD — no new trades today`,
      context,
    );
  }

  // --- count-based limits ---------------------------------------------------
  if (account.openPositions.length >= riskLimits.maxOpenPositions) {
    return rejectedResult(
      REASON_CODE.MAX_OPEN_POSITIONS,
      `Already holding ${account.openPositions.length} position(s), limit is ${riskLimits.maxOpenPositions}`,
      context,
    );
  }
  if (account.tradesToday >= riskLimits.maxTradesPerDay) {
    return rejectedResult(
      REASON_CODE.MAX_TRADES_PER_DAY,
      `Already took ${account.tradesToday} trade(s) today, limit is ${riskLimits.maxTradesPerDay}`,
      context,
    );
  }

  // --- conflicting position -------------------------------------------------
  const existing = account.openPositions.find((position) => position.symbol === proposal.symbol);
  if (existing) {
    if (existing.side === proposal.side) {
      return rejectedResult(
        REASON_CODE.DUPLICATE_PROPOSAL,
        `An open ${existing.side} position on ${proposal.symbol} already exists — refusing to stack exposure`,
        context,
      );
    }
    return rejectedResult(
      REASON_CODE.CONFLICTING_POSITION,
      `An opposing ${existing.side} position on ${proposal.symbol} is open — resolve it before opening a ${proposal.side}`,
      context,
    );
  }

  // --- duplicate symbol earlier today --------------------------------------
  if (account.tradedSymbolsToday.includes(proposal.symbol)) {
    return rejectedResult(
      REASON_CODE.DUPLICATE_PROPOSAL,
      `${proposal.symbol} has already been traded today — duplicate proposals are refused`,
      context,
    );
  }

  // --- market sanity (when market data is supplied) -------------------------
  if (market.markPrice !== null && market.markPrice > 0) {
    const deviation = Math.abs(proposal.entryPrice - market.markPrice) / market.markPrice;
    // A 20% deviation is not a "wide entry", it is a broken or stale proposal.
    if (deviation > 0.2) {
      return rejectedResult(
        REASON_CODE.NONSENSICAL_PRICE_GEOMETRY,
        `Entry ${proposal.entryPrice} deviates ${(deviation * 100).toFixed(2)}% from mark ${market.markPrice} — refusing a likely stale proposal`,
        context,
      );
    }
  }

  // --- sizing ---------------------------------------------------------------
  const sizing = calculatePositionSize({
    equityUsd: account.equityUsd,
    riskPerTradePct: riskLimits.riskPerTradePct,
    stopLossDistanceFraction: geometry.stopLossDistanceFraction,
    entryPrice: proposal.entryPrice,
    maxLeverage: riskLimits.maxLeverage,
    availableBalanceUsd: account.availableBalanceUsd,
  });

  if (sizing.positionNotionalUsd <= 0) {
    return rejectedResult(
      REASON_CODE.RISK_AMOUNT_TOO_SMALL,
      'Computed position notional is zero — nothing to trade at this risk and stop distance',
      context,
    );
  }

  // The realised risk after caps; honest about being below the requested risk.
  const riskAmountUsd = actualRiskAtStop({
    positionNotionalUsd: sizing.positionNotionalUsd,
    stopLossDistanceFraction: geometry.stopLossDistanceFraction,
  });

  const perTradeRiskBudgetUsd = (account.equityUsd * riskLimits.riskPerTradePct) / 100;
  if (riskAmountUsd > perTradeRiskBudgetUsd * (1 + 1e-9)) {
    return rejectedResult(
      REASON_CODE.RISK_LIMIT_EXCEEDED,
      `Position risk ${riskAmountUsd.toFixed(4)} USD exceeds the per-trade budget ${perTradeRiskBudgetUsd.toFixed(4)} USD`,
      { ...context, riskAmountUsd, riskReward: geometry.riskReward },
    );
  }

  // A position shrunk by a cap (balance/leverage) can end up too small to be a
  // meaningful trade. Refuse it rather than approving dust.
  if (sizing.positionNotionalUsd < riskLimits.minPositionNotionalUsd) {
    return rejectedResult(
      REASON_CODE.POSITION_NOTIONAL_TOO_SMALL,
      `Position notional ${sizing.positionNotionalUsd.toFixed(4)} USD is below the configured minimum ${riskLimits.minPositionNotionalUsd} USD` +
        (sizing.balanceCapped ? ' (position was capped by available balance)' : ''),
      { ...context, riskAmountUsd, riskReward: geometry.riskReward },
    );
  }

  if (sizing.effectiveLeverage > riskLimits.maxLeverage * (1 + 1e-9)) {
    return rejectedResult(
      REASON_CODE.LEVERAGE_LIMIT,
      `Effective leverage ${sizing.effectiveLeverage.toFixed(4)} exceeds the cap ${riskLimits.maxLeverage}`,
      { ...context, riskAmountUsd, riskReward: geometry.riskReward },
    );
  }

  if (sizing.positionNotionalUsd > account.availableBalanceUsd * (1 + 1e-9)) {
    return rejectedResult(
      REASON_CODE.INSUFFICIENT_BALANCE,
      `Position notional ${sizing.positionNotionalUsd.toFixed(2)} USD exceeds available balance ${account.availableBalanceUsd.toFixed(2)} USD`,
      { ...context, riskAmountUsd, riskReward: geometry.riskReward },
    );
  }

  // --- exchange constraints (only when instrument info is supplied) ---------
  const instrument = market.instrument ?? {};
  if (Number.isFinite(instrument.minOrderQty) && sizing.estimatedQuantity < instrument.minOrderQty) {
    return rejectedResult(
      REASON_CODE.POSITION_NOTIONAL_TOO_SMALL,
      `Estimated quantity ${sizing.estimatedQuantity} is below the instrument minimum ${instrument.minOrderQty}`,
      { ...context, riskAmountUsd, riskReward: geometry.riskReward },
    );
  }
  if (Number.isFinite(instrument.maxOrderQty) && sizing.estimatedQuantity > instrument.maxOrderQty) {
    return rejectedResult(
      REASON_CODE.LEVERAGE_LIMIT,
      `Estimated quantity ${sizing.estimatedQuantity} exceeds the instrument maximum ${instrument.maxOrderQty}`,
      { ...context, riskAmountUsd, riskReward: geometry.riskReward },
    );
  }
  if (Number.isFinite(instrument.minNotionalUsd) && sizing.positionNotionalUsd < instrument.minNotionalUsd) {
    return rejectedResult(
      REASON_CODE.POSITION_NOTIONAL_TOO_SMALL,
      `Position notional ${sizing.positionNotionalUsd.toFixed(2)} USD is below the instrument minimum ${instrument.minNotionalUsd} USD`,
      { ...context, riskAmountUsd, riskReward: geometry.riskReward },
    );
  }

  // --- approved -------------------------------------------------------------
  return approvedResult({
    riskAmountUsd,
    positionNotionalUsd: sizing.positionNotionalUsd,
    estimatedQuantity: sizing.estimatedQuantity,
    stopLossDistance: geometry.riskDistance,
    stopLossDistanceFraction: geometry.stopLossDistanceFraction,
    riskReward: geometry.riskReward,
    maxAllowedLeverage: riskLimits.maxLeverage,
    effectiveLeverage: sizing.effectiveLeverage,
    symbol: proposal.symbol,
    side: proposal.side,
    strategyId: proposal.strategyId,
  });
}

/**
 * Validate an override risk configuration and return it frozen.
 *
 * @param {import('../config/risk.mjs').RiskLimits} limits
 * @returns {Readonly<import('../config/risk.mjs').RiskLimits>}
 * @throws {ConfigError}
 */
export function normalizeRiskLimits(limits) {
  if (limits === null || typeof limits !== 'object') {
    throw new ConfigError('riskConfig must be an object');
  }
  const merged = { ...DEFAULT_RISK_LIMITS, ...limits };
  return Object.freeze(validateRiskLimits(merged));
}

/**
 * Risk Engine bound to a configuration, with structured logging.
 *
 * The pure `evaluateTrade` remains the primary interface; this wrapper adds
 * optional logging without adding any capability the pure function lacks.
 *
 * @param {{ riskConfig?: import('../config/risk.mjs').RiskLimits, logger?: { info: Function, warn: Function, error: Function } }} [options]
 */
export function createRiskEngine(options = {}) {
  const riskConfig = options.riskConfig ? normalizeRiskLimits(options.riskConfig) : DEFAULT_RISK_LIMITS;
  const logger = options.logger ?? silentLogger;

  return Object.freeze({
    riskConfig,

    /**
     * Evaluate a proposal and log the decision (never the secrets, never the
     * raw proposal body).
     *
     * @param {{ proposal: unknown, account: unknown, market?: unknown }} input
     * @returns {import('../domain/risk-result.mjs').RiskResult}
     */
    evaluate({ proposal, account, market }) {
      const result = evaluateTrade({ proposal, account, market, riskConfig });

      if (result.approved) {
        logger.info('proposal evaluated', {
          proposal: `${result.side} ${result.symbol}`,
          approved: true,
          riskUsd: round(result.riskAmountUsd),
          notionalUsd: round(result.positionNotionalUsd),
          qty: round(result.estimatedQuantity, 8),
          rr: round(result.riskReward, 4),
          leverage: round(result.effectiveLeverage, 4),
          strategy: result.strategyId,
        });
      } else {
        logger.info('proposal evaluated', {
          proposal: `${result.side ?? '?'} ${result.symbol ?? '?'}`,
          approved: false,
          reason: result.reasonCode,
        });
        logger.debug('rejection detail', { message: result.message, reason: result.reasonCode });
      }

      return result;
    },
  });
}

/**
 * @param {number} value
 * @param {number} [decimals]
 */
function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export { SIDE };