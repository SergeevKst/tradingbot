/**
 * Stage 2 tests — paper account state, positions, fees and the UTC daily session.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  createPaperAccountState,
  validatePaperAccountState,
  recomputeAccount,
  lockedMarginUsd,
  toRiskAccountView,
} from '../src/state/paper-account.mjs';
import {
  computeUnrealizedPnl,
  computeInitialMargin,
  validatePaperPosition,
  markPosition,
} from '../src/state/paper-position.mjs';
import { createRateFeeModel, createZeroFeeModel } from '../src/state/fee-model.mjs';
import {
  createDailyState,
  rollDailyStateIfNeeded,
  recordDailyActivity,
  utcDayKey,
} from '../src/state/daily-state.mjs';
import { ConfigError } from '../src/config/config-error.mjs';

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
test('ACCOUNT: starts at the configured equity with nothing open', () => {
  const account = createPaperAccountState({ equityUsd: 340 });

  assert.equal(account.initialEquityUsd, 340);
  assert.equal(account.equityUsd, 340);
  assert.equal(account.availableBalanceUsd, 340);
  assert.equal(account.realizedPnlUsd, 0);
  assert.equal(account.unrealizedPnlUsd, 0);
  assert.equal(account.feesUsd, 0);
  assert.deepEqual(account.positions, []);
  assert.equal(account.tradesToday, 0);
  assert.equal(account.dailyRealizedPnlUsd, 0);
  assert.equal(account.dayStartEquityUsd, 340);
});

test('ACCOUNT: a non-positive starting equity is refused', () => {
  assert.throws(() => createPaperAccountState({ equityUsd: 0 }), ConfigError);
  assert.throws(() => createPaperAccountState({ equityUsd: -10 }), ConfigError);
});

test('ACCOUNT: equity tracks realized PnL minus fees plus unrealized', () => {
  const base = createPaperAccountState({ equityUsd: 340 });

  const afterProfit = recomputeAccount({ ...base, realizedPnlUsd: 10, feesUsd: 1 });
  assert.equal(afterProfit.equityUsd, 349, '340 + 10 - 1');

  const withPosition = recomputeAccount({
    ...base,
    positions: Object.freeze([
      validatePaperPosition({
        symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, entryPrice: 86000, markPrice: 87000, leverage: 2,
      }),
    ]),
  });
  assert.equal(withPosition.unrealizedPnlUsd, 10, '(87000-86000)*0.01');
  assert.equal(withPosition.equityUsd, 350);
});

test('ACCOUNT: margin is locked by open positions and subtracted from available balance', () => {
  const base = createPaperAccountState({ equityUsd: 340 });
  const position = validatePaperPosition({
    symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, entryPrice: 86000, markPrice: 86000, leverage: 2,
  });

  const account = recomputeAccount({ ...base, positions: Object.freeze([position]) });

  assert.equal(lockedMarginUsd(account), 430, '86000 * 0.01 / 2');
  assert.equal(account.equityUsd, 340, 'margin stays part of equity');
  assert.equal(account.availableBalanceUsd, -90, 'equity minus locked margin');
});

test('ACCOUNT: validation refuses duplicate symbols', () => {
  // One net position per symbol is the Stage 2 rule; a state holding two is
  // corrupt and must not be silently merged.
  assert.throws(
    () =>
      validatePaperAccountState({
        initialEquityUsd: 340,
        realizedPnlUsd: 0,
        feesUsd: 0,
        tradesToday: 1,
        dayStartEquityUsd: 340,
        positions: [
          { symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, entryPrice: 86000, markPrice: 86000, leverage: 2 },
          { symbol: 'BTCUSDT', side: 'SHORT', quantity: 0.01, entryPrice: 86000, markPrice: 86000, leverage: 2 },
        ],
      }),
    ConfigError,
  );
});

test('ACCOUNT: validation recomputes derived fields instead of trusting them', () => {
  const account = validatePaperAccountState({
    initialEquityUsd: 340,
    // Deliberately wrong values: these must be recomputed, not believed.
    equityUsd: 99999,
    availableBalanceUsd: 99999,
    realizedPnlUsd: 10,
    feesUsd: 2,
    tradesToday: 0,
    dayStartEquityUsd: 340,
    positions: [],
  });

  assert.equal(account.equityUsd, 348, '340 + 10 - 2');
  assert.equal(account.availableBalanceUsd, 348);
});

test('ACCOUNT: the risk-engine projection exposes only what the engine needs', () => {
  const base = createPaperAccountState({ equityUsd: 340 });
  const view = toRiskAccountView(base);

  assert.equal(view.equityUsd, 340);
  assert.equal(view.peakEquityUsd, 340, 'the drawdown high-water mark is projected');
  assert.equal(view.tradesToday, 0);
  assert.deepEqual(view.openPositions, []);
  assert.deepEqual(view.openOrders, []);
  assert.equal('feesUsd' in view, false, 'the engine does not need fee bookkeeping');
});

test('ACCOUNT: the high-water mark rises with equity and never falls', () => {
  const base = createPaperAccountState({ equityUsd: 340 });
  assert.equal(base.peakEquityUsd, 340);

  const up = recomputeAccount({ ...base, realizedPnlUsd: 60 });
  assert.equal(up.equityUsd, 400);
  assert.equal(up.peakEquityUsd, 400, 'a new high is recorded');

  const down = recomputeAccount({ ...up, realizedPnlUsd: 0 });
  assert.equal(down.equityUsd, 340);
  assert.equal(down.peakEquityUsd, 400, 'the peak survives the drawdown');
});

test('ACCOUNT: the projection carries per-position notional for exposure caps', () => {
  const base = createPaperAccountState({ equityUsd: 340 });
  const position = validatePaperPosition({
    symbol: 'BTCUSDT', side: 'LONG', quantity: 0.001, entryPrice: 86000, markPrice: 86000, leverage: 2,
  });
  const account = recomputeAccount({ ...base, positions: Object.freeze([position]) });

  const view = toRiskAccountView(account);
  assert.equal(view.openPositions[0].notionalUsd, 86, 'quantity * entryPrice');
});

// ---------------------------------------------------------------------------
// Position PnL — the formulas from the spec
// ---------------------------------------------------------------------------
test('POSITION: LONG unrealized PnL = (mark - entry) * qty', () => {
  assert.equal(computeUnrealizedPnl({ side: 'LONG', entryPrice: 86000, markPrice: 87000, quantity: 0.01 }), 10);
  assert.equal(computeUnrealizedPnl({ side: 'LONG', entryPrice: 86000, markPrice: 85000, quantity: 0.01 }), -10);
  assert.equal(computeUnrealizedPnl({ side: 'LONG', entryPrice: 86000, markPrice: 86000, quantity: 0.01 }), 0);
});

test('POSITION: SHORT unrealized PnL = (entry - mark) * qty', () => {
  assert.equal(computeUnrealizedPnl({ side: 'SHORT', entryPrice: 86000, markPrice: 85000, quantity: 0.01 }), 10);
  assert.equal(computeUnrealizedPnl({ side: 'SHORT', entryPrice: 86000, markPrice: 87000, quantity: 0.01 }), -10);
  assert.equal(computeUnrealizedPnl({ side: 'SHORT', entryPrice: 86000, markPrice: 86000, quantity: 0.01 }), 0);
});

test('POSITION: the PnL formula is deterministic and symmetric', () => {
  // Same inputs always give the same answer, and a LONG losing by X equals a
  // SHORT winning by X for the same prices — a useful invariant to pin down.
  const long = computeUnrealizedPnl({ side: 'LONG', entryPrice: 86000, markPrice: 85500, quantity: 0.02 });
  const short = computeUnrealizedPnl({ side: 'SHORT', entryPrice: 86000, markPrice: 86000 + 500, quantity: 0.02 });
  assert.equal(long, short);
  assert.equal(long, computeUnrealizedPnl({ side: 'LONG', entryPrice: 86000, markPrice: 85500, quantity: 0.02 }));
});

test('POSITION: invalid inputs raise rather than producing a silent zero', () => {
  assert.throws(() => computeUnrealizedPnl({ side: 'LONG', entryPrice: Number.NaN, markPrice: 1, quantity: 1 }), ConfigError);
  assert.throws(() => computeUnrealizedPnl({ side: 'LONG', entryPrice: 1, markPrice: 1, quantity: Infinity }), ConfigError);
});

test('POSITION: initial margin is notional / leverage', () => {
  assert.equal(computeInitialMargin({ notionalUsd: 860, leverage: 2 }), 430);
  assert.equal(computeInitialMargin({ notionalUsd: 860, leverage: 1 }), 860);
  assert.throws(() => computeInitialMargin({ notionalUsd: 100, leverage: 0 }), ConfigError);
});

test('POSITION: marking to a new price recomputes unrealized PnL', () => {
  const position = validatePaperPosition({
    symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, entryPrice: 86000, markPrice: 86000, leverage: 2,
  });
  assert.equal(position.unrealizedPnlUsd, 0);

  const marked = markPosition(position, 86500, new Date().toISOString());
  assert.equal(marked.markPrice, 86500);
  assert.equal(marked.unrealizedPnlUsd, 5, '(86500-86000)*0.01');
});

test('POSITION: validation rejects a non-positive quantity or price', () => {
  const valid = { symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, entryPrice: 86000, markPrice: 86000, leverage: 2 };
  assert.throws(() => validatePaperPosition({ ...valid, quantity: 0 }), ConfigError);
  assert.throws(() => validatePaperPosition({ ...valid, entryPrice: -1 }), ConfigError);
  assert.throws(() => validatePaperPosition({ ...valid, side: 'SIDEWAYS' }), ConfigError);
  assert.throws(() => validatePaperPosition({ ...valid, leverage: 0 }), ConfigError);
});

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------
test('FEES: entry and exit fees are notional * rate', () => {
  const model = createRateFeeModel({ entryRate: 0.001, exitRate: 0.001 });

  const entry = model.getEntryFee({ notionalUsd: 1000, price: 86000, quantity: 0.01, symbol: 'BTCUSDT' });
  assert.ok(Math.abs(entry - 1) < 1e-12, `entry fee was ${entry}`);

  const exit = model.getExitFee({ notionalUsd: 1000, price: 86000, quantity: 0.01, symbol: 'BTCUSDT' });
  assert.ok(Math.abs(exit - 1) < 1e-12);
});

test('FEES: the two rates are independent', () => {
  const model = createRateFeeModel({ entryRate: 0.001, exitRate: 0.0005 });
  const input = { notionalUsd: 1000, price: 1, quantity: 1000, symbol: 'X' };

  assert.ok(Math.abs(model.getEntryFee(input) - 1) < 1e-12);
  assert.ok(Math.abs(model.getExitFee(input) - 0.5) < 1e-12);
});

test('FEES: a zero model charges nothing', () => {
  const model = createZeroFeeModel();
  assert.equal(model.getEntryFee({ notionalUsd: 1000, price: 1, quantity: 1, symbol: 'X' }), 0);
  assert.equal(model.getExitFee({ notionalUsd: 1000, price: 1, quantity: 1, symbol: 'X' }), 0);
});

test('FEES: a negative rate or malformed model is refused', () => {
  assert.throws(() => createRateFeeModel({ entryRate: -0.001 }), ConfigError);
  assert.throws(() => createRateFeeModel({ exitRate: Number.NaN }), ConfigError);
});

test('FEES: total cost of a round trip is entry + exit', () => {
  const model = createRateFeeModel({ entryRate: 0.001, exitRate: 0.001 });
  const entryNotional = 860 * 1;
  const exitNotional = 870 * 1;
  const total =
    model.getEntryFee({ notionalUsd: entryNotional, price: 860, quantity: 1, symbol: 'X' }) +
    model.getExitFee({ notionalUsd: exitNotional, price: 870, quantity: 1, symbol: 'X' });

  assert.ok(Math.abs(total - (0.86 + 0.87)) < 1e-12, `total was ${total}`);
});

// ---------------------------------------------------------------------------
// Daily session (UTC)
// ---------------------------------------------------------------------------
test('DAILY: a fresh day starts with zero counters at current equity', () => {
  const state = createDailyState({ equityUsd: 340, timestamp: Date.parse('2026-03-15T10:00:00Z') });

  assert.equal(state.tradingDay, '2026-03-15');
  assert.equal(state.tradesToday, 0);
  assert.equal(state.dailyRealizedPnlUsd, 0);
  assert.equal(state.dayStartEquityUsd, 340);
  assert.equal(state.timezone, 'UTC');
});

test('DAILY: the day key comes from UTC, never the machine timezone', () => {
  // 23:30 UTC is a different calendar day in many timezones; the key must not
  // follow the host's local clock, or two machines would disagree on when the
  // daily limits reset.
  assert.equal(utcDayKey(Date.parse('2026-03-15T23:30:00Z')), '2026-03-15');
  assert.equal(utcDayKey(Date.parse('2026-03-16T00:30:00Z')), '2026-03-16');

  const late = createDailyState({ equityUsd: 340, timestamp: Date.parse('2026-03-15T23:59:59Z') });
  assert.equal(late.tradingDay, '2026-03-15');
});

test('DAILY: no rollover when the UTC day is unchanged', () => {
  const state = createDailyState({ equityUsd: 340, timestamp: Date.parse('2026-03-15T00:01:00Z') });
  const same = rollDailyStateIfNeeded(state, { timestamp: Date.parse('2026-03-15T23:59:00Z'), equityUsd: 400 });

  assert.equal(same, state, 'the same object must be returned when nothing changed');
});

test('DAILY: crossing into a new UTC day resets counters and re-bases equity', () => {
  let state = createDailyState({ equityUsd: 340, timestamp: Date.parse('2026-03-15T10:00:00Z') });
  state = recordDailyActivity(state, { realizedPnlUsd: -5, countTrade: true, timestamp: Date.parse('2026-03-15T11:00:00Z') });
  assert.equal(state.tradesToday, 1);
  assert.equal(state.dailyRealizedPnlUsd, -5);

  const rolled = rollDailyStateIfNeeded(state, { timestamp: Date.parse('2026-03-16T00:00:01Z'), equityUsd: 335 });

  assert.equal(rolled.tradingDay, '2026-03-16');
  assert.equal(rolled.tradesToday, 0, 'daily trade count resets');
  assert.equal(rolled.dailyRealizedPnlUsd, 0, 'daily PnL resets');
  assert.equal(rolled.dayStartEquityUsd, 335, 'the new day opens at current equity, not the original');
});

test('DAILY: recording activity accumulates PnL and optionally counts a trade', () => {
  let state = createDailyState({ equityUsd: 340, timestamp: Date.parse('2026-03-15T10:00:00Z') });
  const now = Date.parse('2026-03-15T12:00:00Z');

  state = recordDailyActivity(state, { realizedPnlUsd: 2.5, countTrade: true, timestamp: now });
  state = recordDailyActivity(state, { realizedPnlUsd: -1.5, countTrade: false, timestamp: now });

  assert.equal(state.tradesToday, 1, 'only an entry consumes a daily trade slot');
  assert.equal(state.dailyRealizedPnlUsd, 1);
});

test('DAILY: a non-finite PnL is refused rather than poisoning the counter', () => {
  const state = createDailyState({ equityUsd: 340, timestamp: Date.parse('2026-03-15T10:00:00Z') });
  assert.throws(
    () => recordDailyActivity(state, { realizedPnlUsd: Number.NaN, timestamp: Date.now() }),
    ConfigError,
  );
});

test('DAILY: an unsupported timezone is refused', () => {
  assert.throws(() => createDailyState({ equityUsd: 340, timestamp: Date.now(), timezone: 'Europe/Berlin' }), ConfigError);
});