/**
 * Required acceptance tests 1–15 from the Stage 1 specification, plus the
 * edge cases that share their theme.
 *
 * Node's built-in test runner only — no extra dependencies.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { evaluateTrade } from '../src/risk/risk-engine.mjs';
import { REASON_CODE } from '../src/domain/reason-code.mjs';
import { loadConfig } from '../src/config/env.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { createPaperExecutor } from '../src/execution/paper-executor.mjs';
import { accountState, longProposal, riskLimits, shortProposal } from './fixtures.mjs';

// ---------------------------------------------------------------------------
// TEST 1 — valid LONG is approved
// ---------------------------------------------------------------------------
test('TEST 1: valid LONG proposal is approved', () => {
  const result = evaluateTrade({ proposal: longProposal(), account: accountState() });

  assert.equal(result.approved, true, `expected approval, got ${result.reasonCode}: ${result.message}`);
  assert.equal(result.reasonCode, REASON_CODE.APPROVED);
  assert.ok(result.riskAmountUsd > 0, 'risk amount must be positive');
  assert.ok(result.positionNotionalUsd > 0, 'notional must be positive');
  assert.ok(result.estimatedQuantity > 0, 'quantity must be positive');
  assert.ok(result.riskReward > 1.5, 'RR must clear the minimum');
});

// ---------------------------------------------------------------------------
// TEST 2 — valid SHORT is approved
// ---------------------------------------------------------------------------
test('TEST 2: valid SHORT proposal is approved', () => {
  const result = evaluateTrade({ proposal: shortProposal(), account: accountState() });

  assert.equal(result.approved, true, `expected approval, got ${result.reasonCode}: ${result.message}`);
  assert.equal(result.side, 'SHORT');
  assert.ok(result.riskAmountUsd > 0);
});

// ---------------------------------------------------------------------------
// TEST 3 — LONG with stop above entry is rejected
// ---------------------------------------------------------------------------
test('TEST 3: LONG with stopLoss above entry is rejected', () => {
  const result = evaluateTrade({
    proposal: longProposal({ stopLossPrice: 87000 }),
    account: accountState(),
  });

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.STOP_LOSS_ON_WRONG_SIDE);
});

// ---------------------------------------------------------------------------
// TEST 4 — SHORT with stop below entry is rejected
// ---------------------------------------------------------------------------
test('TEST 4: SHORT with stopLoss below entry is rejected', () => {
  const result = evaluateTrade({
    proposal: shortProposal({ stopLossPrice: 85000 }),
    account: accountState(),
  });

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.STOP_LOSS_ON_WRONG_SIDE);
});

// ---------------------------------------------------------------------------
// TEST 5 — take profit on the wrong side is rejected
// ---------------------------------------------------------------------------
test('TEST 5: take profit on the wrong side is rejected', () => {
  const longWrongTp = evaluateTrade({
    proposal: longProposal({ takeProfitPrice: 85000 }),
    account: accountState(),
  });
  assert.equal(longWrongTp.approved, false);
  assert.equal(longWrongTp.reasonCode, REASON_CODE.TAKE_PROFIT_ON_WRONG_SIDE);

  const shortWrongTp = evaluateTrade({
    proposal: shortProposal({ takeProfitPrice: 87000 }),
    account: accountState(),
  });
  assert.equal(shortWrongTp.approved, false);
  assert.equal(shortWrongTp.reasonCode, REASON_CODE.TAKE_PROFIT_ON_WRONG_SIDE);
});

// ---------------------------------------------------------------------------
// TEST 6 — risk/reward below the minimum is rejected
// ---------------------------------------------------------------------------
test('TEST 6: risk/reward below 1.5 is rejected', () => {
  // LONG: risk 720, reward 480 => RR = 0.667
  const result = evaluateTrade({
    proposal: longProposal({ takeProfitPrice: 86480 }),
    account: accountState(),
  });

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.INVALID_RISK_REWARD);
  assert.ok(result.riskReward < 1.5);
});

test('TEST 6b: risk/reward exactly at the minimum is approved (boundary)', () => {
  // LONG: risk 720, reward 1080 => RR = 1.5 exactly
  const result = evaluateTrade({
    proposal: longProposal({ takeProfitPrice: 87080 }),
    account: accountState(),
    riskConfig: riskLimits({ minRiskReward: 1.5 }),
  });

  assert.equal(result.approved, true, `boundary RR should pass, got ${result.reasonCode}`);
  assert.ok(Math.abs(result.riskReward - 1.5) < 1e-9);
});

// ---------------------------------------------------------------------------
// TEST 7 — the leverage cap bounds risk, not the requested risk
// ---------------------------------------------------------------------------
test('TEST 7: position size is capped by max leverage so realised risk stays within budget', () => {
  // A very tight stop would demand an enormous notional; maxLeverage=2 must cap it.
  const result = evaluateTrade({
    proposal: longProposal({ stopLossPrice: 85990, takeProfitPrice: 86020 }),
    account: accountState(),
    riskConfig: riskLimits({ maxLeverage: 2 }),
  });

  assert.equal(result.approved, true, `expected approval, got ${result.reasonCode}: ${result.message}`);
  // Notional may never exceed equity * maxLeverage.
  assert.ok(
    result.positionNotionalUsd <= 340 * 2 + 1e-9,
    `notional ${result.positionNotionalUsd} must respect the leverage cap`,
  );
  assert.ok(result.effectiveLeverage <= 2 + 1e-9, `effective leverage ${result.effectiveLeverage} must be <= 2`);
  // Risk can only be reduced by the cap, never increased beyond the budget.
  assert.ok(result.riskAmountUsd <= 1.7 + 1e-9, `risk ${result.riskAmountUsd} must stay within the 0.5% budget`);
});

test('TEST 7b: per-trade risk budget is derived from equity, not hard-coded', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ equityUsd: 1000, availableBalanceUsd: 1000 }),
  });

  assert.equal(result.approved, true);
  // 0.5% of 1000 = 5 USD at risk.
  assert.ok(Math.abs(result.riskAmountUsd - 5) < 1e-9, `expected 5 USD risk, got ${result.riskAmountUsd}`);
});

// ---------------------------------------------------------------------------
// TEST 8 — daily loss limit halts new trades
// ---------------------------------------------------------------------------
test('TEST 8: daily loss limit reached rejects new trades', () => {
  // 2% of 340 = 6.8
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ dailyRealizedPnlUsd: -6.8 }),
  });

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.DAILY_LOSS_LIMIT);
});

test('TEST 8b: daily loss just inside the limit still trades', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ dailyRealizedPnlUsd: -6.79 }),
  });

  assert.equal(result.approved, true, `expected approval, got ${result.reasonCode}`);
});

test('TEST 8c: profit does not raise the daily loss allowance', () => {
  // A good day must not relax limits; the allowance is still -2% of equity.
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ dailyRealizedPnlUsd: 100 }),
  });
  assert.equal(result.approved, true);

  const stillLimited = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ dailyRealizedPnlUsd: -7 }),
  });
  assert.equal(stillLimited.reasonCode, REASON_CODE.DAILY_LOSS_LIMIT);
});

// ---------------------------------------------------------------------------
// TEST 9 — max open positions
// ---------------------------------------------------------------------------
test('TEST 9: max open positions reached rejects new trades', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({
      openPositions: [
        { symbol: 'ETHUSDT', side: 'LONG', quantity: 1 },
        { symbol: 'SOLUSDT', side: 'LONG', quantity: 1 },
      ],
    }),
  });

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.MAX_OPEN_POSITIONS);
});

// ---------------------------------------------------------------------------
// TEST 10 — max trades per day
// ---------------------------------------------------------------------------
test('TEST 10: max trades per day reached rejects new trades', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ tradesToday: 10 }),
  });

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.MAX_TRADES_PER_DAY);
});

// ---------------------------------------------------------------------------
// TEST 11 — leverage cap is enforced as configuration
// ---------------------------------------------------------------------------
test('TEST 11: effective leverage may never exceed the configured maximum', () => {
  for (const maxLeverage of [1, 2, 3]) {
    const result = evaluateTrade({
      proposal: longProposal({ stopLossPrice: 85999, takeProfitPrice: 86004 }),
      account: accountState(),
      riskConfig: riskLimits({ maxLeverage }),
    });

    if (result.approved) {
      assert.ok(
        result.effectiveLeverage <= maxLeverage + 1e-9,
        `effective leverage ${result.effectiveLeverage} exceeded cap ${maxLeverage}`,
      );
      assert.equal(result.maxAllowedLeverage, maxLeverage);
    } else {
      // If it cannot be approved within the cap, it must be a leverage-related refusal.
      assert.equal(result.reasonCode, REASON_CODE.LEVERAGE_LIMIT);
    }
  }
});

// ---------------------------------------------------------------------------
// TEST 12 — high confidence does NOT increase position size
// ---------------------------------------------------------------------------
test('TEST 12: confidence 0.99 does not increase position size', () => {
  const low = evaluateTrade({ proposal: longProposal({ confidence: 0.5 }), account: accountState() });
  const high = evaluateTrade({ proposal: longProposal({ confidence: 0.99 }), account: accountState() });

  assert.equal(low.approved, true);
  assert.equal(high.approved, true);
  assert.equal(high.positionNotionalUsd, low.positionNotionalUsd, 'notional must be independent of confidence');
  assert.equal(high.estimatedQuantity, low.estimatedQuantity, 'quantity must be independent of confidence');
  assert.equal(high.riskAmountUsd, low.riskAmountUsd, 'risk must be independent of confidence');
});

// ---------------------------------------------------------------------------
// TEST 13 — low confidence does NOT tighten or relax limits
// ---------------------------------------------------------------------------
test('TEST 13: confidence 0.51 does not weaken or tighten the risk limit', () => {
  const result = evaluateTrade({ proposal: longProposal({ confidence: 0.51 }), account: accountState() });

  assert.equal(result.approved, true);
  const baseline = evaluateTrade({ proposal: longProposal({ confidence: 0.5 }), account: accountState() });
  assert.equal(result.riskAmountUsd, baseline.riskAmountUsd);
  assert.equal(result.positionNotionalUsd, baseline.positionNotionalUsd);
});

test('TEST 13b: confidence 0.0 is still evaluated purely on risk', () => {
  const result = evaluateTrade({ proposal: longProposal({ confidence: 0 }), account: accountState() });
  assert.equal(result.approved, true, 'confidence must not be a gate on its own');
});

// ---------------------------------------------------------------------------
// TEST 14 — PAPER mode never calls Bybit
// ---------------------------------------------------------------------------
test('TEST 14: paper mode executes without any network access', async () => {
  // Trip any outbound HTTP attempt: in PAPER mode none may occur.
  const originals = { fetch: globalThis.fetch, httpRequest: undefined };
  let networkAttempted = false;
  globalThis.fetch = (...args) => {
    networkAttempted = true;
    throw new Error(`network access attempted in PAPER mode: ${String(args[0])}`);
  };

  try {
    const executor = createPaperExecutor();
    const proposal = longProposal();
    const result = evaluateTrade({ proposal, account: accountState() });
    assert.equal(result.approved, true);

    const fill = executor.execute(proposal, result);
    assert.equal(fill.simulated, true);
    assert.equal(executor.canPlaceRealOrders, false);
    assert.equal(executor.kind, 'PAPER');
    assert.equal(networkAttempted, false, 'PAPER mode must never attempt network access');
  } finally {
    globalThis.fetch = originals.fetch;
  }
});

test('TEST 14b: the paper executor refuses to execute a rejected proposal', () => {
  const executor = createPaperExecutor();
  const proposal = longProposal({ stopLossPrice: 87000 });
  const rejected = evaluateTrade({ proposal, account: accountState() });

  assert.equal(rejected.approved, false);
  assert.throws(() => executor.execute(proposal, rejected), ConfigError);
  assert.equal(executor.count(), 0);
});

// ---------------------------------------------------------------------------
// TEST 15 — invalid configuration fails at startup
// ---------------------------------------------------------------------------
test('TEST 15: an invalid TRADING_MODE fails configuration loading', () => {
  assert.throws(() => loadConfig({ TRADING_MODE: 'TURBO' }), ConfigError);
});

test('TEST 15b: TRADING_MODE defaults to PAPER when unset', () => {
  const config = loadConfig({});
  assert.equal(config.tradingMode, 'PAPER');
  assert.equal(config.offlineMode, true);
});

test('TEST 15c: LIVE without an explicit opt-in is refused', () => {
  assert.throws(() => loadConfig({ TRADING_MODE: 'LIVE' }), ConfigError);
});

test('TEST 15d: LIVE with the opt-in is still refused in Stage 1', () => {
  assert.throws(() => loadConfig({ TRADING_MODE: 'LIVE', ALLOW_LIVE_TRADING: 'true' }), ConfigError);
});

test('TEST 15e: malformed risk limits are rejected', () => {
  assert.throws(() => loadConfig({ RISK_PER_TRADE_PCT: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ RISK_MAX_LEVERAGE: '0' }), ConfigError);
  assert.throws(() => loadConfig({ RISK_MAX_OPEN_POSITIONS: '2.5' }), ConfigError);
  assert.throws(() => loadConfig({ RISK_MAX_TRADES_PER_DAY: '-1' }), ConfigError);
});

test('TEST 15f: risk per trade above the daily loss limit is refused as incoherent', () => {
  assert.throws(
    () => loadConfig({ RISK_PER_TRADE_PCT: '5', RISK_MAX_DAILY_LOSS_PCT: '2' }),
    ConfigError,
    'a single trade must not be able to breach the daily stop',
  );
});

test('TEST 15g: half-configured credentials are refused', () => {
  assert.throws(() => loadConfig({ BYBIT_API_KEY: 'only-key' }), ConfigError);
  assert.throws(() => loadConfig({ BYBIT_API_SECRET: 'only-secret' }), ConfigError);
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------
test('EDGE: a proposal missing a stop loss is rejected when SL is required', () => {
  const proposal = longProposal();
  delete /** @type {any} */ (proposal).stopLossPrice;

  const result = evaluateTrade({ proposal, account: accountState() });
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.MISSING_STOP_LOSS);
});

test('EDGE: a stop loss at exactly the entry price is rejected', () => {
  const result = evaluateTrade({
    proposal: longProposal({ stopLossPrice: 86000 }),
    account: accountState(),
  });
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.ZERO_RISK_DISTANCE);
});

test('EDGE: a duplicate proposal for an already-open symbol is rejected', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ openPositions: [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01 }] }),
  });
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.DUPLICATE_PROPOSAL);
});

test('EDGE: an opposing position on the same symbol is rejected', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ openPositions: [{ symbol: 'BTCUSDT', side: 'SHORT', quantity: 0.01 }] }),
  });
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.CONFLICTING_POSITION);
});

test('EDGE: a symbol already traded today is refused as a duplicate', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ tradedSymbolsToday: ['BTCUSDT'] }),
  });
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.DUPLICATE_PROPOSAL);
});

test('EDGE: zero or negative equity is rejected rather than sized', () => {
  for (const equityUsd of [0, -100]) {
    const result = evaluateTrade({ proposal: longProposal(), account: accountState({ equityUsd }) });
    assert.equal(result.approved, false);
    assert.equal(result.reasonCode, REASON_CODE.INVALID_ACCOUNT_STATE);
  }
});

test('EDGE: insufficient available balance is rejected', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ equityUsd: 340, availableBalanceUsd: 0.5 }),
    riskConfig: riskLimits({ maxLeverage: 10 }),
  });
  assert.equal(result.approved, false);
  // Either the notional is capped below the instrument minimum or balance-bound.
  assert.ok(
    [REASON_CODE.INSUFFICIENT_BALANCE, REASON_CODE.RISK_AMOUNT_TOO_SMALL, REASON_CODE.POSITION_NOTIONAL_TOO_SMALL].includes(
      result.reasonCode,
    ),
    `unexpected reason ${result.reasonCode}`,
  );
});

test('EDGE: an entry far from the mark price is rejected as stale', () => {
  const result = evaluateTrade({
    proposal: longProposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87600 }),
    account: accountState(),
    market: { markPrice: 50000 },
  });
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.NONSENSICAL_PRICE_GEOMETRY);
});

test('EDGE: instrument minimum notional blocks a dust position', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ equityUsd: 5, availableBalanceUsd: 5 }),
    market: { markPrice: 86000, instrument: { minNotionalUsd: 100 } },
  });
  assert.equal(result.approved, false);
  assert.ok(
    [REASON_CODE.POSITION_NOTIONAL_TOO_SMALL, REASON_CODE.RISK_AMOUNT_TOO_SMALL].includes(result.reasonCode),
    `unexpected reason ${result.reasonCode}`,
  );
});

test('EDGE: unknown proposal fields are rejected, not ignored', () => {
  const result = evaluateTrade({
    proposal: { ...longProposal(), quantity: 999, leverage: 50 },
    account: accountState(),
  });
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.MALFORMED_PROPOSAL);
});

test('EDGE: an invalid side is rejected', () => {
  const result = evaluateTrade({ proposal: longProposal({ side: 'FLAT' }), account: accountState() });
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.INVALID_SIDE);
});

test('EDGE: confidence outside [0,1] is rejected', () => {
  for (const confidence of [-0.1, 1.1, Number.NaN]) {
    const result = evaluateTrade({ proposal: longProposal({ confidence }), account: accountState() });
    assert.equal(result.approved, false);
    assert.equal(result.reasonCode, REASON_CODE.INVALID_CONFIDENCE);
  }
});

test('EDGE: evaluation is deterministic across repeated calls', () => {
  const first = evaluateTrade({ proposal: longProposal(), account: accountState() });
  const second = evaluateTrade({ proposal: longProposal(), account: accountState() });

  assert.deepEqual({ ...first, evaluatedAt: null }, { ...second, evaluatedAt: null });
});

test('EDGE: evaluateTrade does not mutate its inputs', () => {
  const proposal = longProposal();
  const account = accountState();
  const proposalSnapshot = JSON.stringify(proposal);
  const accountSnapshot = JSON.stringify(account);

  evaluateTrade({ proposal, account });

  assert.equal(JSON.stringify(proposal), proposalSnapshot, 'proposal must not be mutated');
  assert.equal(JSON.stringify(account), accountSnapshot, 'account must not be mutated');
});

test('EDGE: fail-closed on a null or malformed input', () => {
  for (const bad of [null, undefined, 42, 'nope', []]) {
    const result = evaluateTrade(/** @type {any} */ (bad));
    assert.equal(result.approved, false, `input ${JSON.stringify(bad)} must not be approved`);
  }
});

test('EDGE: fail-closed when an invalid risk config is injected', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState(),
    riskConfig: /** @type {any} */ ({ maxLeverage: 'many', riskPerTradePct: 0.5 }),
  });
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.INVALID_RISK_CONFIG);
});

test('EDGE: a throwing proposal object is turned into a rejection, never an approval', () => {
  const evil = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('boom');
      },
      get() {
        throw new Error('boom');
      },
    },
  );

  const result = evaluateTrade({ proposal: evil, account: accountState() });
  assert.equal(result.approved, false);
});

test('EDGE: SHORT geometry sizes identically to a mirrored LONG', () => {
  const long = evaluateTrade({
    proposal: longProposal({ entryPrice: 100, stopLossPrice: 98, takeProfitPrice: 105 }),
    account: accountState(),
  });
  const short = evaluateTrade({
    proposal: shortProposal({ entryPrice: 100, stopLossPrice: 102, takeProfitPrice: 95 }),
    account: accountState({ tradedSymbolsToday: [] }),
  });

  assert.equal(long.approved, true);
  assert.equal(short.approved, true);
  assert.ok(Math.abs(long.riskAmountUsd - short.riskAmountUsd) < 1e-9, 'mirrored geometry must risk the same amount');
  assert.ok(Math.abs(long.estimatedQuantity - short.estimatedQuantity) < 1e-12);
});

test('EDGE: rejection results always carry a reason code and a message', () => {
  const cases = [
    longProposal({ stopLossPrice: 87000 }),
    longProposal({ takeProfitPrice: 86480 }),
    { ...longProposal(), side: 'SIDEWAYS' },
  ];

  for (const proposal of cases) {
    const result = evaluateTrade({ proposal, account: accountState() });
    assert.equal(result.approved, false);
    assert.equal(typeof result.reasonCode, 'string');
    assert.ok(result.reasonCode.length > 0, 'reason code must be present');
    assert.ok(result.message.length > 0, 'message must be present');
  }
});