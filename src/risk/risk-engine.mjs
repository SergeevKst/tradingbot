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
import { assertKillSwitch, isKillSwitchEngaged } from './kill-switch.mjs';

/**
 * @typedef {object} EvaluateTradeInput
 * @property {unknown} proposal raw or pre-validated TradeProposal
 * @property {unknown} account AccountState snapshot
 * @property {unknown} [market] MarketState snapshot (optional)
 * @property {import('../config/risk.mjs').RiskLimits} [riskConfig] overrides; defaults to the conservative profile
 * @property {boolean} [killSwitchEngaged] runtime emergency-stop state. Fail closed:
 *   any value other than `false`/omitted is treated as engaged, so a malformed flag
 *   stops trading rather than silently permitting it.
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

  // Two layers feed one gate (§44): the static config flag and the operational
  // runtime state. Either blocks; neither can release the other.
  if (isKillSwitchEngaged(riskLimits) || isRuntimeKillSwitchEngaged(input.killSwitchEngaged)) {
    return rejectedResult(REASON_CODE.KILL_SWITCH_ENGAGED, 'Kill switch engaged');
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

  // --- maximum drawdown -----------------------------------------------------
  // Measured peak-to-trough against the equity high-water mark, so a slow bleed
  // across several days is caught even when no single day breaches the daily
  // loss limit. `peakEquityUsd` is always >= equity after account validation, so
  // the drawdown can never be negative.
  const peakEquityUsd = account.peakEquityUsd ?? account.equityUsd;
  const drawdownPct = peakEquityUsd > 0 ? ((peakEquityUsd - account.equityUsd) / peakEquityUsd) * 100 : 0;
  if (drawdownPct >= riskLimits.maxDrawdownPct) {
    return rejectedResult(
      REASON_CODE.MAX_DRAWDOWN,
      `Equity drawdown ${drawdownPct.toFixed(2)}% has reached the maximum ${riskLimits.maxDrawdownPct}% (peak ${peakEquityUsd.toFixed(2)} USD, now ${account.equityUsd.toFixed(2)} USD) — no new trades`,
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

  // Note: re-trading a symbol later the same day is intentionally ALLOWED.
  // A flat position does not block a fresh entry; only a *currently open*
  // position does (checked above).

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

  // --- exposure headroom ----------------------------------------------------
  // Existing exposure consumes headroom; the proposed position is sized to what
  // remains so total/symbol notional never breaches its cap. A symbol with no
  // headroom is refused outright (nothing to size against).
  const existingSymbolNotionalUsd = account.openPositions
    .filter((position) => position.symbol === proposal.symbol)
    .reduce((sum, position) => sum + notionalOf(position), 0);
  const existingTotalNotionalUsd = account.openPositions.reduce((sum, position) => sum + notionalOf(position), 0);
  const symbolExposureCapUsd = (account.equityUsd * riskLimits.maxSymbolExposurePct) / 100;
  const totalExposureCapUsd = (account.equityUsd * riskLimits.maxTotalExposurePct) / 100;
  const symbolHeadroomUsd = symbolExposureCapUsd - existingSymbolNotionalUsd;
  const totalHeadroomUsd = totalExposureCapUsd - existingTotalNotionalUsd;

  if (symbolHeadroomUsd <= 0) {
    return rejectedResult(
      REASON_CODE.SYMBOL_EXPOSURE_LIMIT,
      `Open exposure on ${proposal.symbol} (${existingSymbolNotionalUsd.toFixed(2)} USD) has reached the per-symbol cap ${symbolExposureCapUsd.toFixed(2)} USD`,
      context,
    );
  }
  if (totalHeadroomUsd <= 0) {
    return rejectedResult(
      REASON_CODE.TOTAL_EXPOSURE_LIMIT,
      `Total open exposure (${existingTotalNotionalUsd.toFixed(2)} USD) has reached the account cap ${totalExposureCapUsd.toFixed(2)} USD`,
      context,
    );
  }
  const exposureHeadroomUsd = Math.min(symbolHeadroomUsd, totalHeadroomUsd);

  // --- sizing ---------------------------------------------------------------
  const sizing = calculatePositionSize({
    equityUsd: account.equityUsd,
    riskPerTradePct: riskLimits.riskPerTradePct,
    stopLossDistanceFraction: geometry.stopLossDistanceFraction,
    entryPrice: proposal.entryPrice,
    maxLeverage: riskLimits.maxLeverage,
    availableBalanceUsd: account.availableBalanceUsd,
    maxNotionalUsd: exposureHeadroomUsd,
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
    const cap = sizing.exposureCapped
      ? ' (position was capped by the exposure limit)'
      : sizing.balanceCapped
        ? ' (position was capped by available balance)'
        : '';
    return rejectedResult(
      REASON_CODE.POSITION_NOTIONAL_TOO_SMALL,
      `Position notional ${sizing.positionNotionalUsd.toFixed(4)} USD is below the configured minimum ${riskLimits.minPositionNotionalUsd} USD${cap}`,
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
 * Fail-closed reading of the runtime kill-switch flag.
 *
 * `undefined`/`false` mean "not engaged"; every other value — including a
 * malformed truthy string or a missing control surfaced as `null` — engages.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRuntimeKillSwitchEngaged(value) {
  return value !== undefined && value !== false;
}

/**
 * Notional of an open position, preferring the explicit field and falling back
 * to quantity * entry price. A position with neither contributes zero rather
 * than `NaN` (which would poison every downstream sum).
 *
 * @param {{ notionalUsd?: number, quantity?: number, entryPrice?: number }} position
 * @returns {number}
 */
