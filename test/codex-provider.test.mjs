/**
 * Codex provider adapter — contract, fail-closed and model-policy tests.
 *
 * The transport is a double here, so nothing is spawned and no subscription
 * quota is used. What is asserted is the adapter's behaviour at the boundary it
 * actually owns: the request it builds, and how it treats every possible answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCodexProvider, CODEX_ANALYSIS_OUTPUT_SCHEMA } from '../src/providers/codex/codex-provider.mjs';
import {
  CODEX_ASTRA_MODEL,
  CODEX_ROUTINE_MODEL,
  CODEX_KNOWN_MODELS,
  loadCodexProviderConfig,
  buildCodexChildEnv,
} from '../src/config/codex.mjs';
import { AI_STATUS } from '../src/ai/interface.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { AI_ANALYSIS_OUTPUT_JSON_SCHEMA } from '../src/ai/analysis-schema.mjs';

const CONTEXT = Object.freeze({
  schemaVersion: '1',
  generatedAt: 1_700_000_000_000,
  market: Object.freeze({
    symbol: 'BTCUSDT',
    timeframe: '15',
    lastPrice: 86000,
    bid: 85999.9,
    ask: 86000.1,
    candles: Object.freeze([]),
    indicators: Object.freeze({ smaFast: 85900, smaSlow: 85750, atr: 320 }),
  }),
  position: null,
  portfolio: null,
  strategy: null,
  risk: null,
});

/**
 * @param {{ ok?: boolean, content?: string, reason?: string }} [answer]
 */
function transportDouble(answer = {}) {
  /** @type {object[]} */
  const requests = [];
  return {
    requests,
    transport: {
      async complete(request) {
        requests.push(request);
        if (answer.ok === false) return { ok: false, reason: answer.reason ?? 'TIMEOUT' };
        return {
          ok: true,
          content: answer.content ?? '{"bias":"BULLISH","confidence":0.72,"rationale":"trend up","evidence":["sma"]}',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    },
  };
}

test('CODEX PROVIDER: a valid answer becomes a validated AIAnalysis', async () => {
  const { transport, requests } = transportDouble();
  const provider = createCodexProvider({ model: CODEX_ROUTINE_MODEL, transport, now: () => 1_700_000_000_500 });

  assert.equal(provider.id, 'codex');
  assert.equal(provider.modelId, CODEX_ROUTINE_MODEL);

  const outcome = await provider.analyze(CONTEXT);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, AI_STATUS.OK);
  assert.equal(outcome.analysis.bias, 'BULLISH');
  assert.equal(outcome.analysis.symbol, 'BTCUSDT');
  assert.equal(outcome.analysis.modelId, CODEX_ROUTINE_MODEL);
  assert.equal(outcome.modelId, CODEX_ROUTINE_MODEL);
  assert.equal(outcome.promptVersion, 'market-analysis-v1');

  // The model may not set the instrument, the model id or the timestamp.
  assert.equal(outcome.analysis.generatedAt, 1_700_000_000_500);

  // The request carries the reviewed schema and the profile's effort.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, CODEX_ROUTINE_MODEL);
  assert.equal(requests[0].schema, CODEX_ANALYSIS_OUTPUT_SCHEMA);
  assert.equal(requests[0].reasoningEffort, null);
  assert.match(requests[0].prompt, /Respond with a single JSON object/);
});

test('CODEX PROVIDER: the transport schema satisfies the strict-required rule', () => {
  // The Codex endpoint rejects a JSON Schema whose `required` omits any
  // property (measured: HTTP 400 invalid_json_schema). The derived schema must
  // therefore list every property, and may not change any accepted value.
  const properties = Object.keys(CODEX_ANALYSIS_OUTPUT_SCHEMA.properties).sort();
  assert.deepEqual([...CODEX_ANALYSIS_OUTPUT_SCHEMA.required].sort(), properties);
  for (const [key, value] of Object.entries(CODEX_ANALYSIS_OUTPUT_SCHEMA.properties)) {
    assert.deepEqual(value, AI_ANALYSIS_OUTPUT_JSON_SCHEMA.properties[key], `${key} definition must be unchanged`);
  }
  assert.equal(CODEX_ANALYSIS_OUTPUT_SCHEMA.properties.evidence.minItems, undefined, 'an empty evidence array must be allowed');
});

test('CODEX PROVIDER: an answer that is not JSON is INVALID_OUTPUT, never a coerced trade', async () => {
  const { transport } = transportDouble({ content: 'I think the market is bullish, buy now.' });
  const provider = createCodexProvider({ model: CODEX_ROUTINE_MODEL, transport });
  const outcome = await provider.analyze(CONTEXT);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, AI_STATUS.INVALID_OUTPUT);
  assert.equal(outcome.analysis, null);
});

test('CODEX PROVIDER: a schema violation is INVALID_OUTPUT', async () => {
  const { transport } = transportDouble({ content: '{"bias":"BULLISH","quantity":2,"rationale":"x"}' });
  const provider = createCodexProvider({ model: CODEX_ROUTINE_MODEL, transport });
  const outcome = await provider.analyze(CONTEXT);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, AI_STATUS.INVALID_OUTPUT);
});

test('CODEX PROVIDER: out-of-range confidence is INVALID_OUTPUT', async () => {
  const { transport } = transportDouble({ content: '{"bias":"BEARISH","confidence":1.4,"rationale":"x"}' });
  const provider = createCodexProvider({ model: CODEX_ROUTINE_MODEL, transport });
  const outcome = await provider.analyze(CONTEXT);
  assert.equal(outcome.status, AI_STATUS.INVALID_OUTPUT);
});

