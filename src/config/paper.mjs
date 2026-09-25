/**
 * Paper-trading and market-data configuration.
 *
 * Kept deliberately separate from `risk.mjs` (hard limits) and from exchange
 * credentials (which the trading core never reads — see `env.mjs`).
 *
 * The fee rates below are INVENTED PLACEHOLDERS for simulation, not Bybit's
 * real schedule. They exist so the paper loop has a configurable, explicit cost
 * model; a later stage will feed real rates from exchange/account data. Nothing
 * here is a claim about actual trading costs.
 *
 * @module config/paper
 */
import { ConfigError } from './config-error.mjs';
import { parseEnum, parseNumber } from './parse.mjs';

/** Timezones supported for the daily trading session. Only UTC for now. */
export const SESSION_TIMEZONE = Object.freeze({
  UTC: 'UTC',
});

/**
 * Where paper state and the journal live, relative to the project root.
 * Kept out of `src/` so the core keeps zero knowledge of its own storage.
 */
export const DEFAULT_PAPER_PATHS = Object.freeze({
  stateFile: 'data/paper/paper-state.json',
  journalFile: 'data/paper/journal.jsonl',
});

/**
 * Default simulated fee rates.
 *
 * Deliberately conservative and explicitly synthetic. `takerRate` mimics a
 * typical taker fee magnitude so the simulation is not accidentally optimistic;
 * it is NOT sourced from the account and must not be presented as real.
 */
export const DEFAULT_FEE_MODEL = Object.freeze({
  /** Fraction of notional charged on entry (0.001 = 0.10%). */
  takerRate: 0.001,
  /** Fraction of notional charged on exit. */
  exitRate: 0.001,
});

/**
 * Default market-data settings.
 */
export const DEFAULT_MARKET_CONFIG = Object.freeze({
  /** Quote currency for the USDT perpetual universe. */
  category: 'linear',
  /** Default candle interval, Bybit-style interval codes. */
  defaultInterval: '15',
  /** How many candles to request by default. */
  defaultCandleLimit: 200,
  /** REST request timeout in milliseconds. */
  requestTimeoutMs: 15000,
});

/**
 * @typedef {object} PaperConfig
 * @property {number} takerFeeRate simulated entry fee rate
 * @property {number} exitFeeRate simulated exit fee rate
 * @property {string} defaultSymbol symbol the PAPER bootstrap inspects
 * @property {string} timezone session timezone (UTC)
 * @property {string} stateFile path to the persisted state file
 * @property {string} journalFile path to the append-only journal
 * @property {boolean} persist whether state/journal are written to disk
 *
 * Note: the starting equity is NOT part of this config — see
 * `risk.initialCapitalUsd` (`RISK_INITIAL_CAPITAL_USD`).
 */

/**
 * @typedef {object} MarketConfig
 * @property {'linear'} category
 * @property {string} defaultInterval
 * @property {number} defaultCandleLimit
 * @property {number} requestTimeoutMs
 */

/**
 * Build and validate the paper configuration.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<PaperConfig & { market: MarketConfig }>}
 * @throws {ConfigError}
 */
export function loadPaperConfig(env = process.env) {
  const takerFeeRate = parseNumber(env.PAPER_TAKER_FEE_RATE, {
    field: 'PAPER_TAKER_FEE_RATE',
    fallback: DEFAULT_FEE_MODEL.takerRate,
    min: 0,
    max: 0.1,
  });
  const exitFeeRate = parseNumber(env.PAPER_EXIT_FEE_RATE, {
    field: 'PAPER_EXIT_FEE_RATE',
    fallback: DEFAULT_FEE_MODEL.exitRate,
    min: 0,
    max: 0.1,
  });

  const timezone = parseEnum(env.PAPER_TIMEZONE, {
    field: 'PAPER_TIMEZONE',
    allowed: Object.values(SESSION_TIMEZONE),
    fallback: SESSION_TIMEZONE.UTC,
    uppercase: true,
  });

  const market = /** @type {MarketConfig} */ (Object.freeze({
    category: /** @type {'linear'} */ (
      parseEnum(env.MARKET_CATEGORY, { field: 'MARKET_CATEGORY', allowed: ['linear'], fallback: 'linear' })
    ),
    defaultInterval: String(env.MARKET_DEFAULT_INTERVAL ?? DEFAULT_MARKET_CONFIG.defaultInterval),
    defaultCandleLimit: parseNumber(env.MARKET_DEFAULT_CANDLE_LIMIT, {
      field: 'MARKET_DEFAULT_CANDLE_LIMIT',
      fallback: DEFAULT_MARKET_CONFIG.defaultCandleLimit,
      min: 1,
      max: 1000,
      integer: true,
    }),
    requestTimeoutMs: parseNumber(env.MARKET_REQUEST_TIMEOUT_MS, {
      field: 'MARKET_REQUEST_TIMEOUT_MS',
      fallback: DEFAULT_MARKET_CONFIG.requestTimeoutMs,
      min: 1000,
      max: 120000,
      integer: true,
    }),
  }));

  const persist = String(env.PAPER_PERSIST ?? 'true').trim().toLowerCase() !== 'false';

  /** Instrument the PAPER bootstrap inspects first. */
  const defaultSymbol = String(env.PAPER_SYMBOL ?? 'BTCUSDT').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(defaultSymbol)) {
    throw new ConfigError(`PAPER_SYMBOL must look like a Bybit symbol (e.g. BTCUSDT), got ${JSON.stringify(env.PAPER_SYMBOL)}`, {
      field: 'PAPER_SYMBOL',
      value: env.PAPER_SYMBOL,
    });
  }

  /** @type {PaperConfig & { market: MarketConfig }} */
  const config = {
    // Initial equity deliberately does NOT live here. It comes from
    // `RISK_INITIAL_CAPITAL_USD` via `risk.initialCapitalUsd`, because the Risk
    // Engine also uses it as the offline fallback equity. Parsing it in two
    // places would let a user set one variable and silently get the other.
    takerFeeRate,
    exitFeeRate,
    timezone,
    defaultSymbol,
    stateFile: String(env.PAPER_STATE_FILE ?? DEFAULT_PAPER_PATHS.stateFile),
    journalFile: String(env.PAPER_JOURNAL_FILE ?? DEFAULT_PAPER_PATHS.journalFile),
    persist,
    market,
  };

  return Object.freeze(config);
}