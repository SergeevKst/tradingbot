/**
 * PAPER session validation — the canonical path from `trading-session.mjs`.
 *
 * Each test below exercises one of the five properties the readiness review has
 * to be able to state as fact for the PAPER path:
 *
 *   1. the session factory selects PAPER and refuses LIVE/BACKTEST;
 *   2. market-data freshness — what is enforced, and by whom;
 *   3. the deterministic risk gate (including the runtime kill switch);
 *   4. simulated fills are deterministic and pessimistic;
 *   5. recovery restores the account and protection continues while stopped.
 *
 * Two of these tests assert a GAP rather than a feature: the PAPER session has
 * no staleness gate of its own, and the runtime kill switch is in-memory only.
 * They are characterization tests on purpose — the gap should be visible in the
 * suite, not discovered in production. Both are recorded in
 * `docs/paper-readiness/AI_PIPELINE_READINESS.md`.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTradingSession } from '../src/session/trading-session.mjs';
import { createMarketSnapshot } from '../src/market/market-snapshot.mjs';
import { createMarketStateCache } from '../src/market-data/market-state-cache.mjs';
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { REASON_CODE } from '../src/domain/reason-code.mjs';
import { JOURNAL_EVENT } from '../src/state/journal.mjs';
import { BTC_INSTRUMENT, makeSession, marketAt, proposal, quietLogger, feeModel } from './paper-fixtures.mjs';

/**
 * Build a PAPER session through the canonical factory, not by importing the
 * paper session module directly.
 *
 * @param {{ riskConfig?: object, directory?: string }} [options]
 */
async function makeCanonicalSession(options = {}) {
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), 'paper-canonical-')));
  const session = await createTradingSession({
    mode: 'PAPER',
    paper: {
      riskConfig: options.riskConfig ?? DEFAULT_RISK_LIMITS,
      feeModel: feeModel(),
      paths: {
        stateFile: join(directory, 'state.json'),
        journalFile: join(directory, 'journal.jsonl'),
        initialEquityUsd: 340,
      },
      logger: quietLogger,
    },
  });
  return { session, directory };
}

// ---------------------------------------------------------------------------
// 1. The session factory
// ---------------------------------------------------------------------------
test('SESSION: the factory builds a working PAPER session', async () => {
  const { session, directory } = await makeCanonicalSession();
  try {
    const market = marketAt(86000);
    const outcome = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    assert.equal(outcome.approved, true, outcome.reasonCode);
    assert.equal(outcome.executed, true, outcome.reasonCode);

    const account = await session.getAccountState();
    assert.equal(account.positions.length, 1);
    assert.ok(account.equityUsd < 340, 'the simulated entry fee was charged');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SESSION: the factory refuses LIVE and BACKTEST — no fallback path exists', async () => {
  await assert.rejects(
    () => createTradingSession({ mode: 'LIVE' }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /LIVE is not implemented/);
      return true;
    },
  );
  await assert.rejects(() => createTradingSession({ mode: 'BACKTEST' }), ConfigError);
  await assert.rejects(() => createTradingSession({ mode: 'NOT_A_MODE' }), ConfigError);
});

// ---------------------------------------------------------------------------
// 2. Market-data freshness
// ---------------------------------------------------------------------------
test('MARKET DATA: staleness detection exists at the cache boundary', () => {
  // This is the mechanism a long-running PAPER loop has to use: the cache knows
  // when its view went stale, and the service refuses to let a bad message
  // refresh that timestamp.
  let now = 1_700_000_000_000;
  const cache = createMarketStateCache({ now: () => now, staleAfterMs: 1000 });
  cache.applyTick({ symbol: 'BTCUSDT', price: 86000, bid: 85999.9, ask: 86000.1, volume: 5, timestamp: now });

  assert.equal(cache.isStale('BTCUSDT'), false);
  now += 1001;
  assert.equal(cache.isStale('BTCUSDT'), true, 'a tick older than the budget is stale');
  assert.equal(cache.isStale('ETHUSDT'), true, 'an unseen symbol is stale by definition');
});

test('MARKET DATA: the PAPER session applies NO staleness gate of its own (documented gap)', async () => {
  // Characterization of the current behaviour, not an endorsement. The session
  // executes on whatever snapshot it is handed, so a caller that never checks
  // `snapshot.timestamp` can trade on an arbitrarily old book. Every snapshot
  // carries the timestamp needed to gate it; nothing in the PAPER path does.
  const { session, cleanup } = await makeSession();
  try {
    const stale = createMarketSnapshot({
      symbol: 'BTCUSDT',
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      lastPrice: 86000,
      markPrice: 86000,
      bid: 85999.9,
      ask: 86000.1,
      volume: 1000,
      instrument: BTC_INSTRUMENT,
    });

    assert.ok(Date.parse(stale.timestamp) < Date.now() - 60 * 60 * 1000, 'precondition: the snapshot is two hours old');

    const outcome = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: stale });
    assert.equal(outcome.executed, true, 'the session trades on the stale snapshot — no gate exists to stop it');
  } finally {
    await cleanup();
  }
});

test('MARKET DATA: a snapshot without a bid/ask is refused rather than invented', async () => {
  // The one freshness-adjacent property the executor DOES enforce: it will not
  // manufacture a price from `lastPrice` when the book side is missing.
  const { session, cleanup } = await makeSession();
  try {
    const blind = marketAt(86000, { bid: null, ask: null });
    const outcome = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await blind.getSnapshot('BTCUSDT') });

    assert.equal(outcome.executed, false);
    assert.equal(outcome.reasonCode, REASON_CODE.MISSING_BID_ASK);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. The deterministic risk gate
// ---------------------------------------------------------------------------
test('RISK GATE: the same inputs always produce the same decision', async () => {
  const first = await makeSession();
  const second = await makeSession();
  try {
    const marketA = marketAt(86000);
    const marketB = marketAt(86000);
    const a = await first.session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await marketA.getSnapshot('BTCUSDT') });
    const b = await second.session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await marketB.getSnapshot('BTCUSDT') });

    assert.equal(a.reasonCode, b.reasonCode);
    assert.equal(a.riskResult.estimatedQuantity, b.riskResult.estimatedQuantity);
    assert.equal(a.riskResult.positionNotionalUsd, b.riskResult.positionNotionalUsd);
    assert.equal(a.executionResult.fill.fillPrice, b.executionResult.fill.fillPrice);
    assert.equal(a.executionResult.fill.feeUsd, b.executionResult.fill.feeUsd);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test('RISK GATE: the gate rejects a proposal whose geometry breaks the limits', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const rejected = await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 86720 }),
      market: await marketAt(86000).getSnapshot('BTCUSDT'),
    });

    assert.equal(rejected.approved, false);
    assert.equal(rejected.executed, false);
    assert.equal(rejected.reasonCode, REASON_CODE.INVALID_RISK_REWARD);
    assert.equal((await session.getAccountState()).positions.length, 0);
  } finally {
    await cleanup();
  }
});

test('KILL SWITCH: engaging the runtime stop blocks new entries and survives to the journal', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const engaged = await session.engageKillSwitch('operator stop for a test');
    assert.equal(engaged.engaged, true);
    assert.equal(session.killSwitchState().engaged, true);

    const blocked = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await marketAt(86000).getSnapshot('BTCUSDT') });
    assert.equal(blocked.approved, false);
    assert.equal(blocked.reasonCode, REASON_CODE.KILL_SWITCH_ENGAGED);
    assert.equal((await session.getAccountState()).positions.length, 0, 'nothing was opened');

    const { events } = await session.journal.read();
    const types = events.map((event) => event.eventType);
    assert.ok(types.includes(JOURNAL_EVENT.KILL_SWITCH_ENGAGED), 'the stop is recorded, not silent');
    const record = events.find((event) => event.eventType === JOURNAL_EVENT.KILL_SWITCH_ENGAGED);
    assert.equal(record.reason, 'operator stop for a test');
  } finally {
    await cleanup();
  }
});

test('KILL SWITCH: releasing the stop resumes entries and is journalled', async () => {
  const { session, cleanup } = await makeSession();
  try {
    await session.engageKillSwitch('temporary');
    await session.disengageKillSwitch();
    assert.equal(session.killSwitchState().engaged, false);

    const outcome = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await marketAt(86000).getSnapshot('BTCUSDT') });
    assert.equal(outcome.executed, true, `${outcome.reasonCode}: ${outcome.message ?? ''}`);

    const { events } = await session.journal.read();
    assert.ok(events.map((event) => event.eventType).includes(JOURNAL_EVENT.KILL_SWITCH_DISENGAGED));
  } finally {
    await cleanup();
  }
});

test('KILL SWITCH: an open position keeps its protection while entries are stopped', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    const opened = await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });
    assert.equal(opened.executed, true);

    await session.engageKillSwitch('stop new risk, keep protecting');

    market.setTicker({ markPrice: 85000, bid: 84999.9, ask: 85000.1, lastPrice: 85000 });
    const update = await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    assert.equal(update.closed.length, 1, 'the stop-loss still fired while the kill switch was engaged');
    assert.equal(update.closed[0].exitReason, 'STOP_LOSS');
    assert.equal((await session.getAccountState()).positions.length, 0);
  } finally {
    await cleanup();
  }
});

test('KILL SWITCH: the runtime stop is in-memory only — a restart clears it (documented gap)', async () => {
  // Characterization of the current behaviour: there is no operator recovery
  // risk in PAPER money terms, but a continuous PAPER loop that restarts after a
  // crash silently resumes trading. Recorded as a blocker for unattended runs.
  const { session, cleanup, restart } = await makeSession();
  try {
    await session.engageKillSwitch('engaged before restart');
    assert.equal(session.killSwitchState().engaged, true);

    const revived = await restart();
    assert.equal(revived.killSwitchState().engaged, false, 'the engagement did not survive the restart');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Simulated fills
// ---------------------------------------------------------------------------
test('FILLS: a LONG pays the ask on entry and receives the bid on exit', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    const opened = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    assert.equal(opened.executionResult.fill.fillPrice, 86000.1, 'a buyer lifts the ask');

    const closed = await session.closePosition({ symbol: 'BTCUSDT', market: await market.getSnapshot('BTCUSDT') });
    assert.equal(closed.fill.fillPrice, 85999.9, 'a seller hits the bid');
    assert.ok(closed.fill.slippageUsd >= 0, 'crossing the spread is never credited as a gain');
  } finally {
    await cleanup();
  }
});

test('FILLS: a SHORT receives the bid on entry and pays the ask on exit', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    const opened = await session.submit({
      proposal: proposal({ entryPrice: 86000, side: 'SHORT', stopLossPrice: 86720, takeProfitPrice: 84380 }),
      market: await market.getSnapshot('BTCUSDT'),
    });
    assert.equal(opened.executionResult.fill.fillPrice, 85999.9, 'a seller receives the bid');

    const closed = await session.closePosition({ symbol: 'BTCUSDT', market: await market.getSnapshot('BTCUSDT') });
    assert.equal(closed.fill.fillPrice, 86000.1, 'a buyer pays the ask');
  } finally {
    await cleanup();
  }
});

test('FILLS: an ambiguous gap resolves to the stop, never the target', async () => {
  // Already covered in depth by paper-execution.test.mjs; asserted here as part
  // of the canonical-session checklist so a single file carries the whole story.
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });
    await session.modifyPositionProtection({ symbol: 'BTCUSDT', takeProfit: 86500 });

    market.setTicker({ markPrice: 85000, bid: 84999.9, ask: 85000.1, lastPrice: 85000 });
    const update = await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    assert.equal(update.closed[0].exitReason, 'STOP_LOSS');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Recovery
// ---------------------------------------------------------------------------
test('RECOVERY: the canonical session restores its account from disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-canonical-'));
  const build = () =>
    createTradingSession({
      mode: 'PAPER',
      paper: {
        riskConfig: DEFAULT_RISK_LIMITS,
        feeModel: feeModel(),
        paths: {
          stateFile: join(directory, 'state.json'),
          journalFile: join(directory, 'journal.jsonl'),
          initialEquityUsd: 340,
        },
        logger: quietLogger,
      },
    });

  try {
    const session = await build();
    const market = marketAt(86000);
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });
    const before = await session.getAccountState();

    const revived = await build();
    assert.equal(revived.restored, true);
    const after = await revived.getAccountState();

    assert.ok(Math.abs(after.equityUsd - before.equityUsd) < 1e-9, `${after.equityUsd} vs ${before.equityUsd}`);
    assert.equal(after.positions.length, 1);
    assert.equal(after.positions[0].entryFeeUsd, before.positions[0].entryFeeUsd, 'the cost basis is restored too');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('RECOVERY: corrupt state fails closed instead of starting a new account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-canonical-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(directory, 'state.json'), '{ not json');

    await assert.rejects(
      () =>
        createTradingSession({
          mode: 'PAPER',
          paper: {
            riskConfig: DEFAULT_RISK_LIMITS,
            feeModel: feeModel(),
            paths: {
              stateFile: join(directory, 'state.json'),
              journalFile: join(directory, 'journal.jsonl'),
              initialEquityUsd: 340,
            },
            logger: quietLogger,
          },
        }),
      (error) => {
        assert.equal(error.name, 'CorruptStateError');
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
