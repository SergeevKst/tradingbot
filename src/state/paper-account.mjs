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
import { createPortfolioSnapshot, createPnLSnapshot } from '../domain/portfolio.mjs';
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
 * @property {number} peakEquityUsd equity high-water mark, for the drawdown limit
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
    peakEquityUsd: seed.equityUsd,
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
  // The high-water mark only ever rises: it is the peak equity the account has
  // reached, which is exactly what the risk layer's drawdown limit measures
  // against. A fresh/absent peak starts at the current equity.
  const priorPeak = Number.isFinite(state.peakEquityUsd) ? Number(state.peakEquityUsd) : equityUsd;
  const peakEquityUsd = Math.max(priorPeak, equityUsd);

  return Object.freeze({
    ...state,
    // Normalize negative zero at the source, so it cannot propagate into
    // persisted state or a report.
    equityUsd: equityUsd === 0 ? 0 : equityUsd,
    unrealizedPnlUsd: unrealizedPnlUsd === 0 ? 0 : unrealizedPnlUsd,
    availableBalanceUsd: availableBalanceUsd === 0 ? 0 : availableBalanceUsd,
    peakEquityUsd,
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
    // Older persisted state predates the high-water mark; it re-bases on the
    // initial equity rather than refusing to restore.
    peakEquityUsd: Number.isFinite(Number(input.peakEquityUsd)) ? Number(input.peakEquityUsd) : initialEquityUsd,
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
 * @returns {{ equityUsd: number, availableBalanceUsd: number, dailyRealizedPnlUsd: number, peakEquityUsd: number, tradesToday: number, openPositions: Array<{ symbol: string, side: string, quantity: number, entryPrice: number, notionalUsd: number, unrealizedPnlUsd: number }>, openOrders: unknown[] }}
 */
export function toRiskAccountView(state) {
  return {
    equityUsd: state.equityUsd,
    availableBalanceUsd: state.availableBalanceUsd,
    dailyRealizedPnlUsd: state.dailyRealizedPnlUsd,
    peakEquityUsd: state.peakEquityUsd,
    tradesToday: state.tradesToday,
    openPositions: state.positions.map((position) => ({
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      notionalUsd: position.entryPrice * position.quantity,
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
 * Project a paper position into the exchange-neutral `Position` domain type
 * (MASTER_SPEC §7). The paper ledger keeps extra simulation fields (entry fee,
 * initial margin); the projection emits only the documented portfolio shape.
 *
 * @param {import('./paper-position.mjs').PaperPosition} position
 * @returns {Readonly<import('../domain/position.mjs').Position>}
 */
export function toDomainPosition(position) {
  return Object.freeze({
    symbol: position.symbol,
    side: position.side,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    markPrice: position.markPrice,
    leverage: position.leverage,
    ...(Number.isFinite(position.stopLoss) ? { stopLossPrice: Number(position.stopLoss) } : {}),
    ...(Number.isFinite(position.takeProfit) ? { takeProfitPrice: Number(position.takeProfit) } : {}),
    unrealizedPnlUsd: position.unrealizedPnlUsd,
    openedAt: Date.parse(position.openedAt),
    status: 'OPEN',
  });
}

/**
 * Assemble a validated `PortfolioSnapshot` (MASTER_SPEC §7) from the paper
 * ledger. The snapshot is a read-only, frozen view — it never mutates state.
 *
 * @param {Readonly<PaperAccountState>} state
 * @param {{ timestamp?: number, source?: string }} [options]
 * @returns {Readonly<import('../domain/portfolio.mjs').PortfolioSnapshot>}
 */
export function toPortfolioSnapshot(state, options = {}) {
  const timestamp = Number.isFinite(options.timestamp) ? /** @type {number} */ (options.timestamp) : Date.now();
  return createPortfolioSnapshot({
    equityUsd: state.equityUsd,
    availableBalanceUsd: state.availableBalanceUsd,
    balances: [
      {
        asset: 'USDT',
        walletBalanceUsd: state.equityUsd,
        availableBalanceUsd: state.availableBalanceUsd,
        unrealizedPnlUsd: state.unrealizedPnlUsd,
        updatedAt: timestamp,
      },
    ],
    positions: state.positions.map(toDomainPosition),
    source: options.source ?? 'paper',
    timestamp,
  });
}

/**
 * Assemble a validated `PnLSnapshot` (MASTER_SPEC §7) from the paper ledger.
 *
 * Paper `realizedPnlUsd` is gross of fees, so the net figure subtracts them:
 * `netPnlUsd = realized + unrealized - fees`.
 *
 * @param {Readonly<PaperAccountState>} state
 * @param {{ symbol?: string, timestamp?: number }} [options]
 * @returns {Readonly<import('../domain/portfolio.mjs').PnLSnapshot>}
 */
export function toPnLSnapshot(state, options = {}) {
  const timestamp = Number.isFinite(options.timestamp) ? /** @type {number} */ (options.timestamp) : Date.now();
  return createPnLSnapshot({
    realizedPnlUsd: state.realizedPnlUsd,
    unrealizedPnlUsd: state.unrealizedPnlUsd,
    feesUsd: state.feesUsd,
    netPnlUsd: state.realizedPnlUsd + state.unrealizedPnlUsd - state.feesUsd,
    ...(options.symbol ? { symbol: options.symbol } : {}),
    timestamp,
  });
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