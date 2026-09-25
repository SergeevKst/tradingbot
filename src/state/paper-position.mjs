/**
 * PaperPosition — an open simulated position.
 *
 * Unrealized PnL for a linear USDT perpetual is a pure, deterministic function
 * of two prices and a size. No AI, no heuristics, no rounding surprises:
 *
 *   LONG : PnL = (markPrice - entryPrice) * quantity
 *   SHORT: PnL = (entryPrice - markPrice) * quantity
 *
 * Note that these are `markPrice`-based figures and exclude fees. Fees are
 * accounted separately on the account (see `fee-model.mjs`), so "unrealized PnL"
 * always means the same thing everywhere it appears.
 *
 * @module state/paper-position
 */
import { ConfigError } from '../config/config-error.mjs';
import { SIDE, resolveSide } from '../domain/side.mjs';

/**
 * @typedef {object} PaperPosition
 * @property {string} symbol
 * @property {'LONG' | 'SHORT'} side
 * @property {number} quantity base units, already normalized to qtyStep
 * @property {number} entryPrice normalized fill price
 * @property {number} markPrice latest observed price
 * @property {number} leverage effective leverage intended for this position
 * @property {number} initialMarginUsd margin reserved when the position opened
 * @property {number | null} stopLoss
 * @property {number | null} takeProfit
 * @property {number} unrealizedPnlUsd
 * @property {number} realizedPnlUsd
 * @property {string} openedAt ISO timestamp
 * @property {string} updatedAt ISO timestamp
 */

/**
 * Unrealized PnL for a linear USDT perpetual.
 *
 * @param {{ side: 'LONG' | 'SHORT', entryPrice: number, markPrice: number, quantity: number }} input
 * @returns {number}
 */
export function computeUnrealizedPnl(input) {
  const { side, entryPrice, markPrice, quantity } = input;
  for (const [field, value] of Object.entries({ entryPrice, markPrice, quantity })) {
    if (!Number.isFinite(value)) {
      throw new ConfigError(`computeUnrealizedPnl: ${field} must be finite, got ${JSON.stringify(value)}`, {
        field,
      });
    }
  }
  const direction = resolveSide(side) === SIDE.LONG ? 1 : -1;
  const pnl = (markPrice - entryPrice) * quantity * direction;

  // Normalize negative zero: `-0` is a distinct value under Object.is and
  // survives JSON round trips inconsistently, which would make two identical
  // accounts compare as different. A flat position must be exactly 0.
  return pnl === 0 ? 0 : pnl;
}

/**
 * Initial margin for an isolated position.
 *
 * @param {{ notionalUsd: number, leverage: number }} input
 * @returns {number}
 */
export function computeInitialMargin(input) {
  const { notionalUsd, leverage } = input;
  if (!Number.isFinite(notionalUsd) || notionalUsd < 0) {
    throw new ConfigError(`computeInitialMargin: notionalUsd must be >= 0, got ${JSON.stringify(notionalUsd)}`);
  }
  if (!Number.isFinite(leverage) || leverage <= 0) {
    throw new ConfigError(`computeInitialMargin: leverage must be > 0, got ${JSON.stringify(leverage)}`);
  }
  return notionalUsd / leverage;
}

/**
 * Validate and freeze a position.
 *
 * @param {unknown} raw
 * @returns {Readonly<PaperPosition>}
 * @throws {ConfigError}
 */
export function validatePaperPosition(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('PaperPosition must be an object', { field: 'position' });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  if (typeof input.symbol !== 'string' || input.symbol.trim() === '') {
    throw new ConfigError('PaperPosition.symbol is required', { field: 'symbol', value: input.symbol });
  }
  const side = resolveSide(input.side);
  if (side === null) {
    throw new ConfigError(`PaperPosition.side must be LONG or SHORT, got ${JSON.stringify(input.side)}`, {
      field: 'side',
      value: input.side,
    });
  }

  for (const field of ['quantity', 'entryPrice', 'markPrice']) {
    const value = Number(input[field]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new ConfigError(`PaperPosition.${field} must be a positive number, got ${JSON.stringify(input[field])}`, {
        field,
        value: input[field],
      });
    }
  }

  const leverage = Number(input.leverage);
  if (!Number.isFinite(leverage) || leverage <= 0) {
    throw new ConfigError(`PaperPosition.leverage must be > 0, got ${JSON.stringify(input.leverage)}`, {
      field: 'leverage',
      value: input.leverage,
    });
  }

  const stopLoss = optionalLevel(input.stopLoss, 'stopLoss');
  const takeProfit = optionalLevel(input.takeProfit, 'takeProfit');

  const quantity = Number(input.quantity);
  const entryPrice = Number(input.entryPrice);
  const markPrice = Number(input.markPrice);

  return Object.freeze({
    symbol: String(input.symbol).trim().toUpperCase(),
    side,
    quantity,
    entryPrice,
    markPrice,
    leverage,
    initialMarginUsd: Number.isFinite(Number(input.initialMarginUsd))
      ? Number(input.initialMarginUsd)
      : computeInitialMargin({ notionalUsd: entryPrice * quantity, leverage }),
    stopLoss,
    takeProfit,
    unrealizedPnlUsd: computeUnrealizedPnl({ side, entryPrice, markPrice, quantity }),
    realizedPnlUsd: Number.isFinite(Number(input.realizedPnlUsd)) ? Number(input.realizedPnlUsd) : 0,
    openedAt: typeof input.openedAt === 'string' ? input.openedAt : new Date().toISOString(),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
  });
}

/**
 * Re-price a position at a new mark, recomputing unrealized PnL.
 *
 * @param {Readonly<PaperPosition>} position
 * @param {number} markPrice
 * @param {string} updatedAt ISO timestamp
 * @returns {Readonly<PaperPosition>}
 */
export function markPosition(position, markPrice, updatedAt) {
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    throw new ConfigError(`markPosition: markPrice must be > 0, got ${JSON.stringify(markPrice)}`);
  }
  return validatePaperPosition({
    ...position,
    markPrice,
    updatedAt,
  });
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number | null}
 */
function optionalLevel(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`PaperPosition.${field} must be a positive number or null, got ${JSON.stringify(value)}`, {
      field,
      value,
    });
  }
  return parsed;
}

export { SIDE };