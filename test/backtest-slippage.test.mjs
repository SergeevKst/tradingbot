/**
 * Phase 7 — pluggable slippage models (§29).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  createZeroSlippageModel,
  createRateSlippageModel,
  assertSlippageModel,
} from '../src/backtest/slippage-model.mjs';
import { createExecutableBook } from '../src/simulator/market-replay.mjs';
import { ConfigError } from '../src/config/config-error.mjs';

test('SLIPPAGE: the zero model leaves the book untouched', () => {
  const model = createZeroSlippageModel();
  assert.equal(model.kind(), 'zero');
  assert.deepEqual(model.adjustBook({ mid: 100, bid: 99.9, ask: 100.1 }), { bid: 99.9, ask: 100.1 });
});

test('SLIPPAGE: the rate model widens the book adversarially on both sides', () => {
  const model = createRateSlippageModel({ rate: 0.001 });
  const adjusted = model.adjustBook({ mid: 100, bid: 99.9, ask: 100.1 });
  assert.ok(Math.abs(adjusted.bid - 99.8) < 1e-9, `bid ${adjusted.bid}`);
  assert.ok(Math.abs(adjusted.ask - 100.2) < 1e-9, `ask ${adjusted.ask}`);
  assert.equal(model.kind(), 'rate');
  assert.equal(model.rate, 0.001);
});

test('SLIPPAGE: bad rates and untrusted models are refused', () => {
  assert.throws(() => createRateSlippageModel({ rate: -0.1 }), ConfigError);
  assert.throws(() => createRateSlippageModel({ rate: Number.NaN }), ConfigError);
  assert.throws(() => assertSlippageModel({ kind: () => 'x' }), ConfigError);
  assert.throws(() => assertSlippageModel(null), ConfigError);
});

test('SLIPPAGE: a spread plus slippage is reflected in the executable book', () => {
  const book = createExecutableBook({
    referencePrice: 100,
    spreadBps: 20, // 0.2% total spread -> 0.1 each side
    slippageModel: createRateSlippageModel({ rate: 0.001 }),
  });
  assert.ok(Math.abs(book.bid - 99.8) < 1e-9, `bid ${book.bid}`);
  assert.ok(Math.abs(book.ask - 100.2) < 1e-9, `ask ${book.ask}`);
});

test('SLIPPAGE: a crossed book is refused rather than presented', () => {
  const model = Object.freeze({
    kind: () => 'broken',
    adjustBook: () => ({ bid: 101, ask: 100 }),
  });
  assert.throws(() => createExecutableBook({ referencePrice: 100, spreadBps: 0, slippageModel: model }), ConfigError);
});