test('CODEX PROVIDER: a transport failure is PROVIDER_ERROR with the transport reason', async () => {
  const { transport } = transportDouble({ ok: false, reason: 'BUDGET_EXHAUSTED' });
  const provider = createCodexProvider({ model: CODEX_ROUTINE_MODEL, transport });
  const outcome = await provider.analyze(CONTEXT);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, AI_STATUS.PROVIDER_ERROR);
  assert.deepEqual(outcome.issues, ['CODEX_BUDGET_EXHAUSTED']);
});

test('CODEX PROVIDER: EXIT_NONZERO maps to PROVIDER_ERROR even with a non-empty answer', async () => {
  // S2-1 end to end: the transport's fail-closed exit verdict must reach the
  // provider boundary as PROVIDER_ERROR, never as a usable analysis.
  const transport = {
    async complete() {
      return { ok: false, reason: 'EXIT_NONZERO', detail: 'codex exec aborted', exitCode: 3 };
    },
  };
  const provider = createCodexProvider({ model: CODEX_ROUTINE_MODEL, transport });
  const outcome = await provider.analyze(CONTEXT);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, AI_STATUS.PROVIDER_ERROR);
  assert.deepEqual(outcome.issues, ['CODEX_EXIT_NONZERO']);
  assert.equal(outcome.analysis, null);
});

test('CODEX PROVIDER: a throwing transport is PROVIDER_ERROR, not an exception', async () => {
  const provider = createCodexProvider({
    model: CODEX_ROUTINE_MODEL,
    transport: { complete: async () => { throw new Error('spawn exploded'); } },
  });
  const outcome = await provider.analyze(CONTEXT);
  assert.equal(outcome.status, AI_STATUS.PROVIDER_ERROR);
  assert.equal(outcome.analysis, null);
});

test('CODEX PROVIDER: Astra is refused unless the operation is explicitly allowed', async () => {
  const { transport } = transportDouble();
  assert.throws(
    () => createCodexProvider({ model: CODEX_ASTRA_MODEL, transport, operation: 'ANALYZE' }),
    (error) => error instanceof ConfigError && /Astra/.test(error.message),
  );
  // Explicitly configured higher-reasoning operation: allowed.
  const provider = createCodexProvider({
    model: CODEX_ASTRA_MODEL,
    operation: 'ANALYZE',
    astraOperations: ['ANALYZE'],
    transport,
  });
  assert.equal(provider.modelId, CODEX_ASTRA_MODEL);
});

test('CODEX PROVIDER: a model outside the reviewed catalog is refused', () => {
  const { transport } = transportDouble();
  assert.throws(
    () => createCodexProvider({ model: 'gpt-9-imaginary', transport }),
    (error) => error instanceof ConfigError && /reviewed catalog/.test(error.message),
  );
});

test('CODEX PROVIDER: an unknown operation is refused', () => {
  const { transport } = transportDouble();
  assert.throws(
    () => createCodexProvider({ model: CODEX_ROUTINE_MODEL, transport, operation: 'DEPLOY' }),
    ConfigError,
  );
});

test('CODEX PROVIDER: a transport without complete() fails at wiring time', () => {
  assert.throws(() => createCodexProvider({ model: CODEX_ROUTINE_MODEL, transport: {} }), ConfigError);
});

test('CODEX CONFIG: disabled by default and Astra never allowed by default', () => {
  const config = loadCodexProviderConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.model, CODEX_ROUTINE_MODEL);
  assert.deepEqual([...config.astraOperations], []);
  assert.equal(config.maxCallsPerHour, 30);
  assert.ok(CODEX_KNOWN_MODELS.includes(config.model));
});

test('CODEX CONFIG: an unknown model or operation is a configuration error', () => {
  assert.throws(() => loadCodexProviderConfig({ AI_CODEX_MODEL: 'gpt-9' }), ConfigError);
  assert.throws(() => loadCodexProviderConfig({ AI_CODEX_ASTRA_OPERATIONS: 'DEPLOY' }), ConfigError);
});

test('CODEX CONFIG: fractional timeout/budget values are rejected at load time', () => {
  // The reviewed contract is a positive integer; a fractional value must fail in
  // the config layer, not later during transport construction.
  for (const [field, raw] of [
    ['AI_CODEX_TIMEOUT_MS', '1500.5'],
    ['AI_CODEX_MAX_CALLS_PER_HOUR', '2.5'],
  ]) {
    assert.throws(
      () => loadCodexProviderConfig({ [field]: raw }),
      (error) => {
        assert.ok(error instanceof ConfigError, `${field} must raise a ConfigError`);
        assert.equal(error.field, field);
        return true;
      },
    );
  }

  // Integer strings still parse, and the non-positive guard remains in force.
  const config = loadCodexProviderConfig({ AI_CODEX_TIMEOUT_MS: '90000', AI_CODEX_MAX_CALLS_PER_HOUR: '12' });
  assert.equal(config.timeoutMs, 90000);
  assert.equal(config.maxCallsPerHour, 12);
  assert.throws(() => loadCodexProviderConfig({ AI_CODEX_TIMEOUT_MS: '0' }), ConfigError);
  assert.throws(() => loadCodexProviderConfig({ AI_CODEX_MAX_CALLS_PER_HOUR: '0' }), ConfigError);
});

test('CODEX CONFIG: the child environment drops every credential-shaped variable', () => {
  const env = buildCodexChildEnv({
    PATH: '/bin',
    HOME: '/Users/x',
    OPENAI_API_KEY: 'sk-live',
    CODEX_ACCESS_TOKEN: 'token',
    BYBIT_API_SECRET: 'secret',
    TELEGRAM_BOT_TOKEN: 'bot',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});
