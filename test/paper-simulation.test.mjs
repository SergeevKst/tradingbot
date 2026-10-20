/**
 * Phase 5 simulation tests — fill models, partial fills, exit slippage,
 * portfolio/PnL domain snapshots and the risk-before-execution gate.
 *
 * Everything here is offline and deterministic: a fixed static book, a fixed
 * clock-free flow, and injected fill/fee models. Passing these tests says the
 * simulation plumbing is coherent and conservative; it says NOTHING about
 * whether any strategy would be profitable.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  makeSession,
  marketAt,
  proposal,
  shortProposal,
  feeModel,
  createZeroFeeModel,
  BTC_INSTRUMENT,
  quietLogger,
} from './paper-fixtures.mjs';
import {
  createFullFillModel,
  createNotionalCapFillModel,
  assertFillModel,
} from '../src/execution/fill-model.mjs';
import { createPaperExecutionAdapter } from '../src/execution/paper-execution-adapter.mjs';
import { createPaperAccountState, toPortfolioSnapshot } from '../src/state/paper-account.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { ValidationError } from '../src/errors/index.mjs';

// ---------------------------------------------------------------------------
// Fill model contract
// ---------------------------------------------------------------------------

test('FILL MODEL: the default fills the whole requested quantity', () => {
  const model = createFullFillModel();
  const decision = model.resolveFill({
    requestedQuantity: 0.004,
    price: 86000,
    symbol: 'BTCUSDT',
    side: 'LONG',
    stage: 'entry',
    instrument: BTC_INSTRUMENT,
  });
  assert.equal(decision.filledQuantity, 0.004);
  assert.equal(decision.unfilledQuantity, 0);
  assert.equal(decision.partial, false);
});

test('FILL MODEL: a notional cap fills a step-aligned partial and reports the shortfall', () => {
  const model = createNotionalCapFillModel({ maxNotionalPerFillUsd: 100 });
  const decision = model.resolveFill({
    requestedQuantity: 0.002,
    price: 86000,
    symbol: 'BTCUSDT',
    side: 'LONG',
    stage: 'entry',
    instrument: BTC_INSTRUMENT,
  });
  // 100 / 86000 = 0.001162… floored to the 0.001 step.
  assert.equal(decision.filledQuantity, 0.001);
  assert.equal(decision.unfilledQuantity, 0.001);
  assert.equal(decision.partial, true);
});

test('FILL MODEL: a cap larger than the order does not bind', () => {
  const model = createNotionalCapFillModel({ maxNotionalPerFillUsd: 1_000_000 });
  const decision = model.resolveFill({
    requestedQuantity: 0.002,
    price: 86000,
    symbol: 'BTCUSDT',
    side: 'LONG',
    stage: 'entry',
    instrument: BTC_INSTRUMENT,
  });
  assert.equal(decision.partial, false);
  assert.equal(decision.filledQuantity, 0.002);
});

test('FILL MODEL: a cap below one step fills nothing (no invented micro-order)', () => {
  const model = createNotionalCapFillModel({ maxNotionalPerFillUsd: 5 });
  const decision = model.resolveFill({
    requestedQuantity: 0.002,
    price: 86000,
    symbol: 'BTCUSDT',
    side: 'LONG',
    stage: 'entry',
    instrument: BTC_INSTRUMENT,
  });
  assert.equal(decision.filledQuantity, 0);
  assert.equal(decision.reason, 'NO_TRADABLE_FILL');
});

test('FILL MODEL: bad configuration and untrusted models are refused', () => {
  assert.throws(() => createNotionalCapFillModel({ maxNotionalPerFillUsd: 0 }), ConfigError);
  assert.throws(() => createNotionalCapFillModel({ maxNotionalPerFillUsd: Number.NaN }), ConfigError);
  assert.throws(() => assertFillModel({ kind: () => 'x' }), ConfigError);
  assert.throws(() => assertFillModel(null), ConfigError);
});

// ---------------------------------------------------------------------------
// Partial fills through the full session pipeline
// ---------------------------------------------------------------------------

test('PARTIAL FILL: only the filled quantity becomes a position and the trade costs one slot', async () => {
  const { session, cleanup } = await makeSession({
    fillModel: createNotionalCapFillModel({ maxNotionalPerFillUsd: 100 }),
  });
  try {
    const before = await session.getAccountState();
    const market = marketAt(86000);
    const outcome = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    assert.equal(outcome.approved, true, outcome.reasonCode);
    assert.equal(outcome.executed, true, outcome.reasonCode);

    const fill = outcome.executionResult.fill;
    assert.equal(fill.partial, true);
    assert.equal(fill.filledQuantity, 0.001);
    assert.equal(fill.unfilledQuantity, 0.001);
    assert.equal(fill.requestedQuantity, 0.002);

    const account = await session.getAccountState();
    assert.equal(account.positions.length, 1);
    assert.equal(account.positions[0].quantity, 0.001, 'the position carries only the filled size');
    assert.equal(account.tradesToday, before.tradesToday + 1, 'a partial entry is still one trade');
    // The entry fee is charged on the FILLED notional, not the requested one.
    const expectedFee = 0.001 * fill.fillPrice * 0.001;
    assert.ok(Math.abs(account.feesUsd - expectedFee) < 1e-12, `fee mismatch: ${account.feesUsd}`);
  } finally {
    await cleanup();
  }
});

test('PARTIAL FILL: the journal records the shortfall as a distinct event', async () => {
  const { session, cleanup } = await makeSession({
    fillModel: createNotionalCapFillModel({ maxNotionalPerFillUsd: 100 }),
  });
  try {
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await marketAt(86000).getSnapshot('BTCUSDT') });

    const { events } = await session.journal.read();
    const partial = events.find((event) => event.eventType === 'PARTIAL_FILL');
    assert.ok(partial, 'a partial fill must be journalled, not silently truncated');
    assert.equal(partial.quantity, 0.001);
    assert.equal(partial.metadata.requestedQuantity, 0.002);
    assert.equal(partial.metadata.unfilledQuantity, 0.001);

    const order = events.find((event) => event.eventType === 'ORDER_FILLED');
    assert.equal(order.metadata.partial, true);
  } finally {
    await cleanup();
  }
});

test('PARTIAL FILL: a cap below the minimum tradable size refuses the whole entry', async () => {
  const { session, cleanup } = await makeSession({
    fillModel: createNotionalCapFillModel({ maxNotionalPerFillUsd: 5 }),
  });
  try {
    const before = await session.getAccountState();
    const outcome = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await marketAt(86000).getSnapshot('BTCUSDT') });

    assert.equal(outcome.approved, true);
    assert.equal(outcome.executed, false);
    assert.equal(outcome.reasonCode, 'UNREPRESENTABLE_QUANTITY');

    const after = await session.getAccountState();
    assert.equal(after.positions.length, 0, 'no micro-position may be opened');
    assert.equal(after.equityUsd, before.equityUsd, 'a refused fill must not move money');
    assert.equal(after.tradesToday, before.tradesToday, 'a refused fill must not consume a trade slot');
  } finally {
    await cleanup();
  }
});

test('PARTIAL FILL: a partial never risks more than the approved full size', async () => {
  const { session, cleanup } = await makeSession({
    fillModel: createNotionalCapFillModel({ maxNotionalPerFillUsd: 100 }),
  });
  try {
    const outcome = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await marketAt(86000).getSnapshot('BTCUSDT') });
    const account = await session.getAccountState();
    const position = account.positions[0];

    const partialNotional = position.quantity * position.entryPrice;
    assert.ok(
      partialNotional <= outcome.riskResult.positionNotionalUsd + 1e-9,
      `partial notional ${partialNotional} must not exceed the approved ${outcome.riskResult.positionNotionalUsd}`,
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Exit slippage
// ---------------------------------------------------------------------------

test('SLIPPAGE: a stop gapped through records an adverse exit slippage', async () => {
  const { session, cleanup } = await makeSession({ fees: createZeroFeeModel() });
  try {
    const market = marketAt(86000);
    const opened = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    const quantity = opened.executionResult.fill.quantity;

    // The mark gaps BELOW the 85280 stop; the LONG is sold into the bid.
    market.setTicker({ markPrice: 84000, bid: 83999.9, ask: 84000.1, lastPrice: 84000 });
    const update = await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    assert.equal(update.closed.length, 1);
    const fill = update.closed[0].fill;
    assert.equal(fill.exitReason, 'STOP_LOSS');
    assert.equal(fill.fillPrice, 83999.9);
    assert.equal(fill.requestedPrice, 85280, 'slippage is measured against the stop level');
    const expected = (85280 - 83999.9) * quantity;
    assert.ok(Math.abs(fill.slippageUsd - expected) < 1e-9, `slippage mismatch: ${fill.slippageUsd} vs ${expected}`);
    assert.ok(fill.slippageUsd > 0, 'a gap through the stop is a cost');
  } finally {
    await cleanup();
  }
});

test('SLIPPAGE: a target gapped through records a favourable (negative) slippage', async () => {
  const { session, cleanup } = await makeSession({ fees: createZeroFeeModel() });
  try {
    const market = marketAt(86000);
    const opened = await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    const quantity = opened.executionResult.fill.quantity;

    market.setTicker({ markPrice: 87900, bid: 87899.9, ask: 87900.1, lastPrice: 87900 });
    const update = await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    assert.equal(update.closed.length, 1);
    const fill = update.closed[0].fill;
    assert.equal(fill.exitReason, 'TAKE_PROFIT');
    // Selling ABOVE the requested target is favourable, so slippage is negative.
    const expected = (87620 - 87899.9) * quantity;
    assert.ok(Math.abs(fill.slippageUsd - expected) < 1e-9, `slippage mismatch: ${fill.slippageUsd} vs ${expected}`);
    assert.ok(fill.slippageUsd < 0, 'a favourable gap is not charged as a cost');
  } finally {
    await cleanup();
  }
});

test('SLIPPAGE: an explicit close price has no slippage', async () => {
  const { session, cleanup } = await makeSession({ fees: createZeroFeeModel() });
  try {
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await marketAt(86000).getSnapshot('BTCUSDT') });
    const result = await session.closePosition({ symbol: 'BTCUSDT', price: 86100, reason: 'MANUAL' });
    assert.equal(result.ok, true);
    assert.equal(result.fill.requestedPrice, 86100);
    assert.equal(result.fill.slippageUsd, 0);

    // A manual close must record POSITION_CLOSED exactly once, not twice.
    const { events } = await session.journal.read();
    const closes = events.filter((event) => event.eventType === 'POSITION_CLOSED');
    assert.equal(closes.length, 1, `expected a single POSITION_CLOSED, got ${closes.length}`);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Portfolio / PnL domain snapshots
// ---------------------------------------------------------------------------

test('PORTFOLIO: the snapshot is a validated domain view of the paper ledger', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });

    const snapshot = await session.getPortfolioSnapshot();
    const account = await session.getAccountState();

    assert.equal(snapshot.source, 'paper');
    assert.equal(snapshot.equityUsd, account.equityUsd);
    assert.equal(snapshot.availableBalanceUsd, account.availableBalanceUsd);
    assert.equal(snapshot.balances.length, 1);
    assert.equal(snapshot.balances[0].asset, 'USDT');
    assert.equal(snapshot.positions.length, 1);
    assert.equal(snapshot.positions[0].symbol, 'BTCUSDT');
    assert.equal(snapshot.positions[0].stopLossPrice, 85280, 'protective levels are projected onto the domain type');
    assert.equal(snapshot.positions[0].takeProfitPrice, 87620);
    assert.equal(snapshot.positions[0].leverage, 2);
    assert.ok(Number.isInteger(snapshot.positions[0].openedAt), 'openedAt is epoch milliseconds');
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.positions));
  } finally {
    await cleanup();
  }
});

test('PORTFOLIO: the PnL snapshot nets fees out of the realized result', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const market = marketAt(86000);
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    const account = await session.getAccountState();

    const pnl = await session.getPnLSnapshot();
    assert.equal(pnl.realizedPnlUsd, account.realizedPnlUsd);
    assert.equal(pnl.unrealizedPnlUsd, account.unrealizedPnlUsd);
    assert.equal(pnl.feesUsd, account.feesUsd);
    assert.equal(pnl.netPnlUsd, account.realizedPnlUsd + account.unrealizedPnlUsd - account.feesUsd);
    assert.ok(Object.isFrozen(pnl));
  } finally {
    await cleanup();
  }
});

test('PORTFOLIO: a snapshot refuses a non-positive equity rather than misreporting', async () => {
  const { session, cleanup } = await makeSession();
  try {
    // The domain type requires equity > 0; a snapshot of a wiped-out account is
    // not representable and must fail loudly instead of being clamped.
    assert.throws(
      () =>
        toPortfolioSnapshot({
          ...createPaperAccountState({ equityUsd: 10 }),
          equityUsd: 0,
          availableBalanceUsd: 0,
          positions: [],
        }),
      ValidationError,
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Risk gate precedes execution
// ---------------------------------------------------------------------------

test('RISK GATE: a rejected proposal never reaches the executor', async () => {
  const { session, cleanup } = await makeSession();
  try {
    // Zero risk distance: refused by the Risk Engine before execution.
    const outcome = await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 86000 }),
      market: await marketAt(86000).getSnapshot('BTCUSDT'),
    });
    assert.equal(outcome.approved, false);
    assert.equal(outcome.executed, false);

    const { events } = await session.journal.read();
    const types = events.map((event) => event.eventType);
    assert.ok(!types.includes('ORDER_SUBMITTED'), 'no order may be submitted for a risk rejection');
    assert.ok(!types.includes('ORDER_FILLED'), 'no fill may exist for a risk rejection');
  } finally {
    await cleanup();
  }
});

test('RISK GATE: the executor refuses a non-approval handed to it directly', async () => {
  const account = createPaperAccountState({ equityUsd: 340 });
  const adapter = createPaperExecutionAdapter({
    account,
    feeModel: feeModel(),
    fillModel: createFullFillModel(),
    logger: quietLogger,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const result = await adapter.openPosition({
    proposal: proposal({ entryPrice: 86000 }),
    riskResult: { approved: false, reasonCode: 'RISK_LIMIT_EXCEEDED' },
    market: await marketAt(86000).getSnapshot('BTCUSDT'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'EXECUTION_REQUIRES_APPROVAL');
  const after = await adapter.getAccountState();
  assert.equal(after.positions.length, 0);
  assert.equal(after.equityUsd, 340, 'a refused execution must not move money');
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('DETERMINISM: identical inputs produce identical accounts (including partial fills)', async () => {
  const build = async () => {
    const { session, cleanup } = await makeSession({
      fillModel: createNotionalCapFillModel({ maxNotionalPerFillUsd: 100 }),
    });
    await session.submit({ proposal: proposal({ entryPrice: 86000 }), market: await marketAt(86000).getSnapshot('BTCUSDT') });
    const account = await session.getAccountState();
    await cleanup();
    return account;
  };

  // Timestamps are wall-clock by nature; strip them so only the deterministic
  // ledger arithmetic is compared.
  const stable = (account) => ({
    ...account,
    lastUpdatedAt: null,
    positions: account.positions.map((position) => ({ ...position, openedAt: null, updatedAt: null })),
  });

  const first = await build();
  const second = await build();

  assert.deepEqual(stable(first), stable(second), 'a replay of the same flow must reconstruct the same account');
});

test('SHORT: a partial fill still settles through a stop with correct PnL sign', async () => {
  const { session, cleanup } = await makeSession({
    fees: createZeroFeeModel(),
    fillModel: createNotionalCapFillModel({ maxNotionalPerFillUsd: 100 }),
  });
  try {
    const market = marketAt(86000);
    const opened = await session.submit({ proposal: shortProposal({ entryPrice: 86000 }), market: await market.getSnapshot('BTCUSDT') });
    assert.equal(opened.executionResult.fill.partial, true);

    // SHORT stop is at 86720; the mark gaps above it and the SHORT is bought at ask.
    market.setTicker({ markPrice: 87000, bid: 86999.9, ask: 87000.1, lastPrice: 87000 });
    const update = await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    assert.equal(update.closed.length, 1);
    assert.equal(update.closed[0].exitReason, 'STOP_LOSS');
    assert.ok(update.closed[0].netPnlUsd < 0, 'a short stopped out above entry loses');
  } finally {
    await cleanup();
  }
});
