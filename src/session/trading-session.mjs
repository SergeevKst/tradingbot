/**
 * Trading-session factory — the single place that maps a TRADING_MODE to an
 * execution session, and therefore to an execution adapter.
 *
 *   PAPER        -> PaperSession (local simulated fills)
 *   TESTNET      -> TestnetSession (authenticated, testnet-only orders)
 *   TESTNET_ONCE -> TestnetSession in one-shot mode (same TESTNET adapter, at
 *                   most one order, then graceful shutdown)
 *   LIVE         -> refused: no live execution path exists in this build
 *   BACKTEST     -> refused here; it is an offline engine, not a trading session
 *
 * Refusing is the important part. A mode with no honest execution path must
 * never silently degrade to a different one, so an unknown or unsupported mode
 * throws rather than falling back.
 *
 * @module session/trading-session
 */
import { ConfigError } from '../config/config-error.mjs';
import { TRADING_MODE, resolveTradingMode } from '../config/trading-mode.mjs';
import { createPaperSession } from './paper-session.mjs';
import { createTestnetSession } from './testnet-session.mjs';

/** The execution adapter a mode is allowed to use. Unknown -> throw. */
const MODE_TO_ADAPTER_KIND = Object.freeze({
  [TRADING_MODE.PAPER]: 'PAPER',
  [TRADING_MODE.TESTNET]: 'TESTNET',
  // TESTNET_ONCE reuses the exact same authenticated TESTNET adapter; the
  // one-shot distinction is a session option, never a new execution path.
  [TRADING_MODE.TESTNET_ONCE]: 'TESTNET',
});

/**
 * The adapter kind a mode selects, or a throw for a mode with no in-process
 * order path. Pure, so a startup check can assert the mapping without wiring a
 * client.
 *
 * @param {unknown} mode
 * @returns {'PAPER' | 'TESTNET'}
 * @throws {ConfigError}
 */
export function adapterKindForMode(mode) {
  const resolved = resolveTradingMode(mode);
  const kind = MODE_TO_ADAPTER_KIND[resolved];
  if (kind === undefined) {
    throw new ConfigError(
      `${resolved} has no in-process execution session: LIVE is not implemented and BACKTEST is an offline engine.`,
      { field: 'tradingMode', value: resolved },
    );
  }
  return kind;
}

/**
 * @typedef {object} TradingSessionOptions
 * @property {unknown} mode raw or resolved TRADING_MODE
 * @property {object} [paper] options for `createPaperSession`
 * @property {object} [testnet] options for `createTestnetSession` (must carry a TESTNET adapter)
 */

/**
 * Create the session the resolved mode selects.
 *
 * @param {TradingSessionOptions} options
 * @returns {Promise<Readonly<object>>}
 * @throws {ConfigError}
 */
export async function createTradingSession(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createTradingSession requires options');
  }
  const mode = resolveTradingMode(options.mode);

  if (mode === TRADING_MODE.PAPER) {
    return createPaperSession(options.paper);
  }
  if (mode === TRADING_MODE.TESTNET) {
    return createTestnetSession(options.testnet);
  }
  if (mode === TRADING_MODE.TESTNET_ONCE) {
    // Same canonical TESTNET session and adapter; only the one-shot flag differs.
    return createTestnetSession({ ...(options.testnet ?? {}), oneShot: true });
  }
  // adapterKindForMode owns the refusal message, so there is one wording.
  adapterKindForMode(mode);
  throw new ConfigError(`No session for ${mode}`, { field: 'tradingMode', value: mode });
}
