/**
 * TESTNET integration tests (TESTNET-INT-001).
 *
 * These lock in the first-class TESTNET mode and the canonical execution path:
 * mode resolution, adapter/session selection, and the two safety gates on the
 * TESTNET path (Risk REJECT and kill switch) — each verified by asserting that
 * no exchange call was made. No test touches the network: the authenticated
 * client is a recording fake.
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
} from '../src/config/trading-mode.mjs';
import { loadConfig } from '../src/config/env.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { assertExecutionAdapter } from '../src/execution/execution-adapter.mjs';
import { createTestnetExecutionAdapter } from '../src/execution/testnet-execution-adapter.mjs';
import { createTestnetSession } from '../src/session/testnet-session.mjs';
import { adapterKindForMode, createTradingSession } from '../src/session/trading-session.mjs';
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';
import { createKillSwitch } from '../src/risk/kill-switch.mjs';
import { quietLogger, marketAt, proposal } from './paper-fixtures.mjs';

const TESTNET_URL = 'https://api-testnet.bybit.com';

/** A recording authenticated-testnet client. Never signs and never dials out. */
function recordingClient() {
  const calls = [];
  const client = {
    testnet: true,
    baseUrl: TESTNET_URL,
    calls,
    async placeOrder(order) {
      calls.push(order);
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

async function makeTestnetSession(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'testnet-int-'));
  const adapter = options.adapter ?? makeAdapter(options.adapterOptions ?? {});
  const session = await createTestnetSession({
    adapter,
    riskConfig: options.riskConfig ?? DEFAULT_RISK_LIMITS,
    paths: { journalFile: join(directory, 'journal.jsonl') },
    killSwitch: options.killSwitch,
    now: () => new Date(0).toISOString(),
    logger: quietLogger,
  });
  return { session, adapter, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Mode enum
// ---------------------------------------------------------------------------
test('MODE: TESTNET is a first-class trading mode', () => {
  assert.equal(TRADING_MODE.TESTNET, 'TESTNET');
  assert.equal(resolveTradingMode('testnet'), 'TESTNET');
  assert.equal(resolveTradingMode('TESTNET'), 'TESTNET');
  assert.equal(isTestnetMode(TRADING_MODE.TESTNET), true);
  // TESTNET is not live: it never places real-money orders.
  assert.equal(isLiveMode(TRADING_MODE.TESTNET), false);
  assert.equal(isLiveMode(TRADING_MODE.LIVE), true);
  // TESTNET is not offline either: it talks to the testnet exchange.
  assert.equal(isOfflineMode(TRADING_MODE.TESTNET), false);
  assert.equal(isOfflineMode(TRADING_MODE.PAPER), true);
  assert.equal(isOfflineMode(TRADING_MODE.BACKTEST), true);
});

test('MODE: an ambiguous TESTNET configuration is refused at startup', () => {
  // TRADING_MODE=TESTNET with the host resolving to mainnet must abort, never
  // fall back to production.
  assert.throws(
    () => loadConfig({ TRADING_MODE: 'TESTNET' }),
    (error) => error instanceof ConfigError && /BYBIT_TESTNET=true/.test(error.message),
  );

  const config = loadConfig({ TRADING_MODE: 'TESTNET', BYBIT_TESTNET: 'true' });
  assert.equal(config.tradingMode, 'TESTNET');
  assert.equal(config.bybitBaseUrl, TESTNET_URL);
  assert.equal(config.offlineMode, false, 'TESTNET is not an offline mode');
});

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------
test('ADAPTER: implements the ExecutionAdapter contract and declares no real orders', () => {
  const adapter = makeAdapter();
  assert.equal(assertExecutionAdapter(adapter), adapter);
  assert.equal(adapter.kind(), 'TESTNET');
  assert.equal(adapter.canPlaceRealOrders, false);
  for (const method of ['openPosition', 'closePosition', 'modifyPositionProtection', 'getAccountState', 'getPosition', 'getOpenPositions']) {
    assert.equal(typeof adapter[method], 'function', `${method} must exist`);
  }
});

test('ADAPTER: refuses a non-testnet client or host', () => {
  assert.throws(() => makeAdapter({ client: { ...recordingClient(), testnet: false } }), ConfigError);
  assert.throws(() => makeAdapter({ client: { ...recordingClient(), baseUrl: 'https://api.bybit.com' } }), ConfigError);
  assert.throws(() => makeAdapter({ client: { ...recordingClient(), testnet: undefined } }), ConfigError);
  assert.throws(
    () => createTestnetExecutionAdapter({ client: recordingClient(), accountProvider }),
    (error) => error instanceof ConfigError && /testnet=true/.test(error.message),
  );
});

test('ADAPTER: refuses to execute a non-approved risk result', async () => {
  const adapter = makeAdapter();
  const result = await adapter.openPosition({
    proposal: proposal(),
    riskResult: { approved: false, estimatedQuantity: 1 },
    market: await marketAt(86000).getSnapshot('BTCUSDT'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'EXECUTION_REQUIRES_APPROVAL');
});

// ---------------------------------------------------------------------------
// Session selection
// ---------------------------------------------------------------------------
test('SESSION: mode selects PAPER or TESTNET and refuses LIVE/BACKTEST', () => {
  assert.equal(adapterKindForMode('PAPER'), 'PAPER');
  assert.equal(adapterKindForMode('TESTNET'), 'TESTNET');
  assert.throws(() => adapterKindForMode('LIVE'), ConfigError);
  assert.throws(() => adapterKindForMode('BACKTEST'), ConfigError);
  assert.throws(() => adapterKindForMode('NOPE'), ConfigError);
});

test('SESSION: createTradingSession builds a TESTNET session and refuses LIVE', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'testnet-int-'));
  try {
    const selected = await createTradingSession({
      mode: TRADING_MODE.TESTNET,
      testnet: {
        adapter: makeAdapter(),
        riskConfig: DEFAULT_RISK_LIMITS,
        paths: { journalFile: join(directory, 'journal.jsonl') },
        logger: quietLogger,
      },
    });
    assert.equal(selected.mode, 'TESTNET');
    assert.equal(selected.adapterKind, 'TESTNET');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  await assert.rejects(() => createTradingSession({ mode: TRADING_MODE.LIVE }), ConfigError);
});

test('SESSION: a PAPER adapter is refused by a TESTNET session', async () => {
  const paperLike = {
    kind: () => 'PAPER',
    canPlaceRealOrders: false,
    openPosition: async () => ({ ok: false }),
    closePosition: async () => ({ ok: false }),
    modifyPositionProtection: async () => ({ ok: false }),
    getAccountState: accountProvider,
    getPosition: async () => null,
    getOpenPositions: async () => [],
  };
  await assert.rejects(
    () => createTestnetSession({ adapter: paperLike, riskConfig: DEFAULT_RISK_LIMITS }),
    (error) => error instanceof ConfigError && /TESTNET adapter/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// Safety gates on the TESTNET path
// ---------------------------------------------------------------------------
test('SAFETY: a risk-rejected proposal makes no exchange call on the TESTNET path', async () => {
  const client = recordingClient();
  const { session, cleanup } = await makeTestnetSession({ adapterOptions: { client } });
  try {
    // Stop loss on the wrong side of entry -> the Risk Engine rejects.
    const bad = proposal({ stopLossPrice: 87000, takeProfitPrice: 87620 });
    const outcome = await session.submit({ proposal: bad, market: await marketAt(86000).getSnapshot('BTCUSDT') });

    assert.equal(outcome.approved, false, outcome.reasonCode);
    assert.equal(outcome.executed, false);
    assert.equal(client.calls.length, 0, 'a rejected proposal must not reach the exchange');
  } finally {
    await cleanup();
  }
});

test('SAFETY: an engaged kill switch makes no exchange call on the TESTNET path', async () => {
  const client = recordingClient();
  const killSwitch = createKillSwitch({ engaged: true, reason: 'test' });
  const { session, cleanup } = await makeTestnetSession({ adapterOptions: { client }, killSwitch });
  try {
    const outcome = await session.submit({ proposal: proposal(), market: await marketAt(86000).getSnapshot('BTCUSDT') });

    assert.equal(outcome.approved, false);
    assert.equal(outcome.reasonCode, 'KILL_SWITCH_ENGAGED');
    assert.equal(client.calls.length, 0, 'the kill switch must stop the order before the exchange');
  } finally {
    await cleanup();
  }
});

test('SAFETY: an approved TESTNET entry reaches the exchange exactly once (idempotent)', async () => {
  const client = recordingClient();
  const { session, cleanup } = await makeTestnetSession({ adapterOptions: { client } });
  try {
    const market = await marketAt(86000).getSnapshot('BTCUSDT');
    const sameProposal = proposal();
    const first = await session.submit({ proposal: sameProposal, market });
    assert.equal(first.approved, true, first.reasonCode);
    assert.equal(first.executed, true, first.reasonCode);
    assert.equal(client.calls.length, 1, 'an approved entry is submitted once');

    const second = await session.submit({ proposal: sameProposal, market });
    assert.equal(second.executed, false);
    assert.equal(second.reasonCode, 'DUPLICATE_ORDER', 'a resubmit of the same intent is blocked');
    assert.equal(client.calls.length, 1, 'the duplicate never reaches the exchange');
  } finally {
    await cleanup();
  }
});
