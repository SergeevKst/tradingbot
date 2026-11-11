/**
 * PaperDecisionSink — the AI → PAPER bridge (B3/B5).
 *
 * Two kinds of test live here:
 *   - unit tests against a recording stub session, which pin the refusal rules
 *     (staleness, duplicates, budget, neutral bias, unusable outcome);
 *   - one end-to-end test against the real PAPER session, which proves the bridge
 *     lands in the deterministic Risk Engine and produces a virtual fill — with
 *     no exchange module anywhere in the path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

import { createPaperDecisionSink, SINK_REASON, buildProposalFromAnalysis, computeStopDistance } from '../src/ai/paper-decision-sink.mjs';
import { createMarketSnapshot } from '../src/market/market-snapshot.mjs';
import { createTradingSession } from '../src/session/trading-session.mjs';
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { BTC_INSTRUMENT, feeModel, makeSession, marketAt, quietLogger } from './paper-fixtures.mjs';

const NOW = 1_700_000_000_000;

/** A market snapshot with a fresh timestamp and an ATR. */
function market(overrides = {}) {
  return createMarketSnapshot({
    symbol: 'BTCUSDT',
    timestamp: new Date(NOW - 1000).toISOString(),
    lastPrice: 86000,
    markPrice: 86000,
    bid: 85999.9,
    ask: 86000.1,
    instrument: BTC_INSTRUMENT,
    indicators: { atr: 320 },
    ...overrides,
  });
}

/** A validated-outcome shape, as the provider produces it. */
function outcome(overrides = {}) {
  return {
    ok: true,
    status: 'OK',
    issues: [],
    promptVersion: 'market-analysis-v1',
    receivedAt: NOW,
    analysis: {
      schemaVersion: '1',
      symbol: 'BTCUSDT',
      bias: 'BULLISH',
      confidence: 0.8,
      rationale: 'trend',
      evidence: ['sma'],
      modelId: 'gpt-6.1-sol',
      generatedAt: NOW,
      ...overrides,
    },
  };
}

/** A recording PAPER session double. */
function sessionDouble(result = { approved: true, executed: true, reasonCode: 'APPROVED' }) {
  const submissions = [];
  return {
    submissions,
    session: {
      async submit(input) {
        submissions.push(input);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

test('SINK: disabled by default — no decision reaches the session', async () => {
  const { session, submissions } = sessionDouble();
  const sink = createPaperDecisionSink({ paperSession: session, clock: () => NOW });
  const result = await sink.applyAnalysis({ outcome: outcome(), market: market() });
  assert.equal(result.submitted, false);
  assert.equal(result.reasonCode, SINK_REASON.DISABLED);
  assert.equal(submissions.length, 0);
  assert.equal(sink.enabled(), false);
});

test('SINK: a BULLISH analysis becomes a LONG proposal with deterministic geometry', async () => {
  const { session, submissions } = sessionDouble();
  const sink = createPaperDecisionSink({ paperSession: session, enabled: true, clock: () => NOW });

  const result = await sink.applyAnalysis({ outcome: outcome(), market: market() });
  assert.equal(result.submitted, true);
  assert.equal(result.reasonCode, 'APPROVED');
  assert.equal(submissions.length, 1);

  const { proposal } = submissions[0];
  assert.equal(proposal.side, 'LONG');
  assert.equal(proposal.entryPrice, 86000);
  assert.ok(proposal.stopLossPrice < proposal.entryPrice, 'a LONG stop sits below the entry');
  assert.ok(proposal.takeProfitPrice > proposal.entryPrice, 'a LONG target sits above the entry');
  assert.equal(proposal.strategyId, 'ai-codex-analysis');
  // The model may not size: no quantity/leverage may appear on the proposal.
  assert.deepEqual(Object.keys(proposal).sort(), [
    'confidence',
    'entryPrice',
    'side',
    'stopLossPrice',
    'strategyId',
    'symbol',
    'takeProfitPrice',
    'timestamp',
  ]);
});

test('SINK: a BEARISH analysis mirrors the geometry', () => {
  const proposal = buildProposalFromAnalysis({
    analysis: { bias: 'BEARISH', confidence: 0.7, generatedAt: NOW },
    market: { symbol: 'BTCUSDT' },
    price: 86000,
    stopDistance: 430,
    riskReward: 2,
    strategyId: 'ai-codex-analysis',
  });
  assert.equal(proposal.side, 'SHORT');
  assert.equal(proposal.stopLossPrice, 86430);
  assert.equal(proposal.takeProfitPrice, 85140);
});

test('SINK: stop distance comes from ATR and is clamped', () => {
  const policy = { minStopDistanceFraction: 0.002, maxStopDistanceFraction: 0.02, fallbackStopDistanceFraction: 0.005, atrMultiple: 1.5 };
  const withAtr = computeStopDistance({ lastPrice: 86000, indicators: { atr: 320 } }, policy);
  assert.equal(withAtr, 480, '1.5 x ATR');
  const tinyAtr = computeStopDistance({ lastPrice: 86000, indicators: { atr: 1 } }, policy);
  assert.equal(tinyAtr, 86000 * 0.002, 'clamped up to the minimum fraction');
  const hugeAtr = computeStopDistance({ lastPrice: 86000, indicators: { atr: 50000 } }, policy);
  assert.equal(hugeAtr, 86000 * 0.02, 'clamped down to the maximum fraction');
  assert.equal(computeStopDistance({ indicators: {} }, policy), null);
});

test('SINK: neutral bias, low confidence and unusable outcomes never trade', async () => {
  const { session, submissions } = sessionDouble();
  const sink = createPaperDecisionSink({ paperSession: session, enabled: true, clock: () => NOW });

  assert.equal(
    (await sink.applyAnalysis({ outcome: outcome({ bias: 'NEUTRAL' }), market: market() })).reasonCode,
    SINK_REASON.AI_NEUTRAL,
  );
  assert.equal(
    (await sink.applyAnalysis({ outcome: outcome({ confidence: 0.1 }), market: market() })).reasonCode,
    SINK_REASON.AI_CONFIDENCE_BELOW_FLOOR,
  );
  assert.equal(
    (await sink.applyAnalysis({ outcome: { ok: false, issues: ['PROVIDER_ERROR'], analysis: null }, market: market() })).reasonCode,
    SINK_REASON.AI_OUTCOME_UNAVAILABLE,
  );
  assert.equal(submissions.length, 0);
});

test('SINK: stale market data is refused (B5)', async () => {
  const { session, submissions } = sessionDouble();
  const sink = createPaperDecisionSink({ paperSession: session, enabled: true, stalenessMs: 60000, clock: () => NOW });
  const stale = market({ timestamp: new Date(NOW - 120000).toISOString() });
  const result = await sink.applyAnalysis({ outcome: outcome(), market: stale });
  assert.equal(result.submitted, false);
  assert.equal(result.reasonCode, SINK_REASON.STALE_MARKET);
  assert.equal(submissions.length, 0);
});

test('SINK: the same decision is not submitted twice', async () => {
  const { session, submissions } = sessionDouble();
  const sink = createPaperDecisionSink({
    paperSession: session,
    enabled: true,
    dedupeWindowMs: 300000,
    clock: () => NOW,
  });
  const first = await sink.applyAnalysis({ outcome: outcome(), market: market() });
  const second = await sink.applyAnalysis({ outcome: outcome(), market: market() });
  assert.equal(first.submitted, true);
  assert.equal(second.submitted, false);
  assert.equal(second.reasonCode, SINK_REASON.DUPLICATE_DECISION);
  assert.equal(submissions.length, 1);
});

test('SINK: an analysis for another instrument is refused', async () => {
  const { session, submissions } = sessionDouble();
  const sink = createPaperDecisionSink({ paperSession: session, enabled: true, clock: () => NOW });
  const result = await sink.applyAnalysis({ outcome: outcome({ symbol: 'ETHUSDT' }), market: market() });
  assert.equal(result.submitted, false);
  assert.equal(submissions.length, 0);
});

test('SINK: the hourly decision budget bounds a run away loop', async () => {
  const { session, submissions } = sessionDouble();
  const sink = createPaperDecisionSink({
    paperSession: session,
    enabled: true,
    maxDecisionsPerHour: 2,
    dedupeWindowMs: 1000,
    clock: () => NOW,
  });
  assert.equal((await sink.applyAnalysis({ outcome: outcome(), market: market() })).submitted, true);

  const later = outcome({ generatedAt: NOW + 60000, bias: 'BEARISH' });
  assert.equal((await sink.applyAnalysis({ outcome: later, market: market() })).submitted, true);

  const third = outcome({ generatedAt: NOW + 120000, bias: 'BULLISH', confidence: 0.9 });
  const refused = await sink.applyAnalysis({ outcome: third, market: market() });
  assert.equal(refused.submitted, false);
  assert.equal(refused.reasonCode, SINK_REASON.BUDGET_EXHAUSTED);
  assert.equal(submissions.length, 2);
});

test('SINK: a throwing session fails closed without losing the audit trail', async () => {
  const { session } = sessionDouble(new Error('ledger unavailable'));
  const events = [];
  const sink = createPaperDecisionSink({
    paperSession: session,
    enabled: true,
    clock: () => NOW,
    audit: (event) => events.push(event),
  });
  const result = await sink.applyAnalysis({ outcome: outcome(), market: market() });
  assert.equal(result.submitted, false);
  assert.equal(result.reasonCode, 'INTERNAL_ERROR');
  assert.ok(events.some((event) => event.event === 'AI_PAPER_SUBMIT_FAILED'));
});

test('SINK: a session without submit() is a wiring error', () => {
  assert.throws(() => createPaperDecisionSink({ paperSession: {} }), ConfigError);
  assert.throws(() => createPaperDecisionSink({}), ConfigError);
  assert.throws(() => createPaperDecisionSink({ paperSession: { submit() {} }, stalenessMs: -1 }), ConfigError);
});

// ─── End-to-end through the real PAPER session ───────────────────────────────

test('SINK → PAPER: an AI decision reaches the Risk Engine and fills virtually', async () => {
  const { session, cleanup } = await makeSession();
  try {
    const sink = createPaperDecisionSink({
      paperSession: session,
      enabled: true,
      clock: () => NOW + 1000,
      logger: quietLogger,
    });
    const snapshot = await marketAt(86000).getSnapshot('BTCUSDT');

    const result = await sink.applyAnalysis({
      outcome: outcome(),
      market: createMarketSnapshot({
        ...snapshot,
        timestamp: new Date(Date.now()).toISOString(),
        indicators: { atr: 320 },
      }),
    });

    assert.equal(result.submitted, true);
    assert.equal(result.riskOutcome.approved, true, result.riskOutcome.reasonCode);
    assert.equal(result.riskOutcome.executed, true, result.riskOutcome.reasonCode);
    assert.equal(result.riskOutcome.riskResult.estimatedQuantity > 0, true);

    const account = await session.getAccountState();
    assert.equal(account.positions.length, 1);
    assert.equal(account.positions[0].symbol, 'BTCUSDT');
  } finally {
    await cleanup();
  }
});

test('SINK → PAPER: the deterministic Risk Engine can still reject a model decision', async () => {
  // The configured kill switch is a deterministic gate: the AI may be confident,
  // the Risk Engine still refuses and nothing is filled.
  const session = await createTradingSession({
    mode: 'PAPER',
    paper: {
      riskConfig: { ...DEFAULT_RISK_LIMITS, killSwitchEnabled: true },
      feeModel: feeModel(),
      paths: {
        stateFile: '/tmp/sink-risk-state.json',
        journalFile: '/tmp/sink-risk-journal.jsonl',
        initialEquityUsd: 340,
      },
      logger: quietLogger,
    },
  });
  try {
    const sink = createPaperDecisionSink({ paperSession: session, enabled: true, clock: () => NOW + 1000 });
    const snapshot = await marketAt(86000).getSnapshot('BTCUSDT');
    const result = await sink.applyAnalysis({
      outcome: outcome({ confidence: 0.99 }),
      market: createMarketSnapshot({ ...snapshot, timestamp: new Date().toISOString() }),
    });

    assert.equal(result.submitted, true, 'the sink is not the gate; it forwards the proposal');
    assert.equal(result.riskOutcome.approved, false);
    assert.equal(result.riskOutcome.executed, false);
    assert.equal(result.riskOutcome.reasonCode, 'KILL_SWITCH_ENGAGED');
    const account = await session.getAccountState();
    assert.equal(account.positions.length, 0);
  } finally {
    await rm('/tmp/sink-risk-state.json', { force: true });
    await rm('/tmp/sink-risk-journal.jsonl', { force: true });
  }
});
