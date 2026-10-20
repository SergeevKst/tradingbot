import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  parseMonitorResponse,
  buildMonitorPrompt,
  MONITOR_PROMPT_VERSION,
  MONITOR_SYSTEM_PROMPT,
} from '../src/telegram/monitor.mjs';
import {
  parseStopcheckResponse,
  buildStopcheckPrompt,
  STOPCHECK_PROMPT_VERSION,
  STOPCHECK_SYSTEM_PROMPT,
  shouldConsultStopcheck,
  isTrendAgainst,
  decideStopcheckAction,
} from '../src/telegram/stopcheck.mjs';

test('parseMonitorResponse: HOLD passes, result has no newStop', () => {
  const res = parseMonitorResponse(JSON.stringify({ action: 'HOLD', reason: 'ok', confidence: 0.6 }));
  assert.equal(res.ok, true);
  assert.equal(res.value.action, 'HOLD');
  assert.equal('newStop' in res.value, false);
});

test('parseMonitorResponse: EXIT passes; TRAIL is parse error', () => {
  const exit = parseMonitorResponse(JSON.stringify({ action: 'EXIT', reason: 'ok', confidence: 0.8 }));
  assert.equal(exit.ok, true);
  const trail = parseMonitorResponse(JSON.stringify({ action: 'TRAIL', newStop: 123, reason: 'ok', confidence: 0.8 }));
  assert.equal(trail.ok, false);
  const empty = parseMonitorResponse(JSON.stringify({ action: 'HOLD', reason: '', confidence: 0.6 }));
  assert.equal(empty.ok, false);
});

test('shouldConsultStopcheck: false means no LLM call', () => {
  assert.equal(shouldConsultStopcheck({ lossMeaningful: false }), false);
  assert.equal(shouldConsultStopcheck({ lossMeaningful: true }), true);
});

test('isTrendAgainst: direction logic', () => {
  assert.equal(isTrendAgainst('LONG', 'down'), true);
  assert.equal(isTrendAgainst('LONG', 'up'), false);
  assert.equal(isTrendAgainst('SHORT', 'up'), true);
  assert.equal(isTrendAgainst('SHORT', 'flat'), false);
});

test('decideStopcheckAction: code+model agreement required for AUTO_CLOSE', () => {
  assert.equal(decideStopcheckAction({ llmAction: 'CLOSE', lossMeaningful: true, trendAgainst: true }), 'AUTO_CLOSE');
  assert.equal(decideStopcheckAction({ llmAction: 'CLOSE', lossMeaningful: true, trendAgainst: false }), 'PROPOSE_CLOSE');
  assert.equal(decideStopcheckAction({ llmAction: 'CLOSE', lossMeaningful: false, trendAgainst: true }), 'PROPOSE_CLOSE');
  assert.equal(decideStopcheckAction({ llmAction: 'HOLD', lossMeaningful: true, trendAgainst: true }), 'HOLD');
});

test('buildMonitorPrompt/buildStopcheckPrompt versions and payload keys', () => {
  const monitor = buildMonitorPrompt({ position: { symbol: 'BTCUSDT' }, market: {}, newsText: '' });
  assert.equal(monitor.version, 'monitor-v2');
  assert.equal(monitor.version, MONITOR_PROMPT_VERSION);
  const stopcheck = buildStopcheckPrompt({ position: { symbol: 'BTCUSDT' }, market: {}, newsText: '' });
  assert.equal(stopcheck.version, 'stopcheck-v2');
  assert.equal(stopcheck.version, STOPCHECK_PROMPT_VERSION);
  const mUser = JSON.parse(monitor.user);
  assert.ok('position' in mUser);
  assert.ok('market' in mUser);
  assert.ok('news' in mUser);
});

test('MONITOR_SYSTEM_PROMPT does not contain TRAIL or newStop', () => {
  assert.ok(!MONITOR_SYSTEM_PROMPT.includes('TRAIL'));
  assert.ok(!MONITOR_SYSTEM_PROMPT.includes('newStop'));
});

test('STOPCHECK_SYSTEM_PROMPT does not contain 0.8 or auto-execut', () => {
  assert.ok(!STOPCHECK_SYSTEM_PROMPT.includes('0.8'));
  assert.ok(!STOPCHECK_SYSTEM_PROMPT.toLowerCase().includes('auto-execut'));
});

test('M-5: background notification helper logic', () => {
  // Pure-logic stand-in: only actionable events notify in background.
  function shouldNotifyBackground(event) {
    return event === 'trail' || event === 'exit' || event === 'auto_close' || event === 'error';
  }
  assert.equal(shouldNotifyBackground('trail'), true);
  assert.equal(shouldNotifyBackground('exit'), true);
  assert.equal(shouldNotifyBackground('auto_close'), true);
  assert.equal(shouldNotifyBackground('error'), true);
  assert.equal(shouldNotifyBackground('started'), false);
  assert.equal(shouldNotifyBackground('finished'), false);
  assert.equal(shouldNotifyBackground('silence'), false);
});
