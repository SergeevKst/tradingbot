/**
 * UAI-06B — trading parity: the AI binding must not change thresholds, ranking,
 * parsing or order arguments. These are golden-value tests over the untouched
 * deterministic modules, plus a side-by-side comparison of the legacy chat
 * facade and the guarded facade for identical model output.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  PRECHECK_STOP_RANGE_MULT,
  PRECHECK_MIN_REWARD_RISK,
  PRECHECK_CHASE_PCT,
  parseGuardResponse,
  precheckIdea,
  shouldSkipAutoEntry,
  RISK_FILTER_PROMPT_VERSION,
} from '../src/telegram/risk-filter.mjs';
import {
  MAX_IDEAS,
  ENTRY_MAX_DEVIATION_PCT,
  STOP_MIN_RANGE_MULT,
  MIN_REWARD_RISK,
  parseScoutResponse,
  IDEAS_PROMPT_VERSION,
} from '../src/telegram/ideas.mjs';
import { parseMonitorResponse, MONITOR_PROMPT_VERSION } from '../src/telegram/monitor.mjs';
import {
  parseStopcheckResponse,
  decideStopcheckAction,
  isTrendAgainst,
  STOPCHECK_PROMPT_VERSION,
} from '../src/telegram/stopcheck.mjs';
import { harvestDecision, computeTrailingStop } from '../src/telegram/trailing.mjs';
import { createDeepSeekChat } from '../src/telegram/deepseek-client.mjs';
import { createTelegramAIComposition } from '../src/telegram/ai-composition.mjs';
import { activateFixture, buildReleaseFixture, guardConfigFor } from './fixtures/ai-release/factory.mjs';

test('PARITY: deterministic risk and ranking thresholds are unchanged', () => {
  assert.equal(PRECHECK_STOP_RANGE_MULT, 1.5);
  assert.equal(PRECHECK_MIN_REWARD_RISK, 1.5);
  assert.equal(PRECHECK_CHASE_PCT, 8);
  assert.equal(MAX_IDEAS, 15);
  assert.equal(ENTRY_MAX_DEVIATION_PCT, 1.5);
  assert.equal(STOP_MIN_RANGE_MULT, 1.5);
  assert.equal(MIN_REWARD_RISK, 1.5);
  assert.equal(RISK_FILTER_PROMPT_VERSION, 'risk-guard-v2');
  assert.equal(IDEAS_PROMPT_VERSION, 'scout-ideas-v4');
  assert.equal(MONITOR_PROMPT_VERSION, 'monitor-v2');
  assert.equal(STOPCHECK_PROMPT_VERSION, 'stopcheck-v2');
});

test('PARITY: the deterministic precheck still rejects the same shapes', () => {
  const context = {
    symbols: [{ symbol: 'BTCUSDT', markPrice: 100, high24h: 105, low24h: 95, avgRange14h: 2 }],
  };
  const base = { symbol: 'BTCUSDT', side: 'LONG', entry: 100, stopLoss: 95, takeProfit: 110, confidence: 0.8 };
  assert.equal(precheckIdea(base, context).pass, true);
  // Reward/risk 1.0 < 1.5 is rejected by the unchanged threshold.
  assert.equal(precheckIdea({ ...base, takeProfit: 105 }, context).pass, false);
  // A stop tighter than 1.5x the volatility unit is rejected too.
  assert.equal(precheckIdea({ ...base, stopLoss: 99 }, context).pass, false);
  // No market data is a fail-closed rejection.
  assert.equal(precheckIdea(base, { symbols: [] }).pass, false);
});

test('PARITY: the AI parsers produce identical values for the same raw output', () => {
  const guard = parseGuardResponse(JSON.stringify({ verdict: 'REJECTED', confidence: 0.2, reasons: ['weak setup'] }));
  assert.equal(guard.ok, true);
  assert.equal(guard.value.verdict, 'REJECTED');
  assert.equal(parseGuardResponse('not json').ok, false);

  const scout = parseScoutResponse(JSON.stringify({
    ideas: [{ symbol: 'BTCUSDT', side: 'LONG', entry: 100, stopLoss: 95, takeProfit: 110, confidence: 0.7 }],
  }));
  assert.equal(scout.ok, true);

  const monitor = parseMonitorResponse(JSON.stringify({ action: 'HOLD', reason: 'trend intact', confidence: 0.6 }));
  assert.equal(monitor.ok, true);
  assert.equal(monitor.value.action, 'HOLD');

  const stopcheck = parseStopcheckResponse(JSON.stringify({ action: 'HOLD', reason: 'noise', confidence: 0.4 }));
  assert.equal(stopcheck.ok, true);
  assert.equal(decideStopcheckAction({ llmAction: 'HOLD', lossMeaningful: true, trendAgainst: true }), 'HOLD');
  assert.equal(decideStopcheckAction({ llmAction: 'CLOSE', lossMeaningful: true, trendAgainst: true }), 'AUTO_CLOSE');
  assert.equal(isTrendAgainst('LONG', 'down'), true);
  assert.equal(isTrendAgainst('LONG', 'up'), false);
});

test('PARITY: deterministic protection primitives are untouched', () => {
  const trailing = computeTrailingStop({
    side: 'LONG',
    entryPrice: 100,
    currentStop: 95,
    markPrice: 110,
    trailDistance: 2,
    activationPct: 0,
  });
  assert.equal(trailing.moved, true);
  assert.equal(trailing.stop, 108);
  // A candidate that is not better than the current stop never moves it.
  assert.equal(computeTrailingStop({ side: 'LONG', entryPrice: 100, currentStop: 109, markPrice: 110, trailDistance: 2 }).moved, false);

  assert.equal(harvestDecision({ pnlUsd: 1.0, peakPnlUsd: 1.0 }).close, false);
  assert.equal(harvestDecision({ pnlUsd: 1.2, peakPnlUsd: 3 }).close, true);
  assert.equal(shouldSkipAutoEntry({ idea: { entry: 100, stopLoss: 95, takeProfit: 110, side: 'LONG' }, live: 100.1, slippagePct: 0.15, refreshPct: 1 }).skip, false);
  assert.equal(shouldSkipAutoEntry({ idea: { entry: 100, stopLoss: 95, takeProfit: 110, side: 'LONG' }, live: 110, slippagePct: 0.15, refreshPct: 1 }).skip, true);
});

test('PARITY: legacy and guarded facades parse identical model output identically', async () => {
  const raw = JSON.stringify({
    ideas: [{ symbol: 'BTCUSDT', side: 'LONG', entry: 100, stopLoss: 95, takeProfit: 110, confidence: 0.7 }],
  });
  const globalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: raw } }], usage: {} }),
  });
  try {
    const legacy = createDeepSeekChat({
      deepseekApiKey: 'fake-key',
      model: 'deepseek-chat',
      guardModel: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
    });
    const legacyScout = await legacy.generateIdeas({ symbols: [] });

    const fixture = buildReleaseFixture();
    activateFixture(fixture);
    const composition = createTelegramAIComposition({
      config: guardConfigFor(fixture, 'telegram'),
      controlStore: fixture.store,
      artifactIdentity: { artifactSha256: fixture.artifactMap.telegram },
      transportDependencies: { apiKeyLoader: () => 'fake-key' },
      instanceId: 'inst-tg-1',
    });
    composition.start();
    const guardedScout = await composition.getChatClient().generateIdeas({ symbols: [] });

    assert.deepEqual(guardedScout.parsed, legacyScout.parsed, 'parsing, validation and ordering are unchanged');
    assert.equal(guardedScout.prompt.version, legacyScout.prompt.version);
  } finally {
    globalThis.fetch = globalFetch;
  }
});

test('PARITY: the composition imports no risk, execution or trading-state module', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const file = path.resolve(import.meta.dirname, '..', 'src', 'telegram', 'ai-composition.mjs');
  const source = fs.readFileSync(file, 'utf8');
  for (const forbidden of ['../risk/', '../execution/', '../state/', '../reconciliation/', '../session/', './execute.mjs']) {
    assert.ok(!source.includes(forbidden), `ai-composition.mjs must not import ${forbidden}`);
  }
});
