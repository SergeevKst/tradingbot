/**
 * Signal sources for the backtest engine.
 *
 * A signal source is the one strategy-shaped seam in the backtest. It receives
 * the replayed market and returns a TradeProposal or `null` ("no signal"). It
 * NEVER sizes, never touches the account and never places an order — whatever it
 * returns still travels through the unchanged Risk Engine and paper executor.
 *
 * Two sources ship here:
 *   - `createStrategySignalSource` replays a registered strategy verbatim, the
 *     same `evaluate(context)` production uses;
 *   - `createAISignalSource` replays a strategy *gated by AI analysis* — the
 *     deterministic proposal is vetoed when the model disagrees, so AI replay is
 *     possible offline (with the mock provider) without letting AI size a trade.
 *
 * @module backtest/signal-source
 */
import { ConfigError } from '../config/config-error.mjs';
import { assertStrategy, buildMarketContext } from '../strategy/strategy-interface.mjs';
import { assertAIProvider } from '../ai/interface.mjs';
import { buildAIContext } from '../ai/context-builder.mjs';

/**
 * @typedef {(input: {
 *   market: Readonly<import('../market/market-snapshot.mjs').MarketSnapshot>,
 *   candles: readonly import('../market/market-snapshot.mjs').Candle[],
 *   index: number,
 *   account: Readonly<import('../state/paper-account.mjs').PaperAccountState>,
 *   dailyState: Readonly<import('../state/daily-state.mjs').DailyState>,
 *   riskConfig: Readonly<import('../config/risk.mjs').RiskLimits>,
 * }) => (import('../domain/proposal.mjs').TradeProposal | null) | Promise<import('../domain/proposal.mjs').TradeProposal | null>} SignalSource
 */

/**
 * @param {unknown} source
 * @returns {SignalSource}
 * @throws {ConfigError}
 */
export function assertSignalSource(source) {
  if (typeof source !== 'function') {
    throw new ConfigError('SignalSource must be a function returning a proposal or null');
  }
  return /** @type {SignalSource} */ (source);
}

/**
 * Replay a deterministic strategy exactly as production runs it.
 *
 * @param {object} strategy a strategy built by `defineStrategy`
 * @returns {SignalSource}
 */
export function createStrategySignalSource(strategy) {
  const defined = assertStrategy(strategy);
  return async ({ market }) => {
    const context = buildMarketContext(market, defined.indicators);
    // A strategy returning null is a deliberate "no signal"; a throw is caught
    // by the engine and also resolves to no signal (fail closed).
    const proposal = defined.evaluate(context);
    return proposal ?? null;
  };
}

/**
 * Replay a strategy that AI analysis gates.
 *
 * Both sit in the analysis lane only: the strategy produces the price geometry,
 * the model may veto a proposal it disagrees with, and neither can size or place
 * anything. An invalid/absent analysis is a veto (MASTER_SPEC §11).
 *
 * @param {{ strategy: object, provider: object }} options
 * @returns {SignalSource}
 */
export function createAISignalSource(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createAISignalSource requires { strategy, provider }');
  }
  const strategy = assertStrategy(options.strategy);
  const provider = assertAIProvider(options.provider);

  return async ({ market }) => {
    const context = buildMarketContext(market, strategy.indicators);
    const proposal = strategy.evaluate(context);
    if (proposal === null || proposal === undefined) return null;

    const aiContext = buildAIContext({ market, strategy: { id: strategy.id } });
    const outcome = await provider.analyze(aiContext);
    if (!outcome?.ok || !outcome.analysis) return null;

    const bias = outcome.analysis.bias;
    if (bias === 'NEUTRAL') return proposal;
    if (proposal.side === 'LONG' && bias === 'BULLISH') return proposal;
    if (proposal.side === 'SHORT' && bias === 'BEARISH') return proposal;
    return null;
  };
}
