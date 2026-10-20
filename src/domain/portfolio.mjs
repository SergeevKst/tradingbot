/**
 * Portfolio domain types: Balance, PortfolioSnapshot and PnLSnapshot
 * (MASTER_SPEC §7).
 *
 * These are read-only views of account reality assembled by a portfolio layer
 * from exchange data. They are pure value objects: nothing here fetches, signs
 * or mutates anything.
 *
 * @module domain/portfolio
 */
import {
  assertClosedFields,
  assertEpochMillis,
  assertOptionalEpochMillis,
  assertOptionalNumber,
  assertPlainObject,
  assertRequiredNumber,
  assertRequiredString,
  assertSymbol,
} from '../types/primitives.mjs';
import { ValidationError } from '../errors/taxonomy.mjs';
import { createPosition } from './position.mjs';

export const BALANCE_FIELDS = Object.freeze([
  'asset',
  'walletBalanceUsd',
  'availableBalanceUsd',
  'unrealizedPnlUsd',
  'updatedAt',
]);

export const PORTFOLIO_SNAPSHOT_FIELDS = Object.freeze([
  'equityUsd',
  'availableBalanceUsd',
  'balances',
  'positions',
  'source',
  'timestamp',
]);

export const PNL_SNAPSHOT_FIELDS = Object.freeze([
  'realizedPnlUsd',
  'unrealizedPnlUsd',
  'feesUsd',
  'netPnlUsd',
  'symbol',
  'timestamp',
]);

/**
 * @typedef {object} Balance
 * @property {string} asset e.g. "USDT"
 * @property {number} walletBalanceUsd
 * @property {number} availableBalanceUsd
 * @property {number} [unrealizedPnlUsd] signed, finite
 * @property {number} [updatedAt] epoch milliseconds
 */

/**
 * @typedef {object} PortfolioSnapshot
 * @property {number} equityUsd
 * @property {number} availableBalanceUsd
 * @property {readonly Balance[]} balances
 * @property {readonly import('./position.mjs').Position[]} positions
 * @property {string} [source] where the snapshot came from, e.g. "paper"
 * @property {number} timestamp epoch milliseconds
 */

/**
 * @typedef {object} PnLSnapshot
 * @property {number} realizedPnlUsd signed, finite
 * @property {number} unrealizedPnlUsd signed, finite
 * @property {number} feesUsd
 * @property {number} netPnlUsd signed, finite
 * @property {string} [symbol] absent for an account-wide snapshot
 * @property {number} timestamp epoch milliseconds
 */

/**
 * @param {unknown} raw
 * @returns {Readonly<Balance>}
 * @throws {import('../errors/taxonomy.mjs').ValidationError}
 */
export function createBalance(raw) {
  const input = assertPlainObject(raw, 'Balance');
  assertClosedFields(input, BALANCE_FIELDS, 'Balance');

  return Object.freeze({
    asset: assertSymbol(input.asset, 'Balance.asset'),
    walletBalanceUsd: assertRequiredNumber(input.walletBalanceUsd, 'Balance.walletBalanceUsd', { min: 0 }),
    availableBalanceUsd: assertRequiredNumber(input.availableBalanceUsd, 'Balance.availableBalanceUsd', { min: 0 }),
    unrealizedPnlUsd: assertOptionalNumber(input.unrealizedPnlUsd, 'Balance.unrealizedPnlUsd'),
    updatedAt: assertOptionalEpochMillis(input.updatedAt, 'Balance.updatedAt'),
  });
}

/**
 * @param {unknown} raw
 * @returns {Readonly<PortfolioSnapshot>}
 * @throws {import('../errors/taxonomy.mjs').ValidationError}
 */
export function createPortfolioSnapshot(raw) {
  const input = assertPlainObject(raw, 'PortfolioSnapshot');
  assertClosedFields(input, PORTFOLIO_SNAPSHOT_FIELDS, 'PortfolioSnapshot');

  if (!Array.isArray(input.balances)) {
    throw new ValidationError('PortfolioSnapshot.balances must be an array', { details: { field: 'balances' } });
  }
  if (!Array.isArray(input.positions)) {
    throw new ValidationError('PortfolioSnapshot.positions must be an array', { details: { field: 'positions' } });
  }

  return Object.freeze({
    equityUsd: assertRequiredNumber(input.equityUsd, 'PortfolioSnapshot.equityUsd', { exclusiveMin: 0 }),
    availableBalanceUsd: assertRequiredNumber(input.availableBalanceUsd, 'PortfolioSnapshot.availableBalanceUsd', {
      min: 0,
    }),
    balances: Object.freeze(input.balances.map(createBalance)),
    positions: Object.freeze(input.positions.map(createPosition)),
    source:
      input.source === undefined || input.source === null
        ? undefined
        : assertRequiredString(input.source, 'PortfolioSnapshot.source'),
    timestamp: assertEpochMillis(input.timestamp, 'PortfolioSnapshot.timestamp'),
  });
}

/**
 * @param {unknown} raw
 * @returns {Readonly<PnLSnapshot>}
 * @throws {import('../errors/taxonomy.mjs').ValidationError}
 */
export function createPnLSnapshot(raw) {
  const input = assertPlainObject(raw, 'PnLSnapshot');
  assertClosedFields(input, PNL_SNAPSHOT_FIELDS, 'PnLSnapshot');

  return Object.freeze({
    realizedPnlUsd: assertRequiredNumber(input.realizedPnlUsd, 'PnLSnapshot.realizedPnlUsd'),
    unrealizedPnlUsd: assertRequiredNumber(input.unrealizedPnlUsd, 'PnLSnapshot.unrealizedPnlUsd'),
    feesUsd: assertRequiredNumber(input.feesUsd ?? 0, 'PnLSnapshot.feesUsd', { min: 0 }),
    netPnlUsd: assertRequiredNumber(input.netPnlUsd, 'PnLSnapshot.netPnlUsd'),
    symbol:
      input.symbol === undefined || input.symbol === null ? undefined : assertSymbol(input.symbol, 'PnLSnapshot.symbol'),
    timestamp: assertEpochMillis(input.timestamp, 'PnLSnapshot.timestamp'),
  });
}