function notionalOf(position) {
  if (Number.isFinite(position?.notionalUsd) && /** @type {number} */ (position.notionalUsd) >= 0) {
    return /** @type {number} */ (position.notionalUsd);
  }
  const quantity = position?.quantity;
  const entryPrice = position?.entryPrice;
  if (Number.isFinite(quantity) && Number.isFinite(entryPrice)) {
    return Math.max(0, /** @type {number} */ (quantity) * /** @type {number} */ (entryPrice));
  }
  return 0;
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
 * Risk Engine bound to a configuration, an optional operational kill switch,
 * structured logging, and an optional decision sink.
 *
 * The pure `evaluateTrade` remains the primary interface; this wrapper adds
 * only orchestration — it can narrow (via the runtime kill switch) but never
 * widen the pure function's decision.
 *
 * @param {{
 *   riskConfig?: import('../config/risk.mjs').RiskLimits,
 *   killSwitch?: ReturnType<import('./kill-switch.mjs').createKillSwitch>,
 *   logger?: { info: Function, warn: Function, error: Function, debug?: Function },
 *   onDecision?: (result: import('../domain/risk-result.mjs').RiskResult) => void,
 * }} [options]
 */
export function createRiskEngine(options = {}) {
  const riskConfig = options.riskConfig ? normalizeRiskLimits(options.riskConfig) : DEFAULT_RISK_LIMITS;
  const logger = options.logger ?? silentLogger;
  // An injected control is validated before the engine can evaluate anything;
  // a broken emergency stop is refused at construction, not on first trade.
  const killSwitch = options.killSwitch === undefined ? null : assertKillSwitch(options.killSwitch);
  const onDecision = typeof options.onDecision === 'function' ? options.onDecision : null;

  return Object.freeze({
    riskConfig,
    killSwitch,

    /**
     * Evaluate a proposal and log the decision (never the secrets, never the
     * raw proposal body).
     *
     * @param {{ proposal: unknown, account: unknown, market?: unknown }} input
     * @returns {import('../domain/risk-result.mjs').RiskResult}
     */
    evaluate({ proposal, account, market }) {
      const killSwitchEngaged = killSwitch === null ? undefined : killSwitch.isEngaged();
      const result = evaluateTrade({ proposal, account, market, riskConfig, killSwitchEngaged });

      if (onDecision !== null) {
        try {
          onDecision(result);
        } catch (error) {
          // An audit sink must never be able to turn a rejection into a crash
          // (or, worse, suppress a decision). Fail closed: log and continue.
          logger.error('risk decision sink threw', {
            error: error instanceof Error ? error.message : String(error),
            reason: result.reasonCode,
          });
        }
      }

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
 * The Risk Engine contract every caller (session, backtest, tests) depends on.
 * `evaluateTrade`/`createRiskEngine` both satisfy it.
 *
 * @typedef {object} RiskEngine
 * @property {(input: { proposal: unknown, account: unknown, market?: unknown }) => import('../domain/risk-result.mjs').RiskResult} evaluate
 */

/**
 * Assert an object satisfies the RiskEngine contract.
 *
 * @param {unknown} engine
 * @returns {RiskEngine}
 * @throws {ConfigError}
 */
export function assertRiskEngine(engine) {
  if (engine === null || typeof engine !== 'object' || typeof /** @type {any} */ (engine).evaluate !== 'function') {
    throw new ConfigError('RiskEngine must expose evaluate({ proposal, account, market })');
  }
  return /** @type {RiskEngine} */ (engine);
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