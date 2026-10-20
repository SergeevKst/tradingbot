/**
 * TESTNET_ONCE tests (TESTNET-ONCE-001).
 *
 * TESTNET_ONCE reuses the canonical TESTNET path — the same Risk Engine, kill
 * switch, journal, reconciliation engine and TestnetExecutionAdapter — and adds
 * exactly two things: a hard one-order invariant enforced at the execution
 * boundary, and a graceful shutdown after the first terminal outcome.
 *
 * No test touches the network: the authenticated client is a recording fake and
 * no real order is ever submitted.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TRADING_MODE,
  resolveTradingMode,
  isLiveMode,
  isOfflineMode,
  isTestnetMode,
  isTestnetOnceMode,
} from '../src/config/trading-mode.mjs';
import { loadConfig } from '../src/config/env.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { OrderError } from '../src/errors/taxonomy.mjs';
import { createTestnetExecutionAdapter } from '../src/execution/testnet-execution-adapter.mjs';
import { createTestnetSession } from '../src/session/testnet-session.mjs';
import { adapterKindForMode, createTradingSession } from '../src/session/trading-session.mjs';
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';
import { createKillSwitch } from '../src/risk/kill-switch.mjs';
import { quietLogger, marketAt, proposal } from './paper-fixtures.mjs';

const TESTNET_URL = 'https://api-testnet.bybit.com';

/** A recording authenticated-testnet client. Never signs and never dials out. */
function recordingClient(options = {}) {
  const calls = [];
  const client = {
    testnet: true,
    baseUrl: TESTNET_URL,
    calls,
    failWith: options.failWith ?? null,
    async placeOrder(order) {
      calls.push(order);
      if (client.failWith) throw client.failWith;
      return { orderId: `o-${calls.length}`, status: 'NEW', filledQuantity: 0 };
    },
    async getOrder() {
      return null;
    },
    async getPositions() {
      return { list: [] };
    },
    async getWalletBalance() {
      return { list: [{ totalEquity: '340', totalAvailableBalance: '340' }] };
    },
  };
  return client;
}

/** A minimal account view the Risk Engine accepts (no open positions). */
function accountProvider() {
  return Promise.resolve({
    initialEquityUsd: 340,
    equityUsd: 340,
    availableBalanceUsd: 340,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    feesUsd: 0,
    positions: [],
    openOrders: [],
    tradesToday: 0,
    dailyRealizedPnlUsd: 0,
    dayStartEquityUsd: 340,
    peakEquityUsd: 340,
    lastUpdatedAt: new Date(0).toISOString(),
  });
}

function makeAdapter(overrides = {}) {
  return createTestnetExecutionAdapter({
    testnet: true,
    client: overrides.client ?? recordingClient(),
    accountProvider,
    now: () => new Date(0).toISOString(),
    logger: quietLogger,
    ...overrides,
  });
}

async function makeSession(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'testnet-once-'));
  const adapter = options.adapter ?? makeAdapter(options.adapterOptions ?? {});
  const session = await createTestnetSession({
    adapter,
    riskConfig: options.riskConfig ?? DEFAULT_RISK_LIMITS,
    paths: { journalFile: join(directory, 'journal.jsonl') },
    killSwitch: options.killSwitch,
    now: () => new Date(0).toISOString(),
    logger: quietLogger,
    oneShot: options.oneShot,
    onShutdown: options.onShutdown,
  });
  return { session, adapter, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/** The single deep-valid proposal used for an approved entry. */
const goodProposal = () => proposal();

// ---------------------------------------------------------------------------
// 1. Mode enum
// ---------------------------------------------------------------------------
test('MODE: TESTNET_ONCE is a first-class mode, distinct from TESTNET', () => {
  assert.equal(TRADING_MODE.TESTNET_ONCE, 'TESTNET_ONCE');
  assert.equal(resolveTradingMode('testnet_once'), 'TESTNET_ONCE');
  assert.equal(resolveTradingMode('TESTNET_ONCE'), 'TESTNET_ONCE');

  assert.equal(isTestnetOnceMode(TRADING_MODE.TESTNET_ONCE), true);
  assert.equal(isTestnetOnceMode(TRADING_MODE.TESTNET), false);
  assert.equal(isTestnetMode(TRADING_MODE.TESTNET_ONCE), false, 'TESTNET_ONCE is its own mode');
  // It is a testnet mode, never live, never offline.
  assert.equal(isLiveMode(TRADING_MODE.TESTNET_ONCE), false);
  assert.equal(isOfflineMode(TRADING_MODE.TESTNET_ONCE), false);
});

// ---------------------------------------------------------------------------
// 2. Adapter selection
// ---------------------------------------------------------------------------
test('MODE: TESTNET_ONCE selects the canonical TESTNET adapter', () => {
  assert.equal(adapterKindForMode('TESTNET_ONCE'), 'TESTNET');
  assert.equal(adapterKindForMode(TRADING_MODE.TESTNET_ONCE), 'TESTNET');
  // LIVE and BACKTEST still have no in-process session.
  assert.throws(() => adapterKindForMode('LIVE'), ConfigError);
  assert.throws(() => adapterKindForMode('BACKTEST'), ConfigError);
});

// ---------------------------------------------------------------------------
// 3. Startup guards
// ---------------------------------------------------------------------------
test('STARTUP: TESTNET_ONCE pins the testnet host and refuses a live opt-in', () => {
  // Same host guard as TESTNET: mainnet must never be a silent fallback.
  assert.throws(
    () => loadConfig({ TRADING_MODE: 'TESTNET_ONCE' }),
    (error) => error instanceof ConfigError && /BYBIT_TESTNET=true/.test(error.message),
  );

  const config = loadConfig({ TRADING_MODE: 'TESTNET_ONCE', BYBIT_TESTNET: 'true' });
  assert.equal(config.tradingMode, 'TESTNET_ONCE');
  assert.equal(config.bybitBaseUrl, TESTNET_URL);
  assert.equal(config.testnet, true);
  assert.equal(config.offlineMode, false);

  // LIVE + TESTNET_ONCE is contradictory and must be rejected at startup.
  assert.throws(
    () => loadConfig({ TRADING_MODE: 'TESTNET_ONCE', BYBIT_TESTNET: 'true', ALLOW_LIVE_TRADING: 'true' }),
    (error) => error instanceof ConfigError && /TESTNET_ONCE/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// 4. LIVE isolation
// ---------------------------------------------------------------------------
test('STARTUP: LIVE is still rejected and TESTNET_ONCE refuses a non-testnet adapter', async () => {
  assert.throws(() => loadConfig({ TRADING_MODE: 'LIVE', ALLOW_LIVE_TRADING: 'true' }), ConfigError);
  await assert.rejects(() => createTradingSession({ mode: TRADING_MODE.LIVE }), ConfigError);

  const liveLike = {
    kind: () => 'LIVE',
    canPlaceRealOrders: false,
    openPosition: async () => ({ ok: false }),
    closePosition: async () => ({ ok: false }),
    modifyPositionProtection: async () => ({ ok: false }),
    getAccountState: accountProvider,
    getPosition: async () => null,
    getOpenPositions: async () => [],
  };
  await assert.rejects(
    () => createTestnetSession({ adapter: liveLike, riskConfig: DEFAULT_RISK_LIMITS, oneShot: true }),
    (error) => error instanceof ConfigError && /TESTNET adapter/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// 5. Session construction
// ---------------------------------------------------------------------------
test('SESSION: createTradingSession builds a one-shot TESTNET session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'testnet-once-'));
  try {
    const session = await createTradingSession({
      mode: TRADING_MODE.TESTNET_ONCE,
      testnet: {
        adapter: makeAdapter({ oneShot: true }),
        riskConfig: DEFAULT_RISK_LIMITS,
        paths: { journalFile: join(directory, 'journal.jsonl') },
        logger: quietLogger,
      },
    });
    assert.equal(session.mode, 'TESTNET_ONCE');
    assert.equal(session.adapterKind, 'TESTNET');
    assert.equal(session.oneShot, true);
    assert.equal(session.isShutdown(), false);
    assert.equal(session.ordersAttempted(), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Risk rejection -> 0 orders + shutdown
// ---------------------------------------------------------------------------
test('ONE-SHOT: a risk-rejected intent submits nothing and shuts down', async () => {
  const client = recordingClient();
  const { session, cleanup } = await makeSession({ adapterOptions: { client }, oneShot: true });
  try {
    // Stop loss on the wrong side of entry -> the Risk Engine rejects.
    const bad = proposal({ stopLossPrice: 87000, takeProfitPrice: 87620 });
    const outcome = await session.submit({ proposal: bad, market: await marketAt(86000).getSnapshot('BTCUSDT') });

    assert.equal(outcome.approved, false, outcome.reasonCode);
    assert.equal(outcome.executed, false);
    assert.equal(outcome.shutdown, true);
    assert.equal(client.calls.length, 0, 'a rejected intent must never reach the exchange');
    assert.equal(session.isShutdown(), true);
    assert.equal(session.shutdownInfo().reason, 'RISK_REJECTED');
    assert.equal(session.ordersAttempted(), 0);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. No valid intent -> 0 orders + shutdown
// ---------------------------------------------------------------------------
test('ONE-SHOT: no valid intent submits nothing and shuts down', async () => {
  const client = recordingClient();
  const { session, cleanup } = await makeSession({ adapterOptions: { client }, oneShot: true });
  try {
    const outcome = await session.submit({ proposal: null, market: await marketAt(86000).getSnapshot('BTCUSDT') });

    assert.equal(outcome.approved, false);
    assert.equal(outcome.executed, false);
    assert.equal(outcome.reasonCode, 'NO_SIGNAL');
    assert.equal(client.calls.length, 0);
    assert.equal(session.isShutdown(), true);
    assert.equal(session.shutdownInfo().reasonCode, 'NO_SIGNAL');
    assert.equal(session.ordersAttempted(), 0);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. One approved order + graceful shutdown
// ---------------------------------------------------------------------------
test('ONE-SHOT: the first approved order is submitted once and the session shuts down', async () => {
  const client = recordingClient();
  const shutdowns = [];
  const { session, cleanup } = await makeSession({
    adapterOptions: { client },
    oneShot: true,
    onShutdown: (info) => shutdowns.push(info),
  });
  try {
    const outcome = await session.submit({ proposal: goodProposal(), market: await marketAt(86000).getSnapshot('BTCUSDT') });

    assert.equal(outcome.approved, true, outcome.reasonCode);
    assert.equal(outcome.executed, true, outcome.reasonCode);
    assert.equal(outcome.shutdown, true);
    assert.equal(client.calls.length, 1, 'exactly one order reaches the exchange');
    assert.equal(session.ordersAttempted(), 1);

    assert.equal(session.isShutdown(), true);
    const info = session.shutdownInfo();
    assert.equal(info.mode, 'TESTNET_ONCE');
    assert.equal(info.reason, 'ORDER_COMPLETED');
    assert.equal(info.executed, true);
    assert.equal(info.ordersAttempted, 1);
    assert.equal(shutdowns.length, 1, 'the graceful shutdown hook fires exactly once');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. Hard one-order guard
// ---------------------------------------------------------------------------
test('GUARD: a second submission is refused and never reaches the exchange', async () => {
  const client = recordingClient();
  const { session, cleanup } = await makeSession({ adapterOptions: { client }, oneShot: true });
  try {
    const market = await marketAt(86000).getSnapshot('BTCUSDT');
    const first = await session.submit({ proposal: goodProposal(), market });
    assert.equal(first.executed, true, first.reasonCode);
    assert.equal(client.calls.length, 1);

    // A DIFFERENT proposal would have a different idempotency key, so the
    // one-shot guard — not the duplicate guard — is what must stop it.
    const second = await session.submit({ proposal: proposal({ timestamp: Date.now() + 1 }), market });
    assert.equal(second.approved, false);
    assert.equal(second.executed, false);
    assert.equal(second.reasonCode, 'ONE_SHOT_SHUTDOWN');
    assert.equal(client.calls.length, 1, 'no second order can ever reach the exchange');
  } finally {
    await cleanup();
  }
});

test('GUARD: the execution adapter itself refuses the second order in one-shot mode', async () => {
  const client = recordingClient();
  const adapter = makeAdapter({ client, oneShot: true });
  const request = {
    proposal: goodProposal(),
    riskResult: { approved: true, estimatedQuantity: 0.001, maxAllowedLeverage: 1 },
    market: await marketAt(86000).getSnapshot('BTCUSDT'),
  };

  const first = await adapter.openPosition(request);
  assert.equal(first.ok, true);
  assert.equal(client.calls.length, 1);
  assert.equal(adapter.ordersAttempted(), 1);

  const second = await adapter.openPosition(request);
  assert.equal(second.ok, false);
  assert.equal(second.reasonCode, 'ONE_SHOT_EXHAUSTED');
  assert.equal(client.calls.length, 1, 'the guard sits at the execution boundary');
});

// ---------------------------------------------------------------------------
// 10. Exchange failure -> shutdown, no retry
// ---------------------------------------------------------------------------
test('ONE-SHOT: an exchange refusal shuts the session down and never retries', async () => {
  const client = recordingClient({ failWith: new OrderError('exchange refused the order') });
  const { session, cleanup } = await makeSession({ adapterOptions: { client }, oneShot: true });
  try {
    const market = await marketAt(86000).getSnapshot('BTCUSDT');
    const outcome = await session.submit({ proposal: goodProposal(), market });

    assert.equal(outcome.approved, true, outcome.reasonCode);
    assert.equal(outcome.executed, false);
    assert.equal(outcome.shutdown, true);
    assert.equal(client.calls.length, 1, 'the failed order was attempted once');
    assert.equal(session.isShutdown(), true);
    assert.equal(session.shutdownInfo().reason, 'EXECUTION_FAILED');

    const second = await session.submit({ proposal: proposal({ timestamp: Date.now() + 1 }), market });
    assert.equal(second.executed, false);
    assert.equal(second.reasonCode, 'ONE_SHOT_SHUTDOWN');
    assert.equal(client.calls.length, 1, 'the failure never triggers a retry');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 11. Kill switch still governs the one-shot path
// ---------------------------------------------------------------------------
test('ONE-SHOT: an engaged kill switch stops the order and shuts down', async () => {
  const client = recordingClient();
  const killSwitch = createKillSwitch({ engaged: true, reason: 'test' });
  const { session, cleanup } = await makeSession({ adapterOptions: { client }, oneShot: true, killSwitch });
  try {
    const outcome = await session.submit({
      proposal: goodProposal(),
      market: await marketAt(86000).getSnapshot('BTCUSDT'),
    });

    assert.equal(outcome.approved, false);
    assert.equal(outcome.reasonCode, 'KILL_SWITCH_ENGAGED');
    assert.equal(client.calls.length, 0, 'the kill switch still precedes the exchange');
    assert.equal(session.isShutdown(), true);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 12. Continuous TESTNET is unchanged
// ---------------------------------------------------------------------------
test('REGRESSION: continuous TESTNET is untouched by the one-shot mode', async () => {
  const client = recordingClient();
  const { session, cleanup } = await makeSession({ adapterOptions: { client } });
  try {
    assert.equal(session.mode, 'TESTNET', 'continuous TESTNET keeps its mode label');
    assert.equal(session.oneShot, false);
    assert.equal(session.isShutdown(), false);

    const market = await marketAt(86000).getSnapshot('BTCUSDT');
    const first = await session.submit({ proposal: goodProposal(), market });
    assert.equal(first.executed, true, first.reasonCode);
    assert.equal(session.isShutdown(), false, 'continuous mode does not shut down after one order');

    // A distinct proposal is allowed: the one-order guard is off.
    const second = await session.submit({ proposal: proposal({ timestamp: Date.now() + 1 }), market });
    assert.equal(second.executed, true, second.reasonCode);
    assert.equal(client.calls.length, 2);
    assert.equal(session.isShutdown(), false);
  } finally {
    await cleanup();
  }
});
