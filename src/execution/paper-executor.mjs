/**
 * PaperExecutor — simulation only.
 *
 * This module exists purely so approved proposals can be exercised end to end in
 * PAPER/BACKTEST tests. It has NO exchange client, NO MCP client, NO HTTP and NO
 * DeepSeek import, and it cannot place an order by construction: there is no
 * code path here that reaches the network.
 *
 * Its simulation is intentionally naive — it records the intended fill at the
 * proposal price and the risk figures the engine approved. It does NOT model
 * slippage, funding, partial fills or liquidation. Treat its output as a
 * rehearsal of the plumbing, never as evidence of strategy performance.
 *
 * @module execution/paper-executor
 */
import { ConfigError } from '../config/config-error.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';
import { isApproved } from '../domain/risk-result.mjs';
import { SIDE } from '../domain/side.mjs';
import { silentLogger } from '../util/logger.mjs';

/**
 * @typedef {object} SimulatedFill
 * @property {string} symbol
 * @property {'LONG' | 'SHORT'} side
 * @property {number} entryPrice
 * @property {number} stopLossPrice
 * @property {number} takeProfitPrice
 * @property {number} quantity
 * @property {number} notionalUsd
 * @property {number} riskAmountUsd
 * @property {boolean} simulated always true — makes the provenance unmistakable
 * @property {string} openedAt ISO timestamp
 * @property {string} strategyId
 */

/**
 * Create an executor that only simulates.
 *
 * @param {{ logger?: { info: Function, warn: Function, error: Function } }} [options]
 */
export function createPaperExecutor(options = {}) {
  const logger = options.logger ?? silentLogger;
  /** @type {SimulatedFill[]} */
  const fills = [];

  return Object.freeze({
    /** Always 'PAPER'. Guards against ever being mistaken for live execution. */
    kind: /** @type {const} */ ('PAPER'),
    /** Explicit capability flag: this executor cannot place real orders. */
    canPlaceRealOrders: /** @type {const} */ (false),

    /**
     * Rehearse an approved proposal.
     *
     * @param {unknown} proposal a validated TradeProposal
     * @param {import('../domain/risk-result.mjs').RiskResult} riskResult the engine's decision
     * @returns {Readonly<SimulatedFill>}
     * @throws {ConfigError} when handed a rejection or a malformed proposal
     */
    execute(proposal, riskResult) {
      if (!isApproved(riskResult)) {
        throw new ConfigError(
          `PaperExecutor refuses to execute a non-approved proposal (reason: ${riskResult.reasonCode}) — this is enforced, not advisory`,
          { field: 'riskResult', value: riskResult.reasonCode },
        );
      }
      if (proposal === null || typeof proposal !== 'object') {
        throw new ConfigError('PaperExecutor requires a validated proposal object');
      }
      if (![SIDE.LONG, SIDE.SHORT].includes(proposal.side)) {
        throw new ConfigError(`PaperExecutor requires a directional side, got ${JSON.stringify(proposal.side)}`, {
          field: 'side',
          value: proposal.side,
        });
      }

      /** @type {SimulatedFill} */
      const fill = Object.freeze({
        symbol: proposal.symbol,
        side: proposal.side,
        entryPrice: proposal.entryPrice,
        stopLossPrice: proposal.stopLossPrice,
        takeProfitPrice: proposal.takeProfitPrice,
        quantity: riskResult.estimatedQuantity,
        notionalUsd: riskResult.positionNotionalUsd,
        riskAmountUsd: riskResult.riskAmountUsd,
        simulated: true,
        openedAt: new Date().toISOString(),
        strategyId: proposal.strategyId,
      });

      fills.push(fill);
      logger.info('simulated fill recorded', {
        symbol: fill.symbol,
        side: fill.side,
        qty: fill.quantity,
        notionalUsd: fill.notionalUsd,
        simulated: true,
      });

      return fill;
    },

    /** Recorded (simulated) fills. */
    getFills() {
      return Object.freeze([...fills]);
    },

    /** @returns {number} */
    count() {
      return fills.length;
    },

    /**
     * Reset the simulation. Exposed for test isolation.
     */
    reset() {
      fills.length = 0;
    },
  });
}

/**
 * Reason code constant re-exported so callers can assert on PAPER-mode
 * behaviour without reaching into the domain layer.
 */
export const PAPER_EXECUTOR_REASON = REASON_CODE;