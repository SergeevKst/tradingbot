/**
 * Shared test fixtures.
 *
 * Every fixture is a pure factory so a test can never observe mutation by
 * another test. Nothing here touches the network, the exchange or the clock.
 */
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';

export { DEFAULT_RISK_LIMITS };

/**
 * A logged-in-looking but entirely local account snapshot.
 *
 * @param {Partial<{ equityUsd: number, availableBalanceUsd: number, dailyRealizedPnlUsd: number, openPositions: any[], openOrders: any[], tradesToday: number, tradedSymbolsToday: string[] }>} [overrides]
 */
export function accountState(overrides = {}) {
  const equityUsd = overrides.equityUsd ?? 340;
  return {
    equityUsd,
    availableBalanceUsd: equityUsd,
    dailyRealizedPnlUsd: 0,
    // Default the high-water mark to the current equity so the fixture starts
    // with no drawdown unless a test says otherwise.
    peakEquityUsd: equityUsd,
    openPositions: [],
    openOrders: [],
    tradesToday: 0,
    tradedSymbolsToday: [],
    ...overrides,
  };
}

/**
 * A valid LONG proposal: RR = (87600 - 86000) / (86000 - 85280) = 2.222…
 */
export function longProposal(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 86000,
    stopLossPrice: 85280,
    takeProfitPrice: 87600,
    confidence: 0.5,
    strategyId: 'test-strategy',
    timestamp: 1_760_000_000_000,
    ...overrides,
  };
}

/**
 * A valid SHORT proposal: RR = (86000 - 85280) / (86800 - 86000) = 0.9 — needs
 * a wider target to clear the RR floor, so the default target is 84400.
 */
export function shortProposal(overrides = {}) {
  return {
    symbol: 'ETHUSDT',
    side: 'SHORT',
    entryPrice: 86000,
    stopLossPrice: 86800,
    takeProfitPrice: 84400,
    confidence: 0.5,
    strategyId: 'test-strategy',
    timestamp: 1_760_000_000_000,
    ...overrides,
  };
}

/** Risk limits with an override applied. */
export function riskLimits(overrides = {}) {
  return { ...DEFAULT_RISK_LIMITS, killSwitchEnabled: false, ...overrides };
}