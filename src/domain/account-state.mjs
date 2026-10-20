/**
 * AccountState — the snapshot of account reality the Risk Engine evaluates.
 *
 * The Risk Engine never fetches this itself: it receives it. That keeps the
 * engine pure and deterministic, and means a future stage can feed it either
 * live exchange data or a backtest snapshot without touching risk logic.
 *
 * @module domain/account-state
 */
import { REASON_CODE } from './reason-code.mjs';

/**
 * @typedef {object} OpenPosition
 * @property {string} symbol
 * @property {'LONG' | 'SHORT'} side
 * @property {number} quantity
 * @property {number} [entryPrice]
 * @property {number} [notionalUsd]
 */

/**
 * @typedef {object} OpenOrder
 * @property {string} symbol
 * @property {'LONG' | 'SHORT' | string} side
 * @property {string} [orderId]
 */

/**
 * @typedef {object} AccountState
 * @property {number} equityUsd total account equity in USD (the sizing base)
 * @property {number} availableBalanceUsd free margin in USD
 * @property {number} dailyRealizedPnlUsd realised PnL for the current UTC day
 * @property {number} peakEquityUsd equity high-water mark used for the drawdown check;
 *   defaults to the current equity when the caller cannot supply it (no drawdown known)
 * @property {OpenPosition[]} openPositions
 * @property {OpenOrder[]} openOrders
 * @property {number} [tradesToday] approved trades already taken today
 */

/**
 * @typedef {object} AccountValidationResult
 * @property {boolean} valid
 * @property {string | null} reasonCode
 * @property {AccountState | null} state
 */

/**
 * Validate and normalise an account snapshot.
 *
 * Fails closed: any malformed numeric is a rejection, because sizing from a
 * corrupt equity figure is exactly how a risk limit silently stops protecting
 * anything.
 *
 * @param {unknown} raw
 * @returns {AccountValidationResult}
 */
export function validateAccountState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reasonCode: REASON_CODE.INVALID_ACCOUNT_STATE, state: null };
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  const equityUsd = toFinite(input.equityUsd);
  const availableBalanceUsd = toFinite(input.availableBalanceUsd);
  const dailyRealizedPnlUsd = toFinite(input.dailyRealizedPnlUsd);
  const rawPeakEquityUsd = toFinite(input.peakEquityUsd);

  if (equityUsd === null || equityUsd <= 0) {
    return { valid: false, reasonCode: REASON_CODE.INVALID_ACCOUNT_STATE, state: null };
  }
  if (availableBalanceUsd === null || availableBalanceUsd < 0) {
    return { valid: false, reasonCode: REASON_CODE.INVALID_ACCOUNT_STATE, state: null };
  }
  if (dailyRealizedPnlUsd === null) {
    return { valid: false, reasonCode: REASON_CODE.INVALID_ACCOUNT_STATE, state: null };
  }
  // A supplied peak must be a real positive number. It is clamped up to the
  // current equity so a stale/rounded peak can never fabricate a drawdown or,
  // worse, a negative one.
  if (input.peakEquityUsd !== undefined && input.peakEquityUsd !== null && (rawPeakEquityUsd === null || rawPeakEquityUsd <= 0)) {
    return { valid: false, reasonCode: REASON_CODE.INVALID_ACCOUNT_STATE, state: null };
  }
  const peakEquityUsd = Math.max(rawPeakEquityUsd ?? equityUsd, equityUsd);

  const openPositions = Array.isArray(input.openPositions) ? input.openPositions : [];
  const openOrders = Array.isArray(input.openOrders) ? input.openOrders : [];

  for (const position of openPositions) {
    if (position === null || typeof position !== 'object') {
      return { valid: false, reasonCode: REASON_CODE.INVALID_ACCOUNT_STATE, state: null };
    }
    const p = /** @type {Record<string, unknown>} */ (position);
    if (typeof p.symbol !== 'string' || p.symbol.trim() === '') {
      return { valid: false, reasonCode: REASON_CODE.INVALID_ACCOUNT_STATE, state: null };
    }
    const quantity = toFinite(p.quantity);
    if (quantity === null || quantity <= 0) {
      return { valid: false, reasonCode: REASON_CODE.INVALID_ACCOUNT_STATE, state: null };
    }
  }

  const tradesToday = toFinite(input.tradesToday);

  /** @type {AccountState} */
  const state = Object.freeze({
    equityUsd,
    availableBalanceUsd,
    dailyRealizedPnlUsd,
    peakEquityUsd,
    openPositions: Object.freeze(openPositions.map((p) => {
      const pos = /** @type {Record<string, unknown>} */ (p);
      return Object.freeze({
        symbol: String(pos.symbol).trim().toUpperCase(),
        side: String(pos.side ?? '').trim().toUpperCase(),
        quantity: /** @type {number} */ (toFinite(pos.quantity)),
        entryPrice: toFinite(pos.entryPrice) ?? undefined,
        notionalUsd: toFinite(pos.notionalUsd) ?? undefined,
      });
    })),
    openOrders: Object.freeze(openOrders.map((o) => {
      const order = /** @type {Record<string, unknown>} */ (o ?? {});
      return Object.freeze({
        symbol: String(order.symbol ?? '').trim().toUpperCase(),
        side: String(order.side ?? '').trim().toUpperCase(),
        orderId: order.orderId === undefined ? undefined : String(order.orderId),
      });
    })),
    tradesToday: tradesToday === null ? 0 : Math.max(0, Math.trunc(tradesToday)),
  });

  return { valid: true, reasonCode: null, state };
}

/**
 * Build an account snapshot for offline runs, where no exchange snapshot exists.
 *
 * Clearly named so it can never be mistaken for live account data.
 *
 * @param {{ equityUsd: number, availableBalanceUsd?: number, dailyRealizedPnlUsd?: number }} seed
 * @returns {AccountState}
 */
export function createOfflineAccountState(seed) {
  const { valid, state } = validateAccountState({
    equityUsd: seed.equityUsd,
    availableBalanceUsd: seed.availableBalanceUsd ?? seed.equityUsd,
    dailyRealizedPnlUsd: seed.dailyRealizedPnlUsd ?? 0,
    peakEquityUsd: seed.equityUsd,
    openPositions: [],
    openOrders: [],
    tradesToday: 0,
  });
  if (!valid || state === null) {
    throw new Error('createOfflineAccountState received an invalid seed');
  }
  return state;
}

/** @returns {number | null} */
function toFinite(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}