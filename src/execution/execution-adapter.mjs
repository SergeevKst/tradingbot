/**
 * ExecutionAdapter — the execution port, and the guards around it.
 *
 * The trading core talks to this interface, never to an exchange SDK. In this
 * stage there is exactly one implementation (`PaperExecutionAdapter`), and the
 * live case is refused rather than stubbed — a "TODO: real trading" code path
 * is exactly the kind of thing that later gets switched on by accident.
 *
 * The interface deliberately exposes NO account-mutating exchange operations:
 * no leverage change, no margin mode, no order amendment on the exchange. Those
 * are not delayed features here; they are absent capabilities.
 *
 * @module execution/execution-adapter
 */
import { ConfigError } from '../config/config-error.mjs';

/** Operations an execution adapter must provide. */
const REQUIRED_METHODS = Object.freeze([
  'openPosition',
  'closePosition',
  'modifyPositionProtection',
  'getAccountState',
  'getPosition',
  'getOpenPositions',
]);

/**
 * Bybit write operations that must never be reachable from the execution layer.
 *
 * Listed explicitly so the security test can assert their absence, and so any
 * future review can see precisely which capabilities were withheld.
 */
export const FORBIDDEN_EXCHANGE_OPERATIONS = Object.freeze([
  'createOrder',
  'batchCreateOrders',
  'amendOrder',
  'cancelOrder',
  'cancelAllOrders',
  'setLeverage',
  'setMarginMode',
  'setAutoAddMargin',
  'setTradingStop',
  'switchPositionMode',
]);

/**
 * @typedef {object} OpenPositionRequest
 * @property {import('../domain/proposal.mjs').TradeProposal} proposal
 * @property {import('../domain/risk-result.mjs').ApprovedRiskResult} riskResult
 * @property {import('../market/market-snapshot.mjs').MarketSnapshot} market
 * @property {string} [timestamp]
 */

/**
 * @typedef {object} Fill
 * @property {string} symbol
 * @property {'LONG' | 'SHORT'} side
 * @property {number} quantity filled quantity (equals `filledQuantity`)
 * @property {number} [requestedQuantity] size that was ordered, when it differs
 * @property {number} [filledQuantity] filled size; a partial fill is smaller
 * @property {number} [unfilledQuantity] cancelled remainder of a partial fill
 * @property {boolean} [partial] true when the order only partly filled
 * @property {number} requestedPrice price the caller expected
 * @property {number} fillPrice price actually simulated
 * @property {number} slippageUsd signed cost of the simulated slippage
 * @property {number} feeUsd
 * @property {number} notionalUsd
 * @property {string} timestamp
 */

/**
 * @typedef {object} ExecutionResult
 * @property {boolean} ok
 * @property {string} [reasonCode]
 * @property {string} [message]
 * @property {Fill} [fill]
 * @property {import('../state/paper-account.mjs').PaperAccountState} [account]
 * @property {import('../state/paper-position.mjs').PaperPosition} [position]
 */

/**
 * @typedef {object} ExecutionAdapter
 * @property {() => string} kind "PAPER"
 * @property {boolean} canPlaceRealOrders always false in this stage
 * @property {(request: OpenPositionRequest) => Promise<ExecutionResult>} openPosition
 * @property {(input: { symbol: string, price?: number, reason?: string, market?: unknown, timestamp?: string }) => Promise<ExecutionResult>} closePosition
 * @property {(input: { symbol: string, stopLoss?: number | null, takeProfit?: number | null }) => Promise<ExecutionResult>} modifyPositionProtection
 * @property {() => Promise<import('../state/paper-account.mjs').PaperAccountState>} getAccountState
 * @property {(symbol: string) => Promise<import('../state/paper-position.mjs').PaperPosition | null>} getPosition
 * @property {() => Promise<import('../state/paper-position.mjs').PaperPosition[]>} getOpenPositions
 * @property {(market: unknown) => Promise<{ closed: Array<{ symbol: string, exitReason: string, fill: Fill }>, updated: number }>} [onMarketUpdate]
 */

/**
 * Assert an object satisfies the adapter contract.
 *
 * @param {unknown} adapter
 * @returns {ExecutionAdapter}
 * @throws {ConfigError}
 */
export function assertExecutionAdapter(adapter) {
  if (adapter === null || typeof adapter !== 'object') {
    throw new ConfigError('ExecutionAdapter must be an object');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof /** @type {any} */ (adapter)[method] !== 'function') {
      throw new ConfigError(`ExecutionAdapter.${method}() is required`);
    }
  }
  if (typeof /** @type {any} */ (adapter).kind !== 'function') {
    throw new ConfigError('ExecutionAdapter.kind() is required');
  }
  if (/** @type {any} */ (adapter).canPlaceRealOrders !== false) {
    // Fail closed: an adapter that will not explicitly deny real trading is not
    // trusted to be a paper adapter.
    throw new ConfigError('ExecutionAdapter must declare canPlaceRealOrders === false in this stage');
  }
  return /** @type {ExecutionAdapter} */ (adapter);
}