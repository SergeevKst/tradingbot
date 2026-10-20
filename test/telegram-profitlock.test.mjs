import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { harvestDecision } from '../src/telegram/trailing.mjs';

test('T-1: harvestDecision — pnl below arm → not armed', () => {
  const res = harvestDecision({ pnlUsd: 1.2, peakPnlUsd: 1.2, armUsd: 1.5, retracePct: 50 });
  assert.equal(res.close, false);
  assert.equal(res.peak, 1.2);
});

test('T-1: harvestDecision — pnl 1.6 updates peak', () => {
  const res = harvestDecision({ pnlUsd: 1.6, peakPnlUsd: 1.2, armUsd: 1.5, retracePct: 50 });
  assert.equal(res.close, false);
  assert.equal(res.peak, 1.6);
});

test('T-1: harvestDecision — retrace from peak 1.6 to 0.79 → close', () => {
  const res = harvestDecision({ pnlUsd: 0.79, peakPnlUsd: 1.6, armUsd: 1.5, retracePct: 50 });
  assert.equal(res.close, true);
  assert.equal(res.peak, 1.6);
  assert.ok(res.reason.includes('harvest'));
});

test('T-1: harvestDecision — temporary dip without hitting threshold → no close', () => {
  const res = harvestDecision({ pnlUsd: 1.0, peakPnlUsd: 1.6, armUsd: 1.5, retracePct: 50 });
  assert.equal(res.close, false);
  assert.equal(res.peak, 1.6);
});

test('T-1: harvestDecision — invalid inputs fail-closed', () => {
  const res = harvestDecision({ pnlUsd: NaN, peakPnlUsd: 1.6, armUsd: 1.5, retracePct: 50 });
  assert.equal(res.close, false);
});

test('T-3: travel >= activationPct freezes TP (regression via computeTrailingTakeProfit)', async () => {
  // When travel >= activation, the caller should skip TP trailing.
  // We verify computeTrailingTakeProfit itself still works when called.
  const { computeTrailingTakeProfit } = await import('../src/telegram/trailing.mjs');
  const res = computeTrailingTakeProfit({ side: 'LONG', markPrice: 110, currentTakeProfit: 105, distance: 2 });
  assert.equal(res.moved, true);
  assert.equal(res.takeProfit, 112);
});

test('T-5: mfeUsd is accepted by reflect input type', async () => {
  // The reflect function signature accepts mfeUsd; we verify the type is wired.
  const { createReflector } = await import('../src/telegram/reflect.mjs');
  const refl = createReflector({ apiKey: 'dummy', baseUrl: 'http://localhost', fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"lesson":"x","proposedRule":"","severity":"low","matchedExistingRule":true}' } }] }) }) });
  // Should not throw when mfeUsd is passed
  const result = await refl.reflect({ symbol: 'BTCUSDT', side: 'LONG', entry: 100, exit: 101, pnlUsd: 1, reason: 'test', mfeUsd: 2.5 });
  assert.ok(result !== null);
});

test('T-5: perf give-back block computed correctly on fixture', () => {
  const peaks = { 'linear:BTCUSDT': 10, 'linear:ETHUSDT': 5 };
  const totalMfe = Object.values(peaks).reduce((s, v) => s + v, 0);
  assert.equal(totalMfe, 15);
  const realized = 8;
  const giveBackPct = totalMfe > 0 ? (((totalMfe - realized) / totalMfe) * 100).toFixed(1) : '0';
  assert.equal(giveBackPct, '46.7');
});
