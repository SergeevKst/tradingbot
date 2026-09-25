/**
 * PaperAccountState — the complete local simulation ledger.
 *
 * This is the single source of truth for PAPER mode. It holds simulated money
 * only; nothing here corresponds to real funds, and no code path in the project
 * can turn this state into a real order.
 *
 * Accounting model
 * ----------------
 * `equityUsd` = available cash + realized PnL − fees + unrealized PnL.
 * Fees are tracked cumulatively in `feesUsd` AND subtracted from balances, so
 * neither figure can drift away from the other. Margin locked by open positions
 * is subtracted from `availableBalanceUsd` but remains part of equity.
 *
 * @module state/paper-account
 */
import { ConfigError } from '../config/config-error.mjs';
import { SIDE } from '../domain/side.mjs';
import { validatePaperPosition } from './paper-position.mjs';

/**
 * @typedef {object} PaperAccountState
 * @property {number} initialEquityUsd equity the simulation started with
 * @property {number} equityUsd equity including unrealized PnL
 * @property {number} availableBalanceUsd free margin (equity − locked margin)
 * @property {number} realizedPnlUsd cumulative realized PnL, GROSS of fees (fees are tracked in `feesUsd` and subtracted separately when computing equity)
 * @property {number} unrealizedPnlUsd sum of open-position unrealized PnL
 * @property {number} feesUsd cumulative simulated fees paid
 * @property {PaperPosition[]} positions open positions
 * @property {unknown[]} openOrders always empty in PAPER (fills are immediate)
 * @property {number} tradesToday approved entries taken today
 * @property {number} dailyRealizedPnlUsd realized PnL since the UTC day started
 * @property {number} dayStartEquityUsd equity at the start of the UTC day
 * @property {string} lastUpdatedAt ISO timestamp
 */

/**
 * @param {{ equityUsd: number }} seed
 * @returns {Readonly<PaperAccountState>}
 */
export function createPaperAccountState(seed) {
  if (!Number.isFinite(seed?.equityUsd) || seed.equityUsd <= 0) {
    throw new ConfigError(`createPaperAccountState requires a positive equityUsd, got ${JSON.stringify(seed?.equityUsd)}`, {
      field: 'equityUsd',
      value: seed?.equityUsd,
    });
  }

  const timestamp = new Date().toISOString();
  return Object.freeze({
    initialEquityUsd: seed.equityUsd,
    equityUsd: seed.equityUsd,
    availableBalanceUsd: seed.equityUsd,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    feesUsd: 0,
    positions: Object.freeze([]),
    openOrders: Object.freeze([]),
    tradesToday: 0,
    dailyRealizedPnlUsd: 0,
    dayStartEquityUsd: seed.equityUsd,
    lastUpdatedAt: timestamp,
  });
}

/**
 * Total margin currently locked by open positions.
 *
 * @param {Readonly<PaperAccountState>} state
 * @returns {number}
 */
export function lockedMarginUsd(state) {
  return state.positions.reduce((sum, position) => sum + position.initialMarginUsd, 0);
}

/**
 * Recompute the derived fields of an account from its positions and balances.
 *
 * Every mutation path funnels through here, so `equityUsd`,
 * `unrealizedPnlUsd` and `availableBalanceUsd` can never be left inconsistent
 * with the position list.
 *
 * @param {Readonly<PaperAccountState>} state
 * @returns {Readonly<PaperAccountState>}
 */
export function recomputeAccount(state) {
  const unrealizedPnlUsd = state.positions.reduce((sum, position) => sum + position.unrealizedPnlUsd, 0);
  const equityUsd = state.realizedPnlUsd + state.initialEquityUsd + unrealizedPnlUsd - state.feesUsd;
  const availableBalanceUsd = equityUsd - lockedMarginUsd(state);

  return Object.freeze({
    ...state,
    // Normalize negative zero at the source, so it cannot propagate into
    // persisted state or a report.
    equityUsd: equityUsd === 0 ? 0 : equityUsd,
    unrealizedPnlUsd: unrealizedPnlUsd === 0 ? 0 : unrealizedPnlUsd,
    availableBalanceUsd: availableBalanceUsd === 0 ? 0 : availableBalanceUsd,
  });
}

/**
 * Validate and freeze a complete account state.
 *
 * @param {unknown} raw
 * @returns {Readonly<PaperAccountState>}
 * @throws {ConfigError}
 */
