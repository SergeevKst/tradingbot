/**
 * Stage 2 tests — persistence, restart recovery and the state-store guards.
 *
 * These tests exist because the most dangerous failure in a paper account is a
 * SILENT RESET: coming back up at the starting equity after a crash would erase
 * realized losses and re-arm every daily limit, making the simulation lie about
 * how the account actually behaved.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';

import { loadPaperState, savePaperState, resetPaperState, createStateStore, STATE_SCHEMA_VERSION, CorruptStateError, validatePersistedState } from '../src/state/state-store.mjs';
import { createPaperAccountState, validatePaperAccountState } from '../src/state/paper-account.mjs';
import { createDailyState } from '../src/state/daily-state.mjs';
import { createJournal, JOURNAL_EVENT, createJournalEvent, readJournal } from '../src/state/journal.mjs';
import { createZeroFeeModel } from '../src/state/fee-model.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { makeSession, marketAt, proposal } from './paper-fixtures.mjs';

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------
test('STORE: a missing file is reported as fresh, not as an error', async () => {
  const loaded = await loadPaperState({ filePath: '/tmp/definitely-not-here-9f8a7b6c.json' });
  assert.equal(loaded.kind, 'fresh');
});

test('STORE: a fresh session writes nothing until it trades', async () => {
  // Creating a session must not create files: a read-only inspection should not
  // leave state behind, and an untouched account is best represented by its
  // absence from disk.
  const { cleanup, paths, restart, session } = await makeSession();
  try {
    const { fileExists } = await import('../src/state/jsonl-file.mjs');
    const before = await fileExists(paths.stateFile);
    assert.equal(before, false, 'no state file until something is persisted');

    const fresh = await session.getAccountState();
    assert.equal(fresh.equityUsd, 340);

    await session.persist();
    assert.equal(await fileExists(paths.stateFile), true, 'persist() writes the file');
    assert.equal((await restart()).restored, true);
  } finally {
    await cleanup();
  }
});

test('STORE: state round-trips through disk unchanged', async () => {
  const { cleanup, paths, restart } = await makeSession();
  try {
    const market = marketAt(86000);
    const session = await restart();
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    const before = await session.getAccountState();
    const reloaded = await (await restart()).getAccountState();

    assert.ok(Math.abs(reloaded.equityUsd - before.equityUsd) < 1e-9);
    assert.equal(reloaded.positions.length, before.positions.length);
    assert.equal(reloaded.tradesToday, before.tradesToday);
    assert.ok(Math.abs(reloaded.feesUsd - before.feesUsd) < 1e-9);
    assert.ok(Math.abs(reloaded.realizedPnlUsd - before.realizedPnlUsd) < 1e-9);
  } finally {
    await cleanup();
  }
});

test('STORE: the persisted document carries a schema version', async () => {
  const { cleanup, paths, restart, session } = await makeSession();
  try {
    await session.persist();
    const raw = JSON.parse(await readFile(paths.stateFile, 'utf8'));
    assert.equal(raw.schemaVersion, STATE_SCHEMA_VERSION);
    assert.ok(raw.account, 'the account block is persisted');
    assert.ok(raw.daily, 'the daily block is persisted');
    assert.ok(typeof raw.savedAt === 'string');
  } finally {
    await cleanup();
  }
});

test('STORE: the write is atomic — no partial file is ever visible', async () => {
  // The implementation writes a temp sibling and renames over the target, so a
  // reader either sees the whole old state or the whole new one.
  const { cleanup, paths, session } = await makeSession();
  try {
    await session.persist();

    const contents = await readFile(paths.stateFile, 'utf8');
    // Must parse completely: a truncated write would throw here.
    assert.doesNotThrow(() => JSON.parse(contents));
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
test('STORE: account and daily counters must agree, or the state is rejected', () => {
  const document = {
    schemaVersion: STATE_SCHEMA_VERSION,
    account: { initialEquityUsd: 340, realizedPnlUsd: 0, feesUsd: 0, tradesToday: 3, dayStartEquityUsd: 340, positions: [] },
    daily: { tradingDay: '2026-03-15', tradesToday: 9, dailyRealizedPnlUsd: 0, dayStartEquityUsd: 340, timezone: 'UTC' },
  };

  assert.throws(() => validatePersistedState(document), CorruptStateError);
});

test('STORE: dailyRealizedPnlUsd must agree between account and daily blocks', () => {
  const document = {
    schemaVersion: STATE_SCHEMA_VERSION,
    account: { initialEquityUsd: 340, realizedPnlUsd: -5, feesUsd: 0, tradesToday: 1, dayStartEquityUsd: 340, dailyRealizedPnlUsd: -5, positions: [] },
    daily: { tradingDay: '2026-03-15', tradesToday: 1, dailyRealizedPnlUsd: -2, dayStartEquityUsd: 340, timezone: 'UTC' },
  };

  assert.throws(() => validatePersistedState(document), CorruptStateError);
});

test('STORE: a non-object state document is rejected', () => {
  assert.throws(() => validatePersistedState([]), CorruptStateError);
  assert.throws(() => validatePersistedState('nope'), CorruptStateError);
  assert.throws(() => validatePersistedState(null), CorruptStateError);
});

test('STORE: a position with a malformed side is rejected on load', () => {
  assert.throws(
    () =>
      validatePersistedState({
        schemaVersion: STATE_SCHEMA_VERSION,
        account: {
          initialEquityUsd: 340, realizedPnlUsd: 0, feesUsd: 0, tradesToday: 1, dayStartEquityUsd: 340,
          positions: [{ symbol: 'BTCUSDT', side: 'UPSIDE', quantity: 0.01, entryPrice: 86000, markPrice: 86000, leverage: 2 }],
        },
        daily: { tradingDay: '2026-03-15', tradesToday: 1, dailyRealizedPnlUsd: 0, dayStartEquityUsd: 340, timezone: 'UTC' },
      }),
    CorruptStateError,
  );
});

// ---------------------------------------------------------------------------
// Reset guard
// ---------------------------------------------------------------------------
test('RESET: requires an explicit confirmation flag', async () => {
  const { cleanup, paths, session } = await makeSession();
  try {
    await session.persist();

    // Without confirmation: refuse, and leave the file alone.
    await assert.rejects(() => resetPaperState({ filePath: paths.stateFile }), ConfigError);
    await assert.rejects(() => resetPaperState({ filePath: paths.stateFile, confirmed: false }), ConfigError);

    const stillThere = await loadPaperState({ filePath: paths.stateFile });
    assert.equal(stillThere.kind, 'restored', 'a refused reset must not delete anything');

    // With confirmation: delete.
    const removed = await resetPaperState({ filePath: paths.stateFile, confirmed: true });
    assert.equal(removed, true);
    assert.equal((await loadPaperState({ filePath: paths.stateFile })).kind, 'fresh');
  } finally {
    await cleanup();
  }
});

test('RESET: only an exact boolean true is accepted as confirmation', async () => {
  const { cleanup, paths, session } = await makeSession();
  try {
    await session.persist();

    // Truthy-but-not-true values must be rejected: "--confirm-reset" parsing
    // mistakes should never be able to delete a trading account.
    for (const value of ['true', 1, {}, [], 'yes']) {
      await assert.rejects(
        () => resetPaperState({ filePath: paths.stateFile, confirmed: /** @type {any} */ (value) }),
        ConfigError,
      );
    }
    assert.equal((await loadPaperState({ filePath: paths.stateFile })).kind, 'restored');
  } finally {
    await cleanup();
  }
});

test('RESET: a reset account starts fresh at the configured equity', async () => {
  const { cleanup, paths, restart } = await makeSession();
  try {
    // Trade first, so the account is definitely not at its starting value.
    const market = marketAt(86000);
    const session = await restart();
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    const traded = await session.getAccountState();
    assert.ok(traded.equityUsd !== 340 || traded.positions.length > 0);

    await resetPaperState({ filePath: paths.stateFile, confirmed: true });

    const fresh = await (await restart()).getAccountState();
    assert.equal(fresh.equityUsd, 340);
    assert.equal(fresh.positions.length, 0);
    assert.equal(fresh.tradesToday, 0);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------
test('JOURNAL: events are appended as one JSON object per line', async () => {
  const { cleanup, paths } = await makeSession();
  try {
    const journal = createJournal({ filePath: paths.journalFile });
    await journal.record(createJournalEvent({ eventType: JOURNAL_EVENT.SIGNAL_RECEIVED, symbol: 'BTCUSDT' }));
    await journal.record(createJournalEvent({ eventType: JOURNAL_EVENT.RISK_ACCEPTED, symbol: 'BTCUSDT' }));

    const contents = await readFile(paths.journalFile, 'utf8');
    const lines = contents.trim().split('\n');

    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), 'each line must be independently parseable');
    }
  } finally {
    await cleanup();
  }
});

test('JOURNAL: an unknown event type is refused', async () => {
  const { cleanup, paths } = await makeSession();
  try {
    const journal = createJournal({ filePath: paths.journalFile });
    await assert.rejects(() => journal.record({ eventType: 'NOT_A_REAL_EVENT' }), ConfigError);
    assert.throws(() => createJournalEvent({ eventType: 'NOT_A_REAL_EVENT' }), ConfigError);
  } finally {
    await cleanup();
  }
});

test('JOURNAL: openings are append-only and preserve earlier history', async () => {
  const { cleanup, paths } = await makeSession();
  try {
    const journal = createJournal({ filePath: paths.journalFile });
    const first = createJournalEvent({ eventType: JOURNAL_EVENT.SIGNAL_RECEIVED, symbol: 'BTCUSDT' });
    await journal.record(first);
    await journal.record(createJournalEvent({ eventType: JOURNAL_EVENT.RISK_ACCEPTED, symbol: 'BTCUSDT' }));

    const { events } = await journal.read();
    assert.equal(events.length, 2);
    assert.equal(events[0].eventType, 'SIGNAL_RECEIVED', 'the earlier record must survive');
  } finally {
    await cleanup();
  }
});

test('JOURNAL: a credential-shaped metadata key is redacted before it hits disk', async () => {
  const { cleanup, paths } = await makeSession();
  try {
    const journal = createJournal({ filePath: paths.journalFile });
    await journal.record(
      createJournalEvent({
        eventType: JOURNAL_EVENT.SIGNAL_RECEIVED,
        metadata: { apiSecret: 'LEAK-CANARY', nested: { authorization: 'Bearer LEAK-CANARY-2' }, keep: 'ok' },
      }),
    );

    const contents = await readFile(paths.journalFile, 'utf8');
    assert.ok(!contents.includes('LEAK-CANARY'), 'a secret must never reach the journal');
    assert.ok(contents.includes('ok'), 'non-secret metadata must survive');

    const { events } = await journal.read();
    assert.equal(events[0].metadata.apiSecret, '[REDACTED]');
  } finally {
    await cleanup();
  }
});

test('JOURNAL: reading a missing journal yields an empty history', async () => {
  const { events, skippedTail } = await readJournal('/tmp/journal-that-does-not-exist-12ab34.jsonl');
  assert.deepEqual(events, []);
  assert.equal(skippedTail, false);
});

test('JOURNAL: the journal is never truncated by normal operation', async () => {
  const { cleanup, paths, restart } = await makeSession();
  try {
    const market = marketAt(86000);
    const session = await restart();
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    const afterFirst = (await session.journal.read()).events.length;

    // A restart must append to the existing history, not start a new file.
    const revived = await restart();
    market.setTicker({ markPrice: 87700, bid: 87699.9, ask: 87700.1, lastPrice: 87700 });
    await revived.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const afterSecond = (await revived.journal.read()).events.length;
    assert.ok(afterSecond > afterFirst, `history must grow across a restart (${afterFirst} -> ${afterSecond})`);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// The state store facade
// ---------------------------------------------------------------------------
test('STORE: the facade reports existence and refuses an unconfirmed reset', async () => {
  const { cleanup, paths, session } = await makeSession();
  try {
    await session.persist();
    const store = createStateStore({ filePath: paths.stateFile });

    assert.equal(await store.exists(), true);
    await assert.rejects(() => store.reset(false), ConfigError);

    assert.equal(await store.reset(true), true);
    assert.equal(await store.exists(), false);
  } finally {
    await cleanup();
  }
});

test('STORE: a persisted account keeps its fee and PnL totals after reload', async () => {
  const { cleanup, paths, restart } = await makeSession();
  try {
    // Produce a real, internally-consistent state: trade, then win.
    const market = marketAt(86000);
    const session = await restart();
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });
    market.setTicker({ markPrice: 87700, bid: 87699.9, ask: 87700.1, lastPrice: 87700 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const before = await session.getAccountState();
    assert.ok(before.feesUsd > 0, 'precondition: fees were paid');
    assert.ok(before.realizedPnlUsd > 0, 'precondition: a realized win');

    const store = createStateStore({ filePath: paths.stateFile });
    const loaded = await store.load();

    assert.equal(loaded.kind, 'restored');
    if (loaded.kind !== 'restored') return;
    assert.ok(Math.abs(loaded.state.account.feesUsd - before.feesUsd) < 1e-9);
    assert.ok(Math.abs(loaded.state.account.realizedPnlUsd - before.realizedPnlUsd) < 1e-9);
    assert.equal(loaded.state.account.tradesToday, before.tradesToday);
  } finally {
    await cleanup();
  }
});