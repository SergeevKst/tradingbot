/**
 * TESTNET bootstrap — wires the dedicated testnet configuration and the
 * authenticated testnet client into a TestnetSession.
 *
 * Credential handling stays entirely in `config/testnet.mjs`: this module never
 * touches the environment directly, never reads the production pair, and refuses
 * to start when testnet is not explicitly enabled. Read-only helpers map exchange
 * wallet/position payloads into the risk account view the Risk Engine consumes;
 * a missing equity figure maps to zero, which the Risk Engine rejects, so an
 * unreadable account fails closed instead of trading on a guessed balance.
 *
 * @module session/testnet-bootstrap
 */
import { ConfigError } from '../config/config-error.mjs';
import { loadTestnetConfig, loadTestnetCredentials } from '../config/testnet.mjs';
import { createBybitTestnetRestClient } from '../testnet/authenticated-rest-client.mjs';
import { createTestnetExecutionAdapter } from '../execution/testnet-execution-adapter.mjs';
import { createTestnetSession } from './testnet-session.mjs';

/**
 * Map a Bybit position payload into the position shape the account view needs.
 *
 * @param {Record<string, unknown>} raw
 * @returns {object | null}
 */
function mapPosition(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const quantity = Number(raw.size);
  const side = raw.side === 'Buy' ? 'LONG' : raw.side === 'Sell' ? 'SHORT' : null;
  if (!Number.isFinite(quantity) || quantity === 0 || side === null) return null;
  const entryPrice = Number(raw.avgPrice);
  return {
    symbol: raw.symbol,
    side,
    quantity,
    entryPrice: Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : 0,
    markPrice: Number.isFinite(Number(raw.markPrice)) ? Number(raw.markPrice) : undefined,
    unrealizedPnlUsd: Number.isFinite(Number(raw.unrealisedPnl)) ? Number(raw.unrealisedPnl) : 0,
    initialMarginUsd: Number.isFinite(Number(raw.positionValue)) ? Number(raw.positionValue) : 0,
  };
}

/**
 * Build an account provider that reads the authenticated testnet account. The
 * reads are public-equivalent authenticated GETs; nothing here can place an
 * order.
 *
 * @param {object} client authenticated testnet client
 * @param {{ now?: () => string }} [options]
 * @returns {() => Promise<object>}
 */
export function createTestnetAccountProvider(client, options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  return async function accountProvider() {
    const [wallet, positions] = await Promise.all([client.getWalletBalance(), client.getPositions()]);
    const summary = Array.isArray(wallet?.list) ? wallet.list[0] : undefined;

    const equityUsd = Number(summary?.totalEquity);
    const availableBalanceUsd = Number(summary?.totalAvailableBalance);
    const mapped = (Array.isArray(positions?.list) ? positions.list : []).map(mapPosition).filter((p) => p !== null);

    return {
      initialEquityUsd: Number.isFinite(equityUsd) && equityUsd > 0 ? equityUsd : 0,
      equityUsd: Number.isFinite(equityUsd) ? equityUsd : 0,
      availableBalanceUsd: Number.isFinite(availableBalanceUsd) ? availableBalanceUsd : Number.isFinite(equityUsd) ? equityUsd : 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: mapped.reduce((sum, p) => sum + p.unrealizedPnlUsd, 0),
      feesUsd: 0,
      positions: mapped,
      openOrders: [],
      tradesToday: 0,
      dailyRealizedPnlUsd: 0,
      dayStartEquityUsd: Number.isFinite(equityUsd) ? equityUsd : 0,
      peakEquityUsd: Number.isFinite(equityUsd) ? equityUsd : 0,
      lastUpdatedAt: now(),
    };
  };
}

/**
 * Build a TESTNET session from the environment, failing closed on a
 * half-configured testnet.
 *
 * @param {{ riskConfig: object, journalFile?: string, killSwitch?: object, now?: () => string, logger?: object, oneShot?: boolean }} options
 * @returns {Promise<Readonly<object>>}
 * @throws {ConfigError}
 */
export async function createTestnetSessionFromEnv(options) {
  const config = loadTestnetConfig();
  if (!config.enabled) {
    throw new ConfigError(
      'TRADING_MODE=TESTNET requires TESTNET_ENABLED=true. Refusing to start a testnet session that cannot authenticate.',
      { field: 'TESTNET_ENABLED' },
    );
  }
  const credentials = loadTestnetCredentials();

  const client = createBybitTestnetRestClient({
    testnet: true,
    baseUrl: config.restBaseUrl,
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    category: config.category,
  });

  const adapter = createTestnetExecutionAdapter({
    testnet: true,
    client,
    accountProvider: createTestnetAccountProvider(client, { now: options.now }),
    now: options.now,
    logger: options.logger,
    oneShot: options.oneShot === true,
  });

  return createTestnetSession({
    adapter,
    riskConfig: options.riskConfig,
    paths: { journalFile: options.journalFile ?? 'data/testnet/journal.jsonl' },
    killSwitch: options.killSwitch,
    now: options.now,
    logger: options.logger,
    oneShot: options.oneShot === true,
  });
}