export function validatePaperAccountState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('PaperAccountState must be an object', { field: 'account' });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  const initialEquityUsd = Number(input.initialEquityUsd);
  if (!Number.isFinite(initialEquityUsd) || initialEquityUsd <= 0) {
    throw new ConfigError(`PaperAccountState.initialEquityUsd must be > 0, got ${JSON.stringify(input.initialEquityUsd)}`, {
      field: 'account.initialEquityUsd',
      value: input.initialEquityUsd,
    });
  }

  if (!Array.isArray(input.positions)) {
    throw new ConfigError('PaperAccountState.positions must be an array', { field: 'account.positions' });
  }

  const positions = [];
  const seen = new Set();
  for (const rawPosition of input.positions) {
    const position = validatePaperPosition(rawPosition);
    // One net position per symbol is the Stage 2 rule; a persisted state that
    // violates it is corrupt, not something to silently merge.
    if (seen.has(position.symbol)) {
      throw new ConfigError(`PaperAccountState holds more than one position on ${position.symbol}`, {
        field: 'account.positions',
      });
    }
    seen.add(position.symbol);
    positions.push(position);
  }

  const numeric = {};
  for (const field of ['realizedPnlUsd', 'feesUsd', 'tradesToday', 'dayStartEquityUsd']) {
    const value = Number(input[field]);
    if (!Number.isFinite(value)) {
      throw new ConfigError(`PaperAccountState.${field} must be a finite number, got ${JSON.stringify(input[field])}`, {
        field: `account.${field}`,
        value: input[field],
      });
    }
    numeric[field] = value;
  }

  if (numeric.tradesToday < 0 || !Number.isInteger(numeric.tradesToday)) {
    throw new ConfigError(`PaperAccountState.tradesToday must be a non-negative integer, got ${numeric.tradesToday}`, {
      field: 'account.tradesToday',
    });
  }
  if (numeric.feesUsd < 0) {
    throw new ConfigError(`PaperAccountState.feesUsd must be >= 0, got ${numeric.feesUsd}`, {
      field: 'account.feesUsd',
    });
  }

  const base = Object.freeze({
    initialEquityUsd,
    equityUsd: Number.isFinite(Number(input.equityUsd)) ? Number(input.equityUsd) : initialEquityUsd,
    availableBalanceUsd: Number.isFinite(Number(input.availableBalanceUsd))
      ? Number(input.availableBalanceUsd)
      : initialEquityUsd,
    realizedPnlUsd: numeric.realizedPnlUsd,
    unrealizedPnlUsd: Number.isFinite(Number(input.unrealizedPnlUsd)) ? Number(input.unrealizedPnlUsd) : 0,
    feesUsd: numeric.feesUsd,
    positions: Object.freeze(positions),
    openOrders: Object.freeze(Array.isArray(input.openOrders) ? input.openOrders : []),
    tradesToday: numeric.tradesToday,
    dailyRealizedPnlUsd: Number.isFinite(Number(input.dailyRealizedPnlUsd)) ? Number(input.dailyRealizedPnlUsd) : 0,
    dayStartEquityUsd: numeric.dayStartEquityUsd,
    lastUpdatedAt: typeof input.lastUpdatedAt === 'string' ? input.lastUpdatedAt : new Date().toISOString(),
  });

  // Derived fields are always recomputed rather than trusted from storage.
  return recomputeAccount(base);
}

/**
 * Project the paper account into the shape the Risk Engine consumes.
 *
 * The engine's contract is narrower than the full ledger — feeding it only what
 * it needs keeps the risk layer independent of paper-specific bookkeeping.
 *
 * @param {Readonly<PaperAccountState>} state
 * @returns {{ equityUsd: number, availableBalanceUsd: number, dailyRealizedPnlUsd: number, tradesToday: number, openPositions: Array<{ symbol: string, side: string, quantity: number, entryPrice: number, unrealizedPnlUsd: number }>, openOrders: unknown[] }}
 */
export function toRiskAccountView(state) {
  return {
    equityUsd: state.equityUsd,
    availableBalanceUsd: state.availableBalanceUsd,
    dailyRealizedPnlUsd: state.dailyRealizedPnlUsd,
    tradesToday: state.tradesToday,
    openPositions: state.positions.map((position) => ({
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      unrealizedPnlUsd: position.unrealizedPnlUsd,
    })),
    openOrders: [],
  };
}

/**
 * Describe the account for logs/CLI without dumping every position.
 *
 * @param {Readonly<PaperAccountState>} state
 */
export function describeAccount(state) {
  return {
    equityUsd: round2(state.equityUsd),
    availableBalanceUsd: round2(state.availableBalanceUsd),
    realizedPnlUsd: round2(state.realizedPnlUsd),
    unrealizedPnlUsd: round2(state.unrealizedPnlUsd),
    feesUsd: round2(state.feesUsd),
    openPositions: state.positions.length,
    tradesToday: state.tradesToday,
    dailyRealizedPnlUsd: round2(state.dailyRealizedPnlUsd),
  };
}

/**
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  const rounded = Math.round(value * 100) / 100;
  // Normalize negative zero: "-0" in a report reads as a bug even though the
  // value is correct, and it compares oddly under Object.is.
  return rounded === 0 ? 0 : rounded;
}

export { SIDE };