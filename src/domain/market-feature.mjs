/**
 * MarketFeature — one named numeric feature computed from market data
 * (MASTER_SPEC §7).
 *
 * The feature engine emits these; strategies and a future AI context builder
 * consume them. A feature is a plain measured value — it never encodes a
 * decision.
 *
 * @module domain/market-feature
 */
import {
  assertClosedFields,
  assertEpochMillis,
  assertOptionalEpochMillis,
  assertPlainObject,
  assertRequiredNumber,
  assertRequiredString,
  assertSymbol,
} from '../types/primitives.mjs';

export const MARKET_FEATURE_FIELDS = Object.freeze(['name', 'value', 'symbol', 'timestamp']);

/**
 * @typedef {object} MarketFeature
 * @property {string} name e.g. "smaFast", "atr"
 * @property {number} value finite
 * @property {string} [symbol] absent for cross-market features
 * @property {number} [timestamp] epoch milliseconds
 */

/**
 * Validate and freeze a MarketFeature.
 *
 * @param {unknown} raw
 * @returns {Readonly<MarketFeature>}
 * @throws {import('../errors/taxonomy.mjs').ValidationError}
 */
export function createMarketFeature(raw) {
  const input = assertPlainObject(raw, 'MarketFeature');
  assertClosedFields(input, MARKET_FEATURE_FIELDS, 'MarketFeature');

  return Object.freeze({
    name: assertRequiredString(input.name, 'MarketFeature.name', { maxLength: 64 }),
    value: assertRequiredNumber(input.value, 'MarketFeature.value'),
    symbol:
      input.symbol === undefined || input.symbol === null
        ? undefined
        : assertSymbol(input.symbol, 'MarketFeature.symbol'),
    timestamp: assertOptionalEpochMillis(input.timestamp, 'MarketFeature.timestamp'),
  });
}
