/**
 * Risk configuration — the single source of truth for hard risk limits.
 *
 * These values are a CONSERVATIVE TEST PROFILE. They are not optimised, not
 * backed by research, and make no claim about profitability; they exist so the
 * deterministic core has an explicit, reviewable set of limits to enforce.
 *
 * Hard invariant of this project: no AI output, prompt, proposal field or
 * runtime argument may widen these limits. Only a human edit of this config
 * (or the environment variables it reads) can change them.
 *
 * @module config/risk
 */
import { ConfigError } from './config-error.mjs';
import { isAbsent, parseBoolean, parseEnum, parseNumber } from './parse.mjs';

/** Margin modes the exchange supports; Stage 1 never applies one. */
export const MARGIN_MODE = Object.freeze({
  ISOLATED: 'ISOLATED',
  CROSS: 'CROSS',
});

/**
 * Default conservative test profile.
 *
 * `initialCapitalUsd` is only a *fallback equity* for offline runs. The Risk
 * Engine always sizes from the actual account equity it is handed; this number
 * must never override live equity.
 */
export const DEFAULT_RISK_LIMITS = Object.freeze({
  initialCapitalUsd: 340,
  maxLeverage: 2,
  marginMode: MARGIN_MODE.ISOLATED,
  autoAddMargin: false,
  riskPerTradePct: 0.5,
  maxDailyLossPct: 2.0,
  // Peak-to-trough equity drawdown that halts new trading. Enforced against the
  // account's high-water mark (`peakEquityUsd`), so a slow bleed is stopped even
  // when no single day breaches the daily loss limit.
  maxDrawdownPct: 20.0,
  maxOpenPositions: 2,
  maxTradesPerDay: 10,
  // Exposure controls: caps on notional as a percent of equity. A single symbol
  // may never exceed `maxSymbolExposurePct`; all open positions plus the
  // proposed one may never exceed `maxTotalExposurePct`. Expressed as sizing
  // caps, so a proposal that would breach exposure is shrunk to the headroom
  // (and refused if that leaves it below the minimum notional).
  maxSymbolExposurePct: 200.0,
  maxTotalExposurePct: 200.0,
  requireStopLoss: true,
  requireTakeProfit: true,
  minRiskReward: 1.5,
  // Smallest notional worth opening. Matches the exchange's own minimum order
  // value for the target instruments, and stops a balance cap from producing a
  // position too small to be meaningful (or even representable).
  minPositionNotionalUsd: 5,
  killSwitchEnabled: false,
});

/**
 * @typedef {object} RiskLimits
 * @property {number} initialCapitalUsd fallback equity for offline runs
 * @property {number} maxLeverage hard cap on position notional / equity
 * @property {'ISOLATED' | 'CROSS'} marginMode intended margin mode (never applied in Stage 1)
 * @property {boolean} autoAddMargin intended auto-add-margin flag (never applied in Stage 1)
 * @property {number} riskPerTradePct % of equity risked per trade (stop-loss distance based)
 * @property {number} maxDailyLossPct % of equity that stops new trading for the day
 * @property {number} maxDrawdownPct % peak-to-trough equity drawdown that stops new trading
 * @property {number} maxOpenPositions maximum concurrent positions
 * @property {number} maxTradesPerDay maximum approved trades per day
 * @property {number} maxSymbolExposurePct max notional on a single symbol as % of equity
 * @property {number} maxTotalExposurePct max aggregate open notional as % of equity
 * @property {boolean} requireStopLoss reject proposals without a stop loss
 * @property {boolean} requireTakeProfit reject proposals without a take profit
 * @property {number} minRiskReward minimum reward/risk ratio
 * @property {number} minPositionNotionalUsd smallest position notional worth opening
 * @property {boolean} killSwitchEnabled config-level emergency stop (fail-closed check)
 */

/**
 * Validate a fully-built risk limit set. Throws on the first violation.
 *
 * Beyond per-field sanity this enforces cross-field invariants that keep the
 * profile internally consistent, e.g. risking 5% per trade under a 2% daily
 * stop would make the daily stop meaningless.
 *
 * @param {RiskLimits} limits
 * @returns {RiskLimits}
 * @throws {ConfigError}
 */
export function validateRiskLimits(limits) {
  const numericFields = [
    ['initialCapitalUsd', limits.initialCapitalUsd, { exclusiveMin: 0 }],
    ['maxLeverage', limits.maxLeverage, { min: 1 }],
    ['riskPerTradePct', limits.riskPerTradePct, { exclusiveMin: 0, max: 100 }],
    ['maxDailyLossPct', limits.maxDailyLossPct, { exclusiveMin: 0, max: 100 }],
    ['maxDrawdownPct', limits.maxDrawdownPct, { exclusiveMin: 0, max: 100 }],
    ['maxOpenPositions', limits.maxOpenPositions, { min: 1, integer: true }],
    ['maxTradesPerDay', limits.maxTradesPerDay, { min: 1, integer: true }],
    ['maxSymbolExposurePct', limits.maxSymbolExposurePct, { exclusiveMin: 0 }],
    ['maxTotalExposurePct', limits.maxTotalExposurePct, { exclusiveMin: 0 }],
    ['minRiskReward', limits.minRiskReward, { exclusiveMin: 0 }],
    ['minPositionNotionalUsd', limits.minPositionNotionalUsd, { exclusiveMin: 0 }],
  ];

  for (const [field, value, bounds] of numericFields) {
    if (!Number.isFinite(value)) {
      throw new ConfigError(`Risk limit "${field}" must be a finite number, got ${JSON.stringify(value)}`, {
        field,
        value,
      });
    }
    const { min, max, exclusiveMin, integer } = /** @type {any} */ (bounds);
    if (integer && !Number.isInteger(value)) {
      throw new ConfigError(`Risk limit "${field}" must be an integer, got ${value}`, { field, value });
    }
    if (exclusiveMin !== undefined && value <= exclusiveMin) {
      throw new ConfigError(`Risk limit "${field}" must be greater than ${exclusiveMin}, got ${value}`, {
        field,
        value,
      });
    }
    if (min !== undefined && value < min) {
      throw new ConfigError(`Risk limit "${field}" must be >= ${min}, got ${value}`, { field, value });
    }
    if (max !== undefined && value > max) {
      throw new ConfigError(`Risk limit "${field}" must be <= ${max}, got ${value}`, { field, value });
    }
  }

  if (!Object.values(MARGIN_MODE).includes(limits.marginMode)) {
    throw new ConfigError(
      `Risk limit "marginMode" must be one of: ${Object.values(MARGIN_MODE).join(', ')} — got ${JSON.stringify(limits.marginMode)}`,
      { field: 'marginMode', value: limits.marginMode },
    );
  }
  if (typeof limits.autoAddMargin !== 'boolean') {
    throw new ConfigError(`Risk limit "autoAddMargin" must be a boolean, got ${JSON.stringify(limits.autoAddMargin)}`, {
      field: 'autoAddMargin',
      value: limits.autoAddMargin,
    });
  }
  if (typeof limits.requireStopLoss !== 'boolean' || typeof limits.requireTakeProfit !== 'boolean') {
    throw new ConfigError('Risk limits "requireStopLoss" and "requireTakeProfit" must be booleans', {
      field: 'requireStopLoss/requireTakeProfit',
      value: { requireStopLoss: limits.requireStopLoss, requireTakeProfit: limits.requireTakeProfit },
    });
  }
  if (typeof limits.killSwitchEnabled !== 'boolean') {
    throw new ConfigError(
      `Risk limit "killSwitchEnabled" must be a boolean, got ${JSON.stringify(limits.killSwitchEnabled)}`,
      { field: 'killSwitchEnabled', value: limits.killSwitchEnabled },
    );
  }

  // Cross-field invariants.
  if (limits.riskPerTradePct > limits.maxDailyLossPct) {
    throw new ConfigError(
      `Risk limit "riskPerTradePct" (${limits.riskPerTradePct}) must not exceed "maxDailyLossPct" (${limits.maxDailyLossPct}): a single trade could breach the daily stop`,
      { field: 'riskPerTradePct', value: limits.riskPerTradePct },
    );
  }
  if (limits.initialCapitalUsd * (limits.riskPerTradePct / 100) <= 0) {
    throw new ConfigError('Risk limits make per-trade risk amount zero — check initialCapitalUsd / riskPerTradePct', {
      field: 'riskPerTradePct',
      value: limits.riskPerTradePct,
    });
  }
  if (limits.maxDrawdownPct <= limits.maxDailyLossPct) {
    throw new ConfigError(
      `Risk limit "maxDrawdownPct" (${limits.maxDrawdownPct}) must exceed "maxDailyLossPct" (${limits.maxDailyLossPct}): the daily stop is the tighter control`,
      { field: 'maxDrawdownPct', value: limits.maxDrawdownPct },
    );
  }
  if (limits.maxSymbolExposurePct > limits.maxTotalExposurePct) {
    throw new ConfigError(
      `Risk limit "maxSymbolExposurePct" (${limits.maxSymbolExposurePct}) must not exceed "maxTotalExposurePct" (${limits.maxTotalExposurePct}): one symbol cannot be allowed more than the whole account`,
      { field: 'maxSymbolExposurePct', value: limits.maxSymbolExposurePct },
    );
  }

  return limits;
}

/**
 * Build a validated, frozen risk limit set.
 *
 * Environment overrides use the `RISK_` prefix (e.g. `RISK_PER_TRADE_PCT`).
 * Only the config layer reads `process.env`; every other module receives the
 * resolved object.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<RiskLimits>}
 * @throws {ConfigError}
 */
export function loadRiskLimits(env = process.env) {
  /** @type {RiskLimits} */
  const limits = {
    initialCapitalUsd: parseNumber(env.RISK_INITIAL_CAPITAL_USD, {
      field: 'RISK_INITIAL_CAPITAL_USD',
      fallback: DEFAULT_RISK_LIMITS.initialCapitalUsd,
      exclusiveMin: 0,
    }),
    maxLeverage: parseNumber(env.RISK_MAX_LEVERAGE, {
      field: 'RISK_MAX_LEVERAGE',
      fallback: DEFAULT_RISK_LIMITS.maxLeverage,
      min: 1,
    }),
    marginMode:
      env.RISK_MARGIN_MODE && !isAbsent(env.RISK_MARGIN_MODE)
        ? /** @type {'ISOLATED' | 'CROSS'} */ (
            parseEnum(env.RISK_MARGIN_MODE, {
              field: 'RISK_MARGIN_MODE',
              allowed: Object.values(MARGIN_MODE),
              uppercase: true,
            })
          )
        : DEFAULT_RISK_LIMITS.marginMode,
    autoAddMargin: parseBoolean(env.RISK_AUTO_ADD_MARGIN, {
      field: 'RISK_AUTO_ADD_MARGIN',
      fallback: DEFAULT_RISK_LIMITS.autoAddMargin,
    }),
    riskPerTradePct: parseNumber(env.RISK_PER_TRADE_PCT, {
      field: 'RISK_PER_TRADE_PCT',
      fallback: DEFAULT_RISK_LIMITS.riskPerTradePct,
      exclusiveMin: 0,
      max: 100,
    }),
    maxDailyLossPct: parseNumber(env.RISK_MAX_DAILY_LOSS_PCT, {
      field: 'RISK_MAX_DAILY_LOSS_PCT',
      fallback: DEFAULT_RISK_LIMITS.maxDailyLossPct,
      exclusiveMin: 0,
      max: 100,
    }),
    maxDrawdownPct: parseNumber(env.RISK_MAX_DRAWDOWN_PCT, {
      field: 'RISK_MAX_DRAWDOWN_PCT',
      fallback: DEFAULT_RISK_LIMITS.maxDrawdownPct,
      exclusiveMin: 0,
      max: 100,
    }),
    maxOpenPositions: parseNumber(env.RISK_MAX_OPEN_POSITIONS, {
      field: 'RISK_MAX_OPEN_POSITIONS',
      fallback: DEFAULT_RISK_LIMITS.maxOpenPositions,
      min: 1,
      integer: true,
    }),
    maxTradesPerDay: parseNumber(env.RISK_MAX_TRADES_PER_DAY, {
      field: 'RISK_MAX_TRADES_PER_DAY',
      fallback: DEFAULT_RISK_LIMITS.maxTradesPerDay,
      min: 1,
      integer: true,
    }),
    maxSymbolExposurePct: parseNumber(env.RISK_MAX_SYMBOL_EXPOSURE_PCT, {
      field: 'RISK_MAX_SYMBOL_EXPOSURE_PCT',
      fallback: DEFAULT_RISK_LIMITS.maxSymbolExposurePct,
      exclusiveMin: 0,
    }),
    maxTotalExposurePct: parseNumber(env.RISK_MAX_TOTAL_EXPOSURE_PCT, {
      field: 'RISK_MAX_TOTAL_EXPOSURE_PCT',
      fallback: DEFAULT_RISK_LIMITS.maxTotalExposurePct,
      exclusiveMin: 0,
    }),
    requireStopLoss: parseBoolean(env.RISK_REQUIRE_STOP_LOSS, {
      field: 'RISK_REQUIRE_STOP_LOSS',
      fallback: DEFAULT_RISK_LIMITS.requireStopLoss,
    }),
    requireTakeProfit: parseBoolean(env.RISK_REQUIRE_TAKE_PROFIT, {
      field: 'RISK_REQUIRE_TAKE_PROFIT',
      fallback: DEFAULT_RISK_LIMITS.requireTakeProfit,
    }),
    minRiskReward: parseNumber(env.RISK_MIN_RISK_REWARD, {
      field: 'RISK_MIN_RISK_REWARD',
      fallback: DEFAULT_RISK_LIMITS.minRiskReward,
      exclusiveMin: 0,
    }),
    minPositionNotionalUsd: parseNumber(env.RISK_MIN_POSITION_NOTIONAL_USD, {
      field: 'RISK_MIN_POSITION_NOTIONAL_USD',
      fallback: DEFAULT_RISK_LIMITS.minPositionNotionalUsd,
      exclusiveMin: 0,
    }),
    // No environment variable yet by design: the emergency stop is engaged at
    // runtime through `createKillSwitch()` (session API), not by a config edit.
    // The config layer still emits the field so the limit set stays complete and
    // validateRiskLimits can reject a non-boolean.
    killSwitchEnabled: DEFAULT_RISK_LIMITS.killSwitchEnabled,
  };

  return Object.freeze(validateRiskLimits(limits));
}