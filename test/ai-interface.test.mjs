/**
 * AI interface + type contract tests (PHASE6-INTF-001).
 *
 * These pin the contract BEFORE any provider logic: the closed `AIContext` and
 * `AIAnalysis` shapes, the no-sizing rule, the fail-closed `AIAnalysisOutcome`,
 * the `AIProvider` interface and the `AIProviderError` taxonomy member.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  AI_ANALYSIS_FIELDS,
  AI_CONTEXT_FIELDS,
  AI_SIZING_FIELDS,
  assertAIAnalysis,
  assertAIContext,
  assertNoSizingFields,
} from '../src/ai/types.mjs';
import {
  AI_ANALYSIS_SCHEMA_VERSION,
  AI_STATUS,
  assertAIProvider,
  createAIAnalysisOutcome,
  defineAIProvider,
} from '../src/ai/interface.mjs';
import {
  AIProviderError,
  AI_PROVIDER_ERROR_CODE,
  AI_PROVIDER_ERROR_KIND,
  isAIProviderError,
} from '../src/errors/ai-provider-error.mjs';
import {
  AppError,
  ERROR_CODE,
  AIProviderError as TaxonomyAIProviderError,
  ValidationError,
  isRetryable,
} from '../src/errors/index.mjs';
import { createAIAnalysis } from '../src/domain/ai-analysis.mjs';
import { ConfigError } from '../src/config/config-error.mjs';

const NOW = 1_700_000_000_000;

/** A minimal, valid AIContext — the only thing a provider is allowed to see. */
function validContext() {
  return {
    schemaVersion: '1',
    generatedAt: NOW,
    market: { symbol: 'BTCUSDT' },
    position: null,
    portfolio: null,
    strategy: null,
    risk: null,
  };
}

function validAnalysis() {
  return createAIAnalysis({
    schemaVersion: AI_ANALYSIS_SCHEMA_VERSION,
    symbol: 'BTCUSDT',
    bias: 'BULLISH',
    confidence: 0.7,
    rationale: 'trend',
    modelId: 'test-model',
    generatedAt: NOW,
  });
}

// ---------------------------------------------------------------------------
// AIContext
// ---------------------------------------------------------------------------
test('AI types: a minimal AIContext validates', () => {
  const context = validContext();
  assert.equal(assertAIContext(context), context);
  assert.ok(AI_CONTEXT_FIELDS.includes('market'));
  assert.ok(AI_CONTEXT_FIELDS.includes('generatedAt'));
});

test('AI types: AIContext is closed — an unknown field fails closed', () => {
  assert.throws(() => assertAIContext({ ...validContext(), bogus: 1 }), ValidationError);
});

test('AI types: AIContext requires a market symbol', () => {
  assert.throws(() => assertAIContext({ ...validContext(), market: {} }), ValidationError);
  assert.throws(() => assertAIContext({ ...validContext(), market: null }), ValidationError);
});

test('AI types: AIContext rejects non-objects', () => {
  for (const bad of [null, undefined, 'ctx', 42, []]) {
    assert.throws(() => assertAIContext(bad), ValidationError);
  }
});

test('AI types: the no-sizing rule covers quantity and leverage', () => {
  assert.ok(AI_SIZING_FIELDS.includes('quantity'));
  assert.ok(AI_SIZING_FIELDS.includes('leverage'));
  assert.throws(() => assertNoSizingFields({ quantity: 1 }), ValidationError);
  assert.throws(() => assertNoSizingFields({ nested: [{ leverage: 5 }] }), ValidationError);
  assert.doesNotThrow(() => assertNoSizingFields({ symbol: 'BTCUSDT', confidence: 0.5 }));
});

test('AI types: AIContext rejects a nested position carrying sizing fields', () => {
  assert.throws(
    () => assertAIContext({ ...validContext(), position: { symbol: 'BTCUSDT', quantity: 3, leverage: 2 } }),
    ValidationError,
  );
});

// ---------------------------------------------------------------------------
// AIAnalysis
// ---------------------------------------------------------------------------
test('AI types: assertAIAnalysis is the domain constructor (one closed schema)', () => {
  assert.equal(assertAIAnalysis, createAIAnalysis);
  assert.ok(AI_ANALYSIS_FIELDS.includes('bias'));
  assert.equal(assertAIAnalysis(validAnalysis()).symbol, 'BTCUSDT');
});

test('AI types: AIAnalysis is closed and carries no sizing field', () => {
  for (const key of ['quantity', 'leverage', 'positionSize']) {
    assert.throws(
      () => assertAIAnalysis({ ...validAnalysis(), [key]: 1 }),
      ValidationError,
      `AIAnalysis must reject ${key}`,
    );
  }
});

// ---------------------------------------------------------------------------
// AIProvider interface
// ---------------------------------------------------------------------------
test('AIProvider: defineAIProvider freezes a valid definition', () => {
  const analyze = async () => createAIAnalysisOutcome({ status: AI_STATUS.OK, promptVersion: 'v1', receivedAt: NOW });
  const provider = defineAIProvider({ id: '  unit  ', modelId: ' m ', promptVersion: ' v1 ', analyze });
  assert.ok(Object.isFrozen(provider));
  assert.equal(provider.id, 'unit');
  assert.equal(provider.modelId, 'm');
  assert.equal(provider.promptVersion, 'v1');
  assert.equal(provider.analyze, analyze);
});

test('AIProvider: defineAIProvider rejects a malformed definition', () => {
  const analyze = async () => createAIAnalysisOutcome({ status: AI_STATUS.OK, promptVersion: 'v1', receivedAt: NOW });
  const base = { id: 'p', modelId: 'm', promptVersion: 'v', analyze };
  assert.throws(() => defineAIProvider(null), ConfigError);
  assert.throws(() => defineAIProvider({ ...base, id: '' }), ConfigError);
  assert.throws(() => defineAIProvider({ ...base, analyze: undefined }), ConfigError);
  assert.throws(() => defineAIProvider({ ...base, modelId: '' }), ConfigError);
  assert.throws(() => defineAIProvider({ ...base, promptVersion: '' }), ConfigError);
});

test('AIProvider: assertAIProvider rejects a partial object and accepts a defined one', () => {
  const analyze = async () => createAIAnalysisOutcome({ status: AI_STATUS.OK, promptVersion: 'v1', receivedAt: NOW });
  assert.throws(() => assertAIProvider({ id: 'p', analyze }), ConfigError);
  assert.throws(() => assertAIProvider(null), ConfigError);
  const provider = defineAIProvider({ id: 'p', modelId: 'm', promptVersion: 'v', analyze });
  assert.equal(assertAIProvider(provider), provider);
});

test('AIProvider: analyze(context) resolves to a frozen, validated outcome', async () => {
  const provider = defineAIProvider({
    id: 'unit',
    modelId: 'test-model',
    promptVersion: 'v1',
    analyze: async (context) => {
      assert.equal(context.market.symbol, 'BTCUSDT');
      return createAIAnalysisOutcome({
        status: AI_STATUS.OK,
        analysis: validAnalysis(),
        modelId: 'test-model',
        promptVersion: 'v1',
        receivedAt: NOW,
      });
    },
  });

  const outcome = await provider.analyze(validContext());
  assert.ok(Object.isFrozen(outcome));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, AI_STATUS.OK);
  assert.equal(outcome.analysis.symbol, 'BTCUSDT');
  assert.ok(Object.isFrozen(outcome.issues));
});

// ---------------------------------------------------------------------------
// Fail-closed outcome
// ---------------------------------------------------------------------------
test('AI outcome: ok is true only for status OK WITH an analysis', () => {
  const analysis = validAnalysis();
  assert.equal(createAIAnalysisOutcome({ status: AI_STATUS.OK, analysis, promptVersion: 'v', receivedAt: NOW }).ok, true);
  assert.equal(createAIAnalysisOutcome({ status: AI_STATUS.OK, analysis: null, promptVersion: 'v', receivedAt: NOW }).ok, false);
  assert.equal(
    createAIAnalysisOutcome({ status: AI_STATUS.INVALID_OUTPUT, analysis, promptVersion: 'v', receivedAt: NOW }).ok,
    false,
    'invalid output must be NO TRADE even if an analysis object leaked in',
  );
});

// ---------------------------------------------------------------------------
// AIProviderError taxonomy
// ---------------------------------------------------------------------------
test('AIProviderError: is the AI_PROVIDER member of the taxonomy', () => {
  const error = new AIProviderError('provider down');
  assert.equal(AIProviderError, TaxonomyAIProviderError, 'taxonomy must re-export the same class');
  assert.ok(error instanceof AppError);
  assert.equal(error.name, 'AIProviderError');
  assert.equal(error.code, AI_PROVIDER_ERROR_CODE);
  assert.equal(error.code, ERROR_CODE.AI_PROVIDER);
  assert.equal(error.retryable, true);
  assert.equal(isRetryable(error), true);
  assert.equal(isAIProviderError(error), true);
  assert.equal(isAIProviderError(new Error('x')), false);
});

test('AIProviderError: kind is recorded, defaults to UNKNOWN and survives toJSON', () => {
  assert.equal(new AIProviderError('x').kind, AI_PROVIDER_ERROR_KIND.UNKNOWN);
  const error = new AIProviderError('rate limited', {
    kind: AI_PROVIDER_ERROR_KIND.RATE_LIMIT,
    details: { provider: 'deepseek', status: 429 },
  });
  assert.equal(error.kind, AI_PROVIDER_ERROR_KIND.RATE_LIMIT);
  assert.deepEqual(error.toJSON(), {
    name: 'AIProviderError',
    code: AI_PROVIDER_ERROR_CODE,
    retryable: true,
    message: 'rate limited',
    kind: AI_PROVIDER_ERROR_KIND.RATE_LIMIT,
  });
  assert.equal(error.details.status, 429);
});
