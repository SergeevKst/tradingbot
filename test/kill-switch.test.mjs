/**
 * Kill-switch tests (MASTER_SPEC §44).
 *
 * Cover both layers: the static, validated config flag and the operational
 * runtime control the session exposes. Everything is offline and deterministic
 * (the clock is injected).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { assertKillSwitch, createKillSwitch, isKillSwitchEngaged } from '../src/risk/kill-switch.mjs';
import { DEFAULT_RISK_LIMITS, loadRiskLimits, validateRiskLimits } from '../src/config/risk.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { evaluateTrade } from '../src/risk/risk-engine.mjs';
import { REASON_CODE } from '../src/domain/reason-code.mjs';
import { accountState, longProposal, riskLimits } from './fixtures.mjs';

test('kill-switch: config check fails closed on a missing flag', () => {
  // Only an explicit `false` releases the stop.
  assert.equal(isKillSwitchEngaged(undefined), true);
  assert.equal(isKillSwitchEngaged(null), true);
  assert.equal(isKillSwitchEngaged({}), true);
  assert.equal(isKillSwitchEngaged({ killSwitchEnabled: undefined }), true);
  assert.equal(isKillSwitchEngaged({ killSwitchEnabled: true }), true);
  assert.equal(isKillSwitchEngaged({ killSwitchEnabled: false }), false);
});

test('kill-switch: the runtime control is disengaged by default', () => {
  const fixed = () => '2026-10-01T00:00:00.000Z';
  const killSwitch = createKillSwitch({ now: fixed });

  assert.equal(killSwitch.isEngaged(), false);
  assert.deepEqual(killSwitch.snapshot(), { engaged: false, reason: null, engagedAt: null });
  assert.ok(Object.isFrozen(killSwitch.snapshot()));
});

test('kill-switch: engage always engages, even without a reason', () => {
  const times = ['2026-10-01T00:00:00.000Z', '2026-10-01T00:05:00.000Z'];
  const killSwitch = createKillSwitch({ now: () => times.shift() });

  const first = killSwitch.engage('MANUAL');
  assert.deepEqual(first, { engaged: true, reason: 'MANUAL', engagedAt: '2026-10-01T00:00:00.000Z' });

  // A reason-less engage must still stop trading; it records UNSPECIFIED.
  const second = killSwitch.engage();
  assert.equal(second.engaged, true);
  assert.equal(second.reason, 'UNSPECIFIED');
  assert.equal(second.engagedAt, '2026-10-01T00:05:00.000Z');
});

test('kill-switch: an injected control must satisfy the contract', () => {
  assert.doesNotThrow(() => assertKillSwitch(createKillSwitch()));
  for (const bad of [null, {}, { isEngaged: () => false }, { isEngaged() {}, engage() {}, disengage() {} }]) {
    assert.throws(() => assertKillSwitch(bad), ConfigError);
  }
});

test('kill-switch: a control can be constructed already engaged and released', () => {
  const killSwitch = createKillSwitch({ engaged: true, reason: 'RESTORED' });
  assert.equal(killSwitch.isEngaged(), true);

  const released = killSwitch.disengage();
  assert.deepEqual(released, { engaged: false, reason: null, engagedAt: null });
  assert.equal(killSwitch.isEngaged(), false);
});

test('kill-switch: the config flag must be a boolean', () => {
  assert.throws(() => validateRiskLimits({ ...DEFAULT_RISK_LIMITS, killSwitchEnabled: 'yes' }), ConfigError);
  assert.throws(() => validateRiskLimits({ ...DEFAULT_RISK_LIMITS, killSwitchEnabled: 1 }), ConfigError);
  assert.doesNotThrow(() => validateRiskLimits({ ...DEFAULT_RISK_LIMITS }));
});

test('kill-switch: loadRiskLimits emits a validated, disengaged flag', () => {
  const limits = loadRiskLimits({ TRADING_MODE: 'PAPER' });
  assert.equal(limits.killSwitchEnabled, false);
  assert.ok(Object.isFrozen(limits));
});

test('kill-switch: the Risk Engine refuses any proposal while engaged', () => {
  const result = evaluateTrade({
    proposal: longProposal(),
    account: accountState(),
    riskConfig: riskLimits({ killSwitchEnabled: true }),
  });

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.KILL_SWITCH_ENGAGED);
});

test('kill-switch: the decision is deterministic for the same input', () => {
  const input = { proposal: longProposal(), account: accountState(), riskConfig: riskLimits({ killSwitchEnabled: true }) };
  const first = evaluateTrade(input);
  const second = evaluateTrade(input);
  assert.equal(first.approved, second.approved);
  assert.equal(first.reasonCode, second.reasonCode);
});
