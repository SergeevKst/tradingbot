/**
 * P2-A regression tests — entry-fee accounting and net-PnL reconciliation.
 *
 * The defect these tests pin down: `validatePaperPosition` reconstructed a
 * closed field set that did not include `entryFeeUsd`. A position that was
 * re-validated (on every mark-to-market) or reloaded from disk therefore lost
 * the entry fee, and the round-trip result reported at close (`netPnlUsd`)
 * silently excluded it — so the sum of round-trip PnL did not reconcile with the
 * change in account equity. The research smoke run observed equity net PnL of
 * $3.65 against $4.17 of round-trip PnL; the difference is exactly the entry
 * fees that had been dropped.
 *
 * The invariant every test here enforces:
 *
 *   equity_now - initial_equity
 *     === realized_gross + unrealized - fees_paid        (account identity)
 *     === Σ(round-trip net PnL) + unrealized             (reconciliation)
 *
 * with a tolerance of $0.000001. Nothing here is a profitability claim.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { makeSession, marketAt, proposal } from './paper-fixtures.mjs';
import { validatePaperPosition, markPosition } from '../src/state/paper-position.mjs';
import { validatePaperAccountState } from '../src/state/paper-account.mjs';
import { ConfigError } from '../src/config/config-error.mjs';

/** $0.000001 — the reconciliation tolerance required by the task. */
const TOL = 1e-6;

/**
 * Assert that the account reconciles with the sum of the round-trip results.
 *
 * @param {Readonly<object>} account
 * @param {number[]} roundTripNetPnL
 * @param {string} label
 */
function assertReconciles(account, roundTripNetPnL, label) {
  const equityChange = account.equityUsd - account.initialEquityUsd;
  const summed = roundTripNetPnL.reduce((sum, value) => sum + value, 0) + account.unrealizedPnlUsd;
  assert.ok(
    Math.abs(equityChange - summed) <= TOL,
    `${label}: equity change ${equityChange} does not reconcile with summed net PnL ${summed} (delta ${equityChange - summed})`,
  );

  // The ledger identity that makes the reconciliation possible at all.
  const identity = account.realizedPnlUsd + account.unrealizedPnlUsd - account.feesUsd;
  assert.ok(
    Math.abs(equityChange - identity) <= TOL,
    `${label}: equity change ${equityChange} does not match realized+unrealized-fees ${identity}`,
  );
}

// ---------------------------------------------------------------------------
// The pure validator
// ---------------------------------------------------------------------------
test('P2-A: validatePaperPosition preserves a finite entryFeeUsd', () => {
  const position = validatePaperPosition({
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantity: 0.01,
    entryPrice: 86000,
    markPrice: 86000,
    leverage: 2,
    entryFeeUsd: 0.86,
  });

  assert.equal(position.entryFeeUsd, 0.86, 'the entry fee must survive validation');
});

test('P2-A: a missing entryFeeUsd defaults to 0 for pre-fix persisted state', () => {
  // State written by an older build has no such field. Refusing to restore it
  // would strand every existing paper account; treating it as 0 is the only
  // value that keeps the stored ledger internally consistent.
  const position = validatePaperPosition({
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantity: 0.01,
    entryPrice: 86000,
    markPrice: 86000,
    leverage: 2,
  });

  assert.equal(position.entryFeeUsd, 0);
});

test('P2-A: a negative or non-finite entryFeeUsd is refused, not silently zeroed', () => {
  const valid = {
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantity: 0.01,
    entryPrice: 86000,
    markPrice: 86000,
    leverage: 2,
  };

  assert.throws(() => validatePaperPosition({ ...valid, entryFeeUsd: -0.5 }), ConfigError);
  assert.throws(() => validatePaperPosition({ ...valid, entryFeeUsd: Number.NaN }), ConfigError);
  assert.throws(() => validatePaperPosition({ ...valid, entryFeeUsd: Number.POSITIVE_INFINITY }), ConfigError);
  assert.throws(() => validatePaperPosition({ ...valid, entryFeeUsd: 'not-a-number' }), ConfigError);
});

test('P2-A: markPosition keeps the entry fee through a re-price', () => {
  const position = validatePaperPosition({
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantity: 0.01,
    entryPrice: 86000,
    markPrice: 86000,
    leverage: 2,
    entryFeeUsd: 0.86,
  });

  const marked = markPosition(position, 86500, '2026-03-15T12:00:00.000Z');

  assert.equal(marked.entryFeeUsd, 0.86);
  assert.equal(marked.unrealizedPnlUsd, 5, 'the mark still recomputes unrealized PnL');
});

test('P2-A: account validation keeps the entry fee across a reload', () => {
  // This is the restart path: a persisted document is handed to
  // validatePaperAccountState, which validates every position through
  // validatePaperPosition.
  const account = validatePaperAccountState({
    initialEquityUsd: 340,
    realizedPnlUsd: 0,
    feesUsd: 0.86,
    tradesToday: 1,
    dayStartEquityUsd: 340,
    positions: [
      {
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantity: 0.01,
        entryPrice: 86000,
        markPrice: 86000,
        leverage: 2,
        entryFeeUsd: 0.86,
      },
    ],
  });

  assert.equal(account.positions[0].entryFeeUsd, 0.86);
});

// ---------------------------------------------------------------------------
// Reconciliation through the session
// ---------------------------------------------------------------------------
test('P2-A: round-trip net PnL reconciles with equity change after a mark', async () => {
  // The exact shape of the defect: a mark-to-market happens between the entry
  // and the exit, so the position object is re-validated and (pre-fix) loses its
  // entry fee.
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    const submitted = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    assert.equal(submitted.executed, true, `${submitted.reasonCode}: ${submitted.message ?? ''}`);

    const entryFee = submitted.executionResult.fill.feeUsd;
    assert.ok(entryFee > 0, 'precondition: an entry fee was charged');

    // A mark that triggers neither the stop (85280) nor the target (87620).
    market.setTicker({ markPrice: 86500, bid: 86499.9, ask: 86500.1, lastPrice: 86500 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const marked = await session.getAccountState();
    assert.equal(marked.positions[0].entryFeeUsd, entryFee, 'the entry fee survived the mark');

    const closed = await session.closePosition({ symbol: 'BTCUSDT', market: await market.getSnapshot('BTCUSDT') });
    assert.equal(closed.ok, true);

    const fill = closed.fill;
    assert.ok(Math.abs(fill.entryFeeUsd - entryFee) <= TOL, `fill entry fee ${fill.entryFeeUsd} vs ${entryFee}`);
    assert.ok(
      Math.abs(fill.netPnlUsd - (fill.grossPnlUsd - fill.entryFeeUsd - fill.exitFeeUsd)) <= TOL,
      'net PnL must be gross minus BOTH fees',
    );

    assertReconciles(await session.getAccountState(), [fill.netPnlUsd], 'single round trip after a mark');
  } finally {
    await cleanup();
  }
});

test('P2-A: round-trip net PnL reconciles across several trades', async () => {
  const { session, cleanup } = await makeSession({
    riskConfig: {
      ...(await import('../src/config/risk.mjs')).DEFAULT_RISK_LIMITS,
      maxTradesPerDay: 10,
    },
  });
  const roundTrips = [];
  try {
    const market = marketAt(86000);

    for (const exitMark of [86500, 87000, 85500]) {
      // Re-create the position state the loop expects: flat before each entry.
      const before = await session.getAccountState();
      assert.equal(before.positions.length, 0, 'precondition: flat before the entry');

      const submitted = await session.submit({
        proposal: proposal({ entryPrice: 86000 }),
        market: await market.getSnapshot('BTCUSDT'),
      });
      assert.equal(submitted.executed, true, `${submitted.reasonCode}: ${submitted.message ?? ''}`);

      // Mark between entry and exit so the position is re-validated in flight.
      // The observation stays inside the untriggered band (stop 85280,
      // target 87620) so the position is still open when it is closed.
      market.setTicker({ markPrice: exitMark + 50, bid: exitMark + 49.9, ask: exitMark + 50.1, lastPrice: exitMark + 50 });
      await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

      market.setTicker({ markPrice: exitMark, bid: exitMark - 0.1, ask: exitMark + 0.1, lastPrice: exitMark });
      const closed = await session.closePosition({ symbol: 'BTCUSDT', market: await market.getSnapshot('BTCUSDT') });
      assert.equal(closed.ok, true);
      roundTrips.push(closed.fill.netPnlUsd);

      // Re-anchor the market for the next iteration.
      market.setTicker({ markPrice: exitMark, bid: exitMark - 0.1, ask: exitMark + 0.1, lastPrice: exitMark });
    }

    const account = await session.getAccountState();
    assert.equal(account.positions.length, 0);
    assert.equal(roundTrips.length, 3);
    assertReconciles(account, roundTrips, 'three round trips');
    assert.ok(account.feesUsd > 0, 'every round trip paid both fees');
    assert.equal(account.tradesToday, 3, 'three entries consumed three daily slots');
  } finally {
    await cleanup();
  }
});

test('P2-A: the entry fee and the reconciliation survive persistence and reload', async () => {
  const { session, cleanup, restart } = await makeSession();
  try {
    const market = marketAt(86000);
    const submitted = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    assert.equal(submitted.executed, true);
    const entryFee = submitted.executionResult.fill.feeUsd;

    // Force a persist, then reload from disk.
    const revived = await restart();
    assert.equal(revived.restored, true, 'precondition: state was restored');

    const reloaded = await revived.getAccountState();
    assert.equal(reloaded.positions[0].entryFeeUsd, entryFee, 'the entry fee survived the reload');

    market.setTicker({ markPrice: 86500, bid: 86499.9, ask: 86500.1, lastPrice: 86500 });
    await revived.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const closed = await revived.closePosition({ symbol: 'BTCUSDT', market: await market.getSnapshot('BTCUSDT') });
    assert.equal(closed.ok, true);
    assert.equal(closed.fill.entryFeeUsd, entryFee);
    assertReconciles(await revived.getAccountState(), [closed.fill.netPnlUsd], 'reload then close');
  } finally {
    await cleanup();
  }
});

test('P2-A: the entry fee and the reconciliation survive a UTC day rollover', async () => {
  // The position is opened at 23:50 UTC and closed after midnight, so
  // syncDailyState resets the day counters between the entry and the exit. The
  // daily reset must not touch the position's cost basis.
  let clock = '2026-03-15T23:50:00.000Z';
  const { session, cleanup } = await makeSession({ now: () => clock });
  try {
    const market = marketAt(86000);
    const submitted = await session.submit({
      proposal: proposal({ entryPrice: 86000, timestamp: Date.parse(clock) }),
      market: await market.getSnapshot('BTCUSDT'),
    });
    assert.equal(submitted.executed, true, `${submitted.reasonCode}: ${submitted.message ?? ''}`);
    const entryFee = submitted.executionResult.fill.feeUsd;
    assert.equal((await session.getAccountState()).tradesToday, 1);

    // Cross the UTC boundary, then mark and close.
    clock = '2026-03-16T00:10:00.000Z';
    market.setTicker({ markPrice: 86500, bid: 86499.9, ask: 86500.1, lastPrice: 86500 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const rolled = await session.getAccountState();
    assert.equal(rolled.tradesToday, 0, 'the daily trade counter reset on the new UTC day');
    assert.equal(rolled.positions[0].entryFeeUsd, entryFee, 'the rollover did not drop the entry fee');

    const closed = await session.closePosition({ symbol: 'BTCUSDT', market: await market.getSnapshot('BTCUSDT') });
    assert.equal(closed.ok, true);
    assert.equal(closed.fill.entryFeeUsd, entryFee);
    assertReconciles(await session.getAccountState(), [closed.fill.netPnlUsd], 'rollover then close');
  } finally {
    await cleanup();
  }
});

test('P2-A: an entry fee is never charged twice and never omitted', async () => {
  // The double-charge failure mode matters just as much as the omission: a
  // position that carried its entry fee forward must not have it re-added to
  // account fees on every mark.
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    const submitted = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    const entryFee = submitted.executionResult.fill.feeUsd;

    for (const mark of [86100, 86200, 86300]) {
      market.setTicker({ markPrice: mark, bid: mark - 0.1, ask: mark + 0.1, lastPrice: mark });
      await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));
      const account = await session.getAccountState();
      assert.ok(
        Math.abs(account.feesUsd - entryFee) <= TOL,
        `fees after marking at ${mark} were ${account.feesUsd}, expected only the entry fee ${entryFee}`,
      );
    }
  } finally {
    await cleanup();
  }
});
