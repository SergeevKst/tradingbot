/**
 * Stage 2 tests — paper execution: entries, exits, stops, targets, fees,
 * protection rules, journal and restart recovery.
 *
 * All market data is static and offline. Passing these tests demonstrates that
 * the plumbing is coherent and conservative; it demonstrates NOTHING about
 * whether any trading strategy would be profitable.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';

import { makeSession, marketAt, proposal, shortProposal, feeModel, createZeroFeeModel } from './paper-fixtures.mjs';
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';

// ---------------------------------------------------------------------------
// LONG lifecycle
// ---------------------------------------------------------------------------
test('LONG: entry fills at the ask and locks margin', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    const outcome = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    assert.equal(outcome.approved, true, outcome.reasonCode);
    assert.equal(outcome.executed, true, outcome.reasonCode);

    const account = await session.getAccountState();
    const position = account.positions[0];

    assert.equal(position.side, 'LONG');
    // A buyer pays the ask, never the mid or the last price.
    assert.equal(position.entryPrice, 86000.1);
    assert.equal(position.leverage, 2, 'the configured cap is the leverage applied');
    assert.ok(position.initialMarginUsd > 0);
    assert.ok(account.equityUsd < 340, 'the entry fee reduces equity immediately');
    assert.ok(account.availableBalanceUsd < account.equityUsd, 'margin is locked');
  } finally {
    await cleanup();
  }
});

test('LONG: unrealized profit and loss are reported deterministically', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    const quantity = (await session.getAccountState()).positions[0].quantity;

    // A LONG's stop is 85280, so both observations must stay ABOVE it or the
    // position closes and there is no unrealized PnL left to inspect.
    market.setTicker({ markPrice: 86400, bid: 86399.9, ask: 86400.1, lastPrice: 86400 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));
    let account = await session.getAccountState();
    assert.ok(
      Math.abs(account.unrealizedPnlUsd - (86400 - 86000.1) * quantity) < 1e-9,
      `profit mismatch: ${account.unrealizedPnlUsd}`,
    );
    assert.ok(account.unrealizedPnlUsd > 0);

    market.setTicker({ markPrice: 85600, bid: 85599.9, ask: 85600.1, lastPrice: 85600 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));
    account = await session.getAccountState();
    assert.ok(
      Math.abs(account.unrealizedPnlUsd - (85600 - 86000.1) * quantity) < 1e-9,
      `loss mismatch: ${account.unrealizedPnlUsd}`,
    );
    assert.ok(account.unrealizedPnlUsd < 0);
  } finally {
    await cleanup();
  }
});

test('LONG: stop loss closes the position and realizes a loss', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    market.setTicker({ markPrice: 85200, bid: 85199.9, ask: 85200.1, lastPrice: 85200 });
    const update = await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    assert.equal(update.closed.length, 1);
    assert.equal(update.closed[0].exitReason, 'STOP_LOSS');

    const account = await session.getAccountState();
    assert.equal(account.positions.length, 0, 'the position is flat after the stop');
    assert.ok(account.realizedPnlUsd < 0, 'a stop-out realizes a loss');
    assert.ok(account.equityUsd < 340);
  } finally {
    await cleanup();
  }
});

test('LONG: take profit closes the position and realizes a gain', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    market.setTicker({ markPrice: 87700, bid: 87699.9, ask: 87700.1, lastPrice: 87700 });
    const update = await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    assert.equal(update.closed[0].exitReason, 'TAKE_PROFIT');

    const account = await session.getAccountState();
    assert.equal(account.positions.length, 0);
    assert.ok(account.realizedPnlUsd > 0);
    assert.ok(account.equityUsd > 340);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// SHORT lifecycle
// ---------------------------------------------------------------------------
test('SHORT: entry fills at the bid', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    const outcome = await session.submit({
      proposal: shortProposal({ entryPrice: 86000 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    assert.equal(outcome.executed, true, `${outcome.reasonCode}: ${outcome.message}`);

    const position = (await session.getAccountState()).positions[0];
    assert.equal(position.side, 'SHORT');
    // A seller receives the bid.
    assert.equal(position.entryPrice, 85999.9);
  } finally {
    await cleanup();
  }
});

test('SHORT: unrealized profit and loss are reported deterministically', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: shortProposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    const entry = (await session.getAccountState()).positions[0].entryPrice;
    const quantity = (await session.getAccountState()).positions[0].quantity;

    // A SHORT's stop is 86720, so both observations must stay BELOW it or the
    // position closes and no unrealized PnL remains.
    market.setTicker({ markPrice: 85600, bid: 85599.9, ask: 85600.1, lastPrice: 85600 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));
    let account = await session.getAccountState();
    assert.ok(
      Math.abs(account.unrealizedPnlUsd - (entry - 85600) * quantity) < 1e-9,
      `short profit mismatch: ${account.unrealizedPnlUsd}`,
    );
    assert.ok(account.unrealizedPnlUsd > 0);

    // ...and loses when the price rises.
    market.setTicker({ markPrice: 86400, bid: 86399.9, ask: 86400.1, lastPrice: 86400 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));
    account = await session.getAccountState();
    assert.ok(account.unrealizedPnlUsd < 0, 'a rising market hurts a SHORT');
  } finally {
    await cleanup();
  }
});

test('SHORT: stop loss closes the position and realizes a loss', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({
      proposal: shortProposal({ entryPrice: 86000, stopLossPrice: 86720, takeProfitPrice: 84380 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    // A SHORT's stop is ABOVE entry.
    market.setTicker({ markPrice: 86800, bid: 86799.9, ask: 86800.1, lastPrice: 86800 });
    const update = await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    assert.equal(update.closed[0].exitReason, 'STOP_LOSS');
    const account = await session.getAccountState();
    assert.ok(account.realizedPnlUsd < 0);
  } finally {
    await cleanup();
  }
});

test('SHORT: take profit closes the position and realizes a gain', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({
      proposal: shortProposal({ entryPrice: 86000, stopLossPrice: 86720, takeProfitPrice: 84380 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    // A SHORT's target is BELOW entry.
    market.setTicker({ markPrice: 84300, bid: 84299.9, ask: 84300.1, lastPrice: 84300 });
    const update = await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    assert.equal(update.closed[0].exitReason, 'TAKE_PROFIT');
    const account = await session.getAccountState();
    assert.ok(account.realizedPnlUsd > 0);
    assert.ok(account.equityUsd > 340);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// The ambiguous stop/target case
// ---------------------------------------------------------------------------
test('TRIGGERS: a gap spanning BOTH levels resolves to the STOP, never the target', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    // Observe a high price first (neither level hit)...
    market.setTicker({ markPrice: 87000, bid: 86999.9, ask: 87000.1, lastPrice: 87000 });
    let update = await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));
    assert.equal(update.closed.length, 0, 'no trigger at 87000');

    // ...then pull both protective levels inside the range a later move spans.
    const modified = await session.modifyPositionProtection({ symbol: 'BTCUSDT', takeProfit: 86500 });
    assert.equal(modified.ok, true, modified.reasonCode ?? '');

    // One observation at 85000: the interval [85000, 87000] covers the stop
    // (85280) AND the target (86500), so the true order is unknowable.
    market.setTicker({ markPrice: 85000, bid: 84999.9, ask: 85000.1, lastPrice: 85000 });
    update = await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    assert.equal(update.closed.length, 1);
    assert.equal(
      update.closed[0].exitReason,
      'STOP_LOSS',
      'an ambiguous path must never be credited as a win',
    );

    // The conservatism must be visible in the journal, not silent.
    const { events } = await session.journal.read();
    const stopEvent = events.find((event) => event.eventType === 'STOP_LOSS_FILLED');
    assert.equal(stopEvent?.metadata?.ambiguousTriggerResolvedTo, 'STOP_LOSS');
    assert.ok(stopEvent?.metadata?.note, 'the resolution must carry an explanatory note');
  } finally {
    await cleanup();
  }
});

test('TRIGGERS: a gap spanning only the target resolves to the target', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    market.setTicker({ markPrice: 88000, bid: 87999.9, ask: 88000.1, lastPrice: 88000 });
    const update = await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    assert.equal(update.closed[0].exitReason, 'TAKE_PROFIT');
  } finally {
    await cleanup();
  }
});

test('TRIGGERS: a move that happened before entry cannot trigger a stop', async () => {
  const { session, cleanup } = await makeSession();
  try {
    // Price observed low BEFORE the position exists.
    const market = marketAt(84000);
    await market.getSnapshot('BTCUSDT');

    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    // The gap detector must be anchored to the entry observation, so the stop
    // is not considered "crossed" by pre-entry history.
    const account = await session.getAccountState();
    assert.equal(account.positions.length, 1, 'the position must still be open');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------
test('FEES: a round trip pays both an entry and an exit fee', async () => {
  const { session, cleanup } = await makeSession({ fees: feeModel(0.001, 0.001) });
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    const accountAfterEntry = await session.getAccountState();
    const entryFee = accountAfterEntry.feesUsd;
    assert.ok(entryFee > 0, 'an entry fee must be charged');

    market.setTicker({ markPrice: 87000, bid: 86999.9, ask: 87000.1, lastPrice: 87000 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT')); // no trigger
    await session.closePosition({ symbol: 'BTCUSDT', market: await market.getSnapshot('BTCUSDT') });

    const account = await session.getAccountState();
    assert.ok(account.feesUsd > entryFee, 'the exit fee is charged in addition to the entry fee');

    // Equity must reflect BOTH fees, not just the gross price move. The exit
    // filled at the BID (a LONG sells into the bid), which is slightly worse
    // than the mark — that pessimism is part of the model.
    const grossMove = (86999.9 - accountAfterEntry.positions[0].entryPrice) * accountAfterEntry.positions[0].quantity;
    assert.ok(
      Math.abs(account.equityUsd - (340 + grossMove - account.feesUsd)) < 1e-9,
      'equity must equal initial + gross move - total fees',
    );
  } finally {
    await cleanup();
  }
});

test('FEES: a winning trade nets less than the gross move', async () => {
  const { session, cleanup } = await makeSession({ fees: feeModel(0.001, 0.001) });
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    const position = (await session.getAccountState()).positions[0];

    market.setTicker({ markPrice: 87650, bid: 87649.9, ask: 87650.1, lastPrice: 87650 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const account = await session.getAccountState();
    const grossMove = (87650 - position.entryPrice) * position.quantity;

    assert.ok(account.realizedPnlUsd > 0, 'the trade is still a net win');
    assert.ok(
      account.realizedPnlUsd < grossMove,
      `realized ${account.realizedPnlUsd} must be below the gross move ${grossMove} once fees are applied`,
    );
  } finally {
    await cleanup();
  }
});

test('FEES: a zero-fee model leaves the gross move as the realized result', async () => {
  const { session, cleanup } = await makeSession({ fees: createZeroFeeModel() });
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    const position = (await session.getAccountState()).positions[0];

    market.setTicker({ markPrice: 87650, bid: 87649.9, ask: 87650.1, lastPrice: 87650 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const account = await session.getAccountState();
    assert.equal(account.feesUsd, 0);

    // With no fees the realized result is exactly the price move, measured from
    // the entry to the exit fill — and a LONG exits into the bid.
    const { events } = await session.journal.read();
    const closeEvent = events.find((event) => event.eventType === 'TAKE_PROFIT_FILLED');
    assert.ok(
      Math.abs(account.realizedPnlUsd - (closeEvent.price - position.entryPrice) * position.quantity) < 1e-9,
      `realized ${account.realizedPnlUsd} should equal the move to the exit fill`,
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Execution refusals
// ---------------------------------------------------------------------------
test('EXECUTION: no fill without a bid or ask — no invented price', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const blind = marketAt(86000, { bid: null, ask: null });
    const outcome = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await blind.getSnapshot('BTCUSDT') });

    assert.equal(outcome.executed, false);
    assert.equal(outcome.reasonCode, 'MISSING_BID_ASK');
    assert.equal((await session.getAccountState()).positions.length, 0);
  } finally {
    await cleanup();
  }
});

test('EXECUTION: a LONG is refused when only the bid is missing', async () => {
  const { session, cleanup } = await makeSession();
  try {
    // A LONG buys the ask; without an ask there is no honest entry price.
    const halfBook = marketAt(86000, { bid: 85999.9, ask: null });
    const outcome = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await halfBook.getSnapshot('BTCUSDT') });

    assert.equal(outcome.executed, false);
    assert.equal(outcome.reasonCode, 'MISSING_BID_ASK');
  } finally {
    await cleanup();
  }
});

test('EXECUTION: a SHORT is refused when only the ask is missing', async () => {
  const { session, cleanup } = await makeSession();
  try {
    // A SHORT sells the bid; without a bid there is no honest entry price.
    const halfBook = marketAt(86000, { bid: null, ask: 86000.1 });
    const outcome = await session.submit({ proposal: shortProposal({ entryPrice: 86000 }), market: await halfBook.getSnapshot('BTCUSDT') });

    assert.equal(outcome.executed, false);
    assert.equal(outcome.reasonCode, 'MISSING_BID_ASK');
  } finally {
    await cleanup();
  }
});

test('EXECUTION: the executor refuses an order the Risk Engine did not approve', async () => {
  const { session, cleanup } = await makeSession();
  try {
    // A stop distance of zero is rejected by risk, so nothing may be opened.
    const outcome = await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 86000 }),
      market: await marketAt(86000).getSnapshot('BTCUSDT'),
    });

    assert.equal(outcome.approved, false);
    assert.equal(outcome.executed, false);
    assert.equal((await session.getAccountState()).positions.length, 0);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Duplicate / conflicting protection
// ---------------------------------------------------------------------------
test('PROTECTION: a second position on the same symbol is refused', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    const duplicate = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    assert.equal(duplicate.approved, false);
    assert.equal(duplicate.reasonCode, 'DUPLICATE_PROPOSAL');
    assert.equal((await session.getAccountState()).positions.length, 1, 'no stacking of exposure');
  } finally {
    await cleanup();
  }
});

test('PROTECTION: an opposite position is refused — reversal needs an explicit close', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    const reversal = await session.submit({ proposal: shortProposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    assert.equal(reversal.approved, false);
    assert.equal(reversal.reasonCode, 'CONFLICTING_POSITION');

    const account = await session.getAccountState();
    assert.equal(account.positions.length, 1);
    assert.equal(account.positions[0].side, 'LONG', 'the original position is untouched');
  } finally {
    await cleanup();
  }
});

test('PROTECTION: after closing, the same symbol may be traded again the same day', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    await session.closePosition({ symbol: 'BTCUSDT', market: await market.getSnapshot('BTCUSDT') });
    assert.equal((await session.getAccountState()).positions.length, 0);

    // Stage 2 explicitly forbids a day-wide symbol ban.
    const again = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    assert.equal(again.executed, true, `${again.reasonCode}: ${again.message}`);
  } finally {
    await cleanup();
  }
});

test('PROTECTION: modifyPositionProtection rejects a level on the wrong side', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    // A LONG stop above entry would trigger instantly; refuse it.
    const bad = await session.modifyPositionProtection({ symbol: 'BTCUSDT', stopLoss: 87000 });
    assert.equal(bad.ok, false);
    assert.equal(bad.reasonCode, 'INVALID_PROTECTION_LEVEL');

    const good = await session.modifyPositionProtection({ symbol: 'BTCUSDT', stopLoss: 85000 });
    assert.equal(good.ok, true);
    assert.equal(good.position.stopLoss, 85000);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------
test('JOURNAL: events are recorded in the order they actually happened', async () => {
  // A journal is only useful if it reconstructs the sequence of a trade. When
  // appends were fired concurrently, ORDER_FILLED landed before
  // ORDER_SUBMITTED — a history that contradicts itself.
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    market.setTicker({ markPrice: 87700, bid: 87699.9, ask: 87700.1, lastPrice: 87700 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const { events } = await session.journal.read();
    const order = events.map((event) => event.eventType);

    const position = (type) => order.indexOf(type);
    assert.ok(position('SIGNAL_RECEIVED') < position('RISK_ACCEPTED'), 'signal precedes acceptance');
    assert.ok(position('RISK_ACCEPTED') < position('ORDER_SUBMITTED'), 'acceptance precedes submission');
    assert.ok(position('ORDER_SUBMITTED') < position('ORDER_FILLED'), 'submission precedes the fill');
    assert.ok(position('ORDER_FILLED') < position('POSITION_OPENED'), 'a fill precedes the position opening');
    assert.ok(position('POSITION_OPENED') < position('TAKE_PROFIT_FILLED'), 'a position opens before it exits');
    assert.ok(position('TAKE_PROFIT_FILLED') < position('POSITION_CLOSED'), 'the exit fill precedes the close');

    // Timestamps must be non-decreasing too, so the file is ordered on disk.
    for (let index = 1; index < events.length; index += 1) {
      assert.ok(
        Date.parse(events[index].timestamp) >= Date.parse(events[index - 1].timestamp),
        `timestamps went backwards at event ${index} (${events[index].eventType})`,
      );
    }
  } finally {
    await cleanup();
  }
});

test('JOURNAL: the full lifecycle of a trade is recorded', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    market.setTicker({ markPrice: 87700, bid: 87699.9, ask: 87700.1, lastPrice: 87700 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const { events } = await session.journal.read();
    const types = events.map((event) => event.eventType);

    for (const required of [
      'SIGNAL_RECEIVED',
      'RISK_ACCEPTED',
      'ORDER_SUBMITTED',
      'ORDER_FILLED',
      'POSITION_OPENED',
      'TAKE_PROFIT_FILLED',
      'POSITION_CLOSED',
    ]) {
      assert.ok(types.includes(required), `journal is missing ${required}; got ${types.join(', ')}`);
    }
  } finally {
    await cleanup();
  }
});

test('JOURNAL: every event carries the documented fields', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    const { events } = await session.journal.read();
    assert.ok(events.length > 0);

    for (const event of events) {
      for (const field of ['timestamp', 'eventType', 'symbol', 'side', 'quantity', 'price', 'pnl', 'fee', 'reason', 'metadata']) {
        assert.ok(field in event, `event ${event.eventType} is missing the "${field}" field`);
      }
    }
  } finally {
    await cleanup();
  }
});

test('JOURNAL: a rejection is recorded with its reason code', async () => {
  const { session, cleanup } = await makeSession();
  try {
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 86000 }),
      market: await marketAt(86000).getSnapshot('BTCUSDT'),
    });

    const { events } = await session.journal.read();
    const rejection = events.find((event) => event.eventType === 'RISK_REJECTED');
    assert.ok(rejection, 'a rejected proposal must be journalled');
    assert.equal(rejection.reason, 'ZERO_RISK_DISTANCE');
  } finally {
    await cleanup();
  }
});

test('JOURNAL: a malformed final line is tolerated, corruption elsewhere is not', async () => {
  const { session, cleanup, paths } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    const before = (await session.journal.read()).events.length;

    // Append a partial line, mimicking a crash mid-write.
    await writeFile(paths.journalFile, '{"eventType":"POSITION_OPEN', { flag: 'a' });
    const after = await session.journal.read();
    assert.equal(after.events.length, before, 'the partial tail must not count as an event');
    assert.equal(after.skippedTail, true, 'the skipped tail must be reported, not hidden');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Restart recovery
// ---------------------------------------------------------------------------
test('RECOVERY: equity, positions and daily counters survive a restart', async () => {
  const { session, cleanup, restart } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    // Move the market so unrealized PnL is non-zero, then persist.
    market.setTicker({ markPrice: 86500, bid: 86499.9, ask: 86500.1, lastPrice: 86500 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const before = await session.getAccountState();

    const revived = await restart();
    assert.equal(revived.restored, true, 'state must be restored, not recreated');

    const after = await revived.getAccountState();
    assert.ok(Math.abs(after.equityUsd - before.equityUsd) < 1e-9, `${after.equityUsd} vs ${before.equityUsd}`);
    assert.equal(after.positions.length, 1, 'the open position is restored');
    assert.equal(after.positions[0].symbol, 'BTCUSDT');
    assert.equal(after.positions[0].entryPrice, before.positions[0].entryPrice);
    assert.equal(after.positions[0].stopLoss, before.positions[0].stopLoss);
    assert.equal(after.tradesToday, before.tradesToday, 'daily trade count is restored');
    assert.equal(after.initialEquityUsd, 340);
  } finally {
    await cleanup();
  }
});

test('RECOVERY: a restart does NOT silently reset the account to 340', async () => {
  const { session, cleanup, restart } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    // Force a loss so the restored equity must differ from the starting figure.
    market.setTicker({ markPrice: 85300, bid: 85299.9, ask: 85300.1, lastPrice: 85300 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const beforeLoss = await session.getAccountState();
    assert.ok(beforeLoss.equityUsd < 340, 'precondition: the account is under water');

    const revived = await restart();
    const after = await revived.getAccountState();

    assert.equal(revived.restored, true);
    assert.ok(
      Math.abs(after.equityUsd - 340) > 1e-9,
      `the account must not reset to 340 USD after a restart (got ${after.equityUsd})`,
    );
    assert.ok(Math.abs(after.equityUsd - beforeLoss.equityUsd) < 1e-9);
  } finally {
    await cleanup();
  }
});

test('RECOVERY: realized PnL and fees survive a restart', async () => {
  const { session, cleanup, restart } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });

    market.setTicker({ markPrice: 87700, bid: 87699.9, ask: 87700.1, lastPrice: 87700 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const before = await session.getAccountState();
    assert.ok(before.realizedPnlUsd > 0, 'precondition: a realized win');

    const after = await (await restart()).getAccountState();
    assert.ok(Math.abs(after.realizedPnlUsd - before.realizedPnlUsd) < 1e-9);
    assert.ok(Math.abs(after.feesUsd - before.feesUsd) < 1e-9);
  } finally {
    await cleanup();
  }
});

test('RECOVERY: a corrupted state file fails closed and is not overwritten', async () => {
  const { cleanup, paths, restart } = await makeSession();
  try {
    await writeFile(paths.stateFile, '{ this is not valid json');

    await assert.rejects(
      () => restart(),
      (error) => {
        assert.equal(error.name, 'CorruptStateError');
        assert.match(error.message, /Refusing to start rather than reset/);
        return true;
      },
      'corrupt state must abort startup',
    );

    // The damaged file must still be there: destroying it would erase the only
    // record of what the account really was.
    const { readFile } = await import('node:fs/promises');
    const contents = await readFile(paths.stateFile, 'utf8');
    assert.equal(contents, '{ this is not valid json');
  } finally {
    await cleanup();
  }
});

test('RECOVERY: an empty state file fails closed rather than starting fresh', async () => {
  const { cleanup, paths, restart } = await makeSession();
  try {
    await writeFile(paths.stateFile, '');

    await assert.rejects(
      () => restart(),
      (error) => {
        assert.equal(error.name, 'CorruptStateError');
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test('RECOVERY: a state file with a foreign schema version fails closed', async () => {
  const { cleanup, paths, restart } = await makeSession();
  try {
    await writeFile(paths.stateFile, JSON.stringify({ schemaVersion: 999, account: {}, daily: {} }));

    await assert.rejects(
      () => restart(),
      (error) => {
        assert.equal(error.name, 'CorruptStateError');
        assert.match(error.message, /schemaVersion/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Daily limits driven by the session
// ---------------------------------------------------------------------------
test('DAILY: the session feeds its counters to the Risk Engine automatically', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    const account = await session.getAccountState();
    assert.equal(account.tradesToday, 1, 'an executed entry consumes a daily trade slot');

    // A close must not consume another slot: the day limit counts entries.
    await session.closePosition({ symbol: 'BTCUSDT', market: await market.getSnapshot('BTCUSDT') });
    assert.equal((await session.getAccountState()).tradesToday, 1);
  } finally {
    await cleanup();
  }
});

test('DAILY: max trades per day is enforced through the session', async () => {
  const { session, cleanup } = await makeSession({
    riskConfig: { ...DEFAULT_RISK_LIMITS, maxTradesPerDay: 1 },
  });
  try {
    const market = marketAt(86000);
    const first = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    assert.equal(first.executed, true, first.reasonCode);

    await session.closePosition({ symbol: 'BTCUSDT', market: await market.getSnapshot('BTCUSDT') });

    const second = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    assert.equal(second.approved, false);
    assert.equal(second.reasonCode, 'MAX_TRADES_PER_DAY');
  } finally {
    await cleanup();
  }
});

test('DAILY: max open positions is enforced', async () => {
  const { session, cleanup } = await makeSession({
    riskConfig: { ...DEFAULT_RISK_LIMITS, maxOpenPositions: 1 },
  });
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    // A different symbol would be a second concurrent position.
    const second = await session.submit({
      proposal: proposal({ symbol: 'ETHUSDT', entryPrice: 3000, stopLossPrice: 2940, takeProfitPrice: 3140 }),
      market: await marketAt(86000).getSnapshot('BTCUSDT'),
    });
    assert.equal(second.approved, false);
    assert.equal(second.reasonCode, 'MAX_OPEN_POSITIONS');
  } finally {
    await cleanup();
  }
});

test('DAILY: the daily loss limit blocks new entries', async () => {
  // riskPerTradePct must not exceed maxDailyLossPct (a Stage 1 cross-field rule),
  // so the daily budget is lowered together with the per-trade risk.
  const { session, cleanup } = await makeSession({
    riskConfig: { ...DEFAULT_RISK_LIMITS, riskPerTradePct: 0.5, maxDailyLossPct: 0.5 },
  });
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    // Stop out to realize a loss that reaches the 0.5% daily budget.
    market.setTicker({ markPrice: 85200, bid: 85199.9, ask: 85200.1, lastPrice: 85200 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const afterLoss = await session.getAccountState();
    assert.ok(afterLoss.dailyRealizedPnlUsd < 0, `the loss is recorded against the day (got ${afterLoss.dailyRealizedPnlUsd})`);
    assert.ok(
      afterLoss.dailyRealizedPnlUsd <= -(afterLoss.equityUsd * 0.5) / 100,
      'the realized loss must have reached the daily limit for this test to mean anything',
    );

    const blocked = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    assert.equal(blocked.approved, false);
    assert.equal(blocked.reasonCode, 'DAILY_LOSS_LIMIT');
  } finally {
    await cleanup();
  }
});

test('DAILY: minimum risk/reward is enforced', async () => {
  const { session, cleanup } = await makeSession();
  try {
    // 720 risk against only 720 reward = 1.0R, below the 1.5 minimum.
    const outcome = await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 86720 }),
      market: await marketAt(86000).getSnapshot('BTCUSDT'),
    });

    assert.equal(outcome.approved, false);
    assert.equal(outcome.reasonCode, 'INVALID_RISK_REWARD');
  } finally {
    await cleanup();
  }
});

test('DAILY: an unapproved proposal never reaches the executor', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const before = await session.getAccountState();

    const outcome = await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 86000 }),
      market: await marketAt(86000).getSnapshot('BTCUSDT'),
    });

    assert.equal(outcome.approved, false);
    assert.equal(outcome.executed, false);

    const after = await session.getAccountState();
    assert.equal(after.equityUsd, before.equityUsd, 'a rejection must not move money');
    assert.equal(after.feesUsd, before.feesUsd, 'a rejection must not charge a fee');
    assert.equal(after.tradesToday, before.tradesToday, 'a rejection must not consume a trade slot');
  } finally {
    await cleanup();
  }
});