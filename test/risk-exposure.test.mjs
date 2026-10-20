/**
 * Phase 4 hardening tests — exposure controls, maximum drawdown, and the
 * operational kill switch at the engine boundary.
 *
 * These deliberately go beyond the Stage 1 acceptance tests: every new limit is
 * exercised at its boundary, in both directions, and the fail-closed paths
 * (malformed config, malformed account, malformed toggle) are pinned down.
 * Everything is offline, deterministic and uses the shared fixtures.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createRiskEngine, evaluateTrade, isRuntimeKillSwitchEngaged } from '../src/risk/risk-engine.mjs';
import { createKillSwitch } from '../src/risk/kill-switch.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { REASON_CODE } from '../src/domain/reason-code.mjs';
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';
import { accountState, longProposal, riskLimits } from './fixtures.mjs';

/** The working geometry of `longProposal`: 720 risk on an 86000 entry. */
const STOP_FRACTION = (86000 - 85280) / 86000;
/** Position notional the default 0.5% of 340 USD risk would demand uncapped. */
const RAW_NOTIONAL = 1.7 / STOP_FRACTION;

// ---------------------------------------------------------------------------
// Exposure — per-symbol cap
// ---------------------------------------------------------------------------
test('EXPOSURE: a per-symbol cap shrinks the position instead of breaching it', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState(),
    // 10% of 340 = 34 USD, well below the 203 USD the stop distance demands.
    riskConfig: riskLimits({ maxSymbolExposurePct: 10 }),
  });

  assert.equal(result.approved, true, `${result.reasonCode}: ${result.message}`);
  assert.ok(Math.abs(result.positionNotionalUsd - 34) < 1e-9, `notional ${result.positionNotionalUsd}`);
  assert.ok(result.effectiveLeverage <= 0.1 + 1e-9);
  // Risk is honestly reduced by the cap, never left at the requested amount.
  assert.ok(result.riskAmountUsd <= 1.7 + 1e-9);
});

test('EXPOSURE: a symbol cap that leaves less than the minimum notional is refused', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState(),
    // 1% of 340 = 3.4 USD, below the 5 USD minimum position.
    riskConfig: riskLimits({ maxSymbolExposurePct: 1 }),
  });

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.POSITION_NOTIONAL_TOO_SMALL);
});

test('EXPOSURE: the per-symbol cap is independent of the leverage cap', () => {
  // A high leverage cap must not be able to out-vote a stricter symbol cap.
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState(),
    riskConfig: riskLimits({ maxLeverage: 20, maxSymbolExposurePct: 50, maxTotalExposurePct: 50 }),
  });

  assert.equal(result.approved, true, `${result.reasonCode}: ${result.message}`);
  assert.ok(result.positionNotionalUsd <= 340 * 0.5 + 1e-9);
});

// ---------------------------------------------------------------------------
// Exposure — total account cap
// ---------------------------------------------------------------------------
test('EXPOSURE: total exposure at the cap refuses a new position outright', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({
      openPositions: [{ symbol: 'ETHUSDT', side: 'LONG', quantity: 1, entryPrice: 340 }],
    }),
    riskConfig: riskLimits({ maxSymbolExposurePct: 100, maxTotalExposurePct: 100 }),
  });

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.TOTAL_EXPOSURE_LIMIT);
});

test('EXPOSURE: existing exposure consumes headroom and shrinks the new position', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({
      // 200 USD already open; the 340 USD total cap leaves 140 USD of headroom.
      openPositions: [{ symbol: 'ETHUSDT', side: 'LONG', quantity: 2, entryPrice: 100 }],
    }),
    riskConfig: riskLimits({ maxSymbolExposurePct: 100, maxTotalExposurePct: 100 }),
  });

  assert.equal(result.approved, true, `${result.reasonCode}: ${result.message}`);
  assert.ok(Math.abs(result.positionNotionalUsd - 140) < 1e-9, `notional ${result.positionNotionalUsd}`);
  assert.ok(result.positionNotionalUsd < RAW_NOTIONAL);
});

test('EXPOSURE: a position without an explicit notional falls back to quantity * entryPrice', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({
      // quantity * entry = 300 USD of the 340 USD total cap; 40 USD remains.
      openPositions: [{ symbol: 'ETHUSDT', side: 'LONG', quantity: 0.003, entryPrice: 100000 }],
    }),
    riskConfig: riskLimits({ maxSymbolExposurePct: 100, maxTotalExposurePct: 100 }),
  });

  assert.equal(result.approved, true, `${result.reasonCode}: ${result.message}`);
  assert.ok(Math.abs(result.positionNotionalUsd - 40) < 1e-9, `notional ${result.positionNotionalUsd}`);
});

test('EXPOSURE: a position with no notional fields contributes nothing', () => {
  // A malformed-in-this-dimension position must not produce NaN and poison the
  // whole exposure sum into a rejection (or an approval).
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({
      openPositions: [{ symbol: 'ETHUSDT', side: 'LONG', quantity: 1 }],
    }),
  });

  assert.equal(result.approved, true, `${result.reasonCode}: ${result.message}`);
  assert.ok(Number.isFinite(result.positionNotionalUsd));
});

// ---------------------------------------------------------------------------
// Maximum drawdown
// ---------------------------------------------------------------------------
test('DRAWDOWN: a breach at the limit refuses new trades', () => {
  // peak 340, equity 306 => exactly 10% drawdown.
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ equityUsd: 306, availableBalanceUsd: 306, peakEquityUsd: 340 }),
    riskConfig: riskLimits({ maxDrawdownPct: 10 }),
  });

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.MAX_DRAWDOWN);
});

test('DRAWDOWN: just inside the limit still trades', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ equityUsd: 307, availableBalanceUsd: 307, peakEquityUsd: 340 }),
    riskConfig: riskLimits({ maxDrawdownPct: 10 }),
  });

  assert.equal(result.approved, true, `${result.reasonCode}: ${result.message}`);
});

test('DRAWDOWN: a profit above the previous peak resets the measure to zero', () => {
  // A stale peak below current equity must be clamped up, not fabricate a
  // negative drawdown.
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ equityUsd: 400, availableBalanceUsd: 400, peakEquityUsd: 340 }),
  });

  assert.equal(result.approved, true, `${result.reasonCode}: ${result.message}`);
});

test('DRAWDOWN: a missing peak defaults to current equity (no unknown drawdown)', () => {
  const account = accountState();
  delete /** @type {any} */ (account).peakEquityUsd;

  const result = evaluateTrade({ proposal: longProposal(), account });
  assert.equal(result.approved, true, `${result.reasonCode}: ${result.message}`);
});

test('DRAWDOWN: a malformed peak fails closed as an invalid account', () => {
  for (const peakEquityUsd of [0, -1, Number.NaN, Infinity]) {
    const result = evaluateTrade({
      proposal: longProposal(),
      account: accountState({ peakEquityUsd }),
    });
    assert.equal(result.approved, false, `peak ${peakEquityUsd} must not be approved`);
    assert.equal(result.reasonCode, REASON_CODE.INVALID_ACCOUNT_STATE);
  }
});

test('DRAWDOWN: the daily loss limit is the tighter, first gate', () => {
  // Both limits would fire; the daily stop is evaluated first, so it wins.
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState({ equityUsd: 340, peakEquityUsd: 500, dailyRealizedPnlUsd: -6.8 }),
  });
  assert.equal(result.reasonCode, REASON_CODE.DAILY_LOSS_LIMIT);
});

// ---------------------------------------------------------------------------
// Runtime kill switch at the engine boundary
// ---------------------------------------------------------------------------
test('KILL SWITCH: an explicit engaged flag refuses the proposal', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState(),
    killSwitchEngaged: true,
  });
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.KILL_SWITCH_ENGAGED);
});

test('KILL SWITCH: an explicit released flag leaves the gate open', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState(),
    killSwitchEngaged: false,
  });
  assert.equal(result.approved, true, `${result.reasonCode}: ${result.message}`);
});

test('KILL SWITCH: an omitted flag leaves the gate open', () => {
  const result = evaluateTrade({ proposal: longProposal(), account: accountState() });
  assert.equal(result.approved, true, `${result.reasonCode}: ${result.message}`);
});

test('KILL SWITCH: a malformed flag fails closed', () => {
  for (const killSwitchEngaged of ['yes', 1, {}, null, Number.NaN]) {
    const result = evaluateTrade({
      proposal: longProposal(),
      account: accountState(),
      killSwitchEngaged: /** @type {any} */ (killSwitchEngaged),
    });
    assert.equal(result.approved, false, `flag ${JSON.stringify(killSwitchEngaged)} must refuse`);
    assert.equal(result.reasonCode, REASON_CODE.KILL_SWITCH_ENGAGED);
  }
});

test('KILL SWITCH: the static config flag is not released by the runtime flag', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState(),
    riskConfig: riskLimits({ killSwitchEnabled: true }),
    killSwitchEngaged: false,
  });
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.KILL_SWITCH_ENGAGED);
});

test('KILL SWITCH: isRuntimeKillSwitchEngaged is fail-closed', () => {
  assert.equal(isRuntimeKillSwitchEngaged(undefined), false);
  assert.equal(isRuntimeKillSwitchEngaged(false), false);
  assert.equal(isRuntimeKillSwitchEngaged(true), true);
  assert.equal(isRuntimeKillSwitchEngaged('yes'), true);
  assert.equal(isRuntimeKillSwitchEngaged(null), true);
});

// ---------------------------------------------------------------------------
// createRiskEngine — bound kill switch, decision sink, validation
// ---------------------------------------------------------------------------
test('ENGINE: a bound kill switch gates evaluation and releases deterministically', () => {
  const killSwitch = createKillSwitch({ engaged: true, reason: 'TEST' });
  const engine = createRiskEngine({ killSwitch });

  const blocked = engine.evaluate({ proposal: longProposal(), account: accountState() });
  assert.equal(blocked.reasonCode, REASON_CODE.KILL_SWITCH_ENGAGED);

  killSwitch.disengage();
  const released = engine.evaluate({ proposal: longProposal(), account: accountState() });
  assert.equal(released.approved, true, `${released.reasonCode}: ${released.message}`);
});

test('ENGINE: an invalid injected kill switch is refused at construction', () => {
  assert.throws(() => createRiskEngine({ killSwitch: /** @type {any} */ ({}) }), ConfigError);
});

test('ENGINE: every decision reaches the decision sink, approvals and rejections alike', () => {
  const seen = [];
  const engine = createRiskEngine({ onDecision: (result) => seen.push(result) });

  engine.evaluate({ proposal: longProposal(), account: accountState() });
  engine.evaluate({ proposal: longProposal({ stopLossPrice: 87000 }), account: accountState() });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].approved, true);
  assert.equal(seen[1].approved, false);
  assert.equal(seen[1].reasonCode, REASON_CODE.STOP_LOSS_ON_WRONG_SIDE);
});

test('ENGINE: a throwing decision sink cannot suppress or crash a decision', () => {
  const engine = createRiskEngine({
    onDecision() {
      throw new Error('sink exploded');
    },
  });

  const result = engine.evaluate({ proposal: longProposal(), account: accountState() });
  assert.equal(result.approved, true, `${result.reasonCode}: ${result.message}`);
});

test('ENGINE: the bound config is frozen and cannot be widened by an evaluation', () => {
  const engine = createRiskEngine({ riskConfig: riskLimits() });
  assert.ok(Object.isFrozen(engine.riskConfig));

  const before = engine.riskConfig.riskPerTradePct;
  engine.evaluate({ proposal: longProposal(), account: accountState() });
  assert.equal(engine.riskConfig.riskPerTradePct, before);
});

// ---------------------------------------------------------------------------
// Config coherence
// ---------------------------------------------------------------------------
test('CONFIG: a symbol exposure cap above the total cap is incoherent', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState(),
    riskConfig: riskLimits({ maxSymbolExposurePct: 300, maxTotalExposurePct: 200 }),
  });
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.INVALID_RISK_CONFIG);
});

test('CONFIG: a drawdown at or below the daily loss is incoherent', () => {
  for (const maxDrawdownPct of [2, 1, 0, -1]) {
    const result = evaluateTrade({
      proposal: longProposal(),
      account: accountState(),
      riskConfig: riskLimits({ maxDrawdownPct }),
    });
    assert.equal(result.approved, false, `drawdown ${maxDrawdownPct} must not be approved`);
    assert.equal(result.reasonCode, REASON_CODE.INVALID_RISK_CONFIG);
  }
});

test('CONFIG: the new limits are present and finite in the default profile', () => {
  for (const field of ['maxDrawdownPct', 'maxSymbolExposurePct', 'maxTotalExposurePct']) {
    assert.ok(Number.isFinite(DEFAULT_RISK_LIMITS[field]), `${field} must be a finite default`);
    assert.ok(DEFAULT_RISK_LIMITS[field] > 0, `${field} must be positive`);
  }
});

// ---------------------------------------------------------------------------
// Determinism and input purity
// ---------------------------------------------------------------------------
test('PURITY: exposure and drawdown decisions are deterministic', () => {
  const input = {
    proposal: longProposal(),
    account: accountState({
      equityUsd: 300,
      availableBalanceUsd: 300,
      peakEquityUsd: 340,
      openPositions: [{ symbol: 'ETHUSDT', side: 'LONG', quantity: 1, entryPrice: 50 }],
    }),
    riskConfig: riskLimits({ maxSymbolExposurePct: 100, maxTotalExposurePct: 100 }),
  };

  const first = evaluateTrade(input);
  const second = evaluateTrade(input);
  assert.deepEqual({ ...first, evaluatedAt: null }, { ...second, evaluatedAt: null });
});

test('PURITY: exposure and drawdown evaluation does not mutate its inputs', () => {
  const proposal = longProposal();
  const account = accountState({
    equityUsd: 300,
    availableBalanceUsd: 300,
    peakEquityUsd: 340,
    openPositions: [{ symbol: 'ETHUSDT', side: 'LONG', quantity: 1, entryPrice: 50 }],
  });
  const proposalSnapshot = JSON.stringify(proposal);
  const accountSnapshot = JSON.stringify(account);

  evaluateTrade({ proposal, account, riskConfig: riskLimits({ maxSymbolExposurePct: 100, maxTotalExposurePct: 100 }) });

  assert.equal(JSON.stringify(proposal), proposalSnapshot);
  assert.equal(JSON.stringify(account), accountSnapshot);
});
