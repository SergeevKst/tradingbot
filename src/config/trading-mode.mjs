/**
 * Trading modes.
 *
 * The mode decides what the core is allowed to do, so it is represented as a
 * frozen enum-like object and resolved once, at startup, by the config layer.
 * An unrecognised value is a hard startup error — never a silent fallback to a
 * default, because falling back is exactly how a LIVE-intended run could
 * quietly become something else, or a typo could silently arm real trading.
 *
 *   BACKTEST — offline historical simulation; no exchange contact at all.
 *   PAPER    — live data, simulated fills; no exchange write calls.
 *   LIVE     — real orders. NOT implemented in Stage 1 and additionally gated
 *              behind an explicit ALLOW_LIVE_TRADING opt-in.
 *
 * @module config/trading-mode
 */
import { ConfigError } from './config-error.mjs';

/** @typedef {'BACKTEST' | 'PAPER' | 'LIVE'} TradingModeName */

export const TRADING_MODE = Object.freeze({
  BACKTEST: 'BACKTEST',
  PAPER: 'PAPER',
  LIVE: 'LIVE',
});

/** Default mode for the whole project. Safety-first: simulated, not live. */
export const DEFAULT_TRADING_MODE = /** @type {TradingModeName} */ (TRADING_MODE.PAPER);

/** @type {readonly TradingModeName[]} */
export const TRADING_MODES = Object.freeze(Object.values(TRADING_MODE));

/**
 * @param {unknown} value
 * @returns {value is TradingModeName}
 */
export function isTradingMode(value) {
  return typeof value === 'string' && TRADING_MODES.includes(/** @type {TradingModeName} */ (value));
}

/**
 * Resolve a raw TRADING_MODE value into a validated mode name.
 *
 * @param {unknown} raw
 * @returns {TradingModeName}
 * @throws {ConfigError} when the value is present but not a known mode
 */
export function resolveTradingMode(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return DEFAULT_TRADING_MODE;
  }

  const value = String(raw).trim().toUpperCase();
  if (!isTradingMode(value)) {
    throw new ConfigError(`Invalid TRADING_MODE ${JSON.stringify(raw)}. Expected one of: ${TRADING_MODES.join(', ')}`, {
      field: 'TRADING_MODE',
      value: raw,
    });
  }
  return value;
}

/**
 * True for modes that must never touch the exchange, not even for reads that
 * could be mistaken for intent to trade.
 *
 * @param {TradingModeName} mode
 */
export function isOfflineMode(mode) {
  return mode === TRADING_MODE.BACKTEST || mode === TRADING_MODE.PAPER;
}

/**
 * True only for the mode that may place real orders.
 *
 * @param {TradingModeName} mode
 */
export function isLiveMode(mode) {
  return mode === TRADING_MODE.LIVE;
}