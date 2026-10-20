/**
 * Domain type tests (MASTER_SPEC §7, §8).
 *
 * Every domain constructor is closed (unknown fields rejected) and validating
 * (bad values throw a typed error). These tests pin both properties, plus the
 * safety invariants that matter: no quantity/leverage can be smuggled into a
 * strategy- or AI-produced object, and corrupt market data is refused.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  createOrderRequest,
  createOrder,
  createOrderFill,
  createPosition,
  createBalance,
  createPortfolioSnapshot,
  createPnLSnapshot,
  createMarketTick,
  createOrderBookSnapshot,
  createTradingSignal,
  createStrategyDecision,
  createMarketFeature,
  createAIAnalysis,
} from '../src/domain/index.mjs';
import { ValidationError } from '../src/errors/index.mjs';

const TS = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// OrderRequest / Order
// ---------------------------------------------------------------------------

test('domain: a LIMIT order request requires a price and is frozen', () => {
  const request = createOrderRequest({
    symbol: 'btcusdt',
    side: 'long',
    type: 'LIMIT',
    quantity: 0.01,
    price: 50_000,
    timestamp: TS,
  });
  assert.equal(request.symbol, 'BTCUSDT');
  assert.equal(request.side, 'LONG');
  assert.equal(request.timeInForce, 'GTC', 'time in force defaults explicitly');
  assert.ok(Object.isFrozen(request));

  assert.throws(
    () => createOrderRequest({ symbol: 'BTCUSDT', side: 'LONG', type: 'LIMIT', quantity: 1, timestamp: TS }),
    ValidationError,
    'LIMIT without a price must be refused',
  );
});

test('domain: a MARKET order request must not carry a price', () => {
  const request = createOrderRequest({
    symbol: 'BTCUSDT',
    side: 'SHORT',
    type: 'MARKET',
    quantity: 1,
    timestamp: TS,
  });
  assert.equal(request.type, 'MARKET');
  assert.equal(request.price, undefined);

  assert.throws(
    () => createOrderRequest({ symbol: 'BTCUSDT', side: 'SHORT', type: 'MARKET', quantity: 1, price: 10, timestamp: TS }),
    ValidationError,
  );
});

test('domain: order request schemas are closed', () => {
  assert.throws(
    () =>
      createOrderRequest({
        symbol: 'BTCUSDT',
        side: 'LONG',
        type: 'MARKET',
        quantity: 1,
        timestamp: TS,
        leverageOverride: 10,
      }),
    ValidationError,
    'an unknown field must be rejected, not ignored',
  );
});

test('domain: order lifecycle and fill invariants', () => {
  const order = createOrder({
    orderId: 'o-1',
    symbol: 'BTCUSDT',
    side: 'LONG',
    type: 'LIMIT',
    status: 'PARTIALLY_FILLED',
    quantity: 1,
    filledQuantity: 0.4,
    averagePrice: 50_000,
    price: 50_000,
    createdAt: TS,
    updatedAt: TS + 1000,
  });
  assert.equal(order.filledQuantity, 0.4);
  assert.ok(Object.isFrozen(order));

  assert.throws(
    () =>
      createOrder({
        orderId: 'o-2',
        symbol: 'BTCUSDT',
        side: 'LONG',
        type: 'MARKET',
        status: 'FILLED',
        quantity: 1,
        filledQuantity: 2,
        averagePrice: 1,
        createdAt: TS,
        updatedAt: TS,
      }),
    ValidationError,
    'filled quantity may not exceed quantity',
  );

  assert.throws(
    () =>
      createOrder({
        orderId: 'o-3',
        symbol: 'BTCUSDT',
        side: 'LONG',
        type: 'MARKET',
        status: 'PARTIALLY_FILLED',
        quantity: 1,
        filledQuantity: 0.5,
        createdAt: TS,
        updatedAt: TS,
      }),
    ValidationError,
    'a partial fill must have an average price',
  );

  const fill = createOrderFill({ orderId: 'o-1', symbol: 'BTCUSDT', side: 'LONG', quantity: 0.4, price: 50_000, timestamp: TS });
  assert.equal(fill.feeUsd, 0, 'fee defaults to zero explicitly');
  assert.throws(
    () => createOrderFill({ orderId: 'o-1', symbol: 'BTCUSDT', side: 'LONG', quantity: 0.4, price: 50_000, feeUsd: -1, timestamp: TS }),
    ValidationError,
  );
});

// ---------------------------------------------------------------------------
// Position / portfolio
// ---------------------------------------------------------------------------

test('domain: a position is validated and frozen', () => {
  const position = createPosition({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.5, entryPrice: 50_000, openedAt: TS });
  assert.equal(position.leverage, 1);
  assert.equal(position.status, 'OPEN');
  assert.ok(Object.isFrozen(position));

  assert.throws(() => createPosition({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0, entryPrice: 1, openedAt: TS }), ValidationError);
  assert.throws(() => createPosition({ symbol: 'BTCUSDT', side: 'SIDEWAYS', quantity: 1, entryPrice: 1, openedAt: TS }), ValidationError);
});

test('domain: portfolio and PnL snapshots validate nested members', () => {
  const portfolio = createPortfolioSnapshot({
    equityUsd: 340,
    availableBalanceUsd: 300,
    balances: [{ asset: 'usdt', walletBalanceUsd: 340, availableBalanceUsd: 300 }],
    positions: [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.5, entryPrice: 50_000, openedAt: TS }],
    source: 'paper',
    timestamp: TS,
  });
  assert.equal(portfolio.balances[0].asset, 'USDT');
  assert.equal(portfolio.positions.length, 1);
  assert.ok(Object.isFrozen(portfolio.balances));
  assert.ok(Object.isFrozen(portfolio.positions));

  const pnl = createPnLSnapshot({ realizedPnlUsd: -10, unrealizedPnlUsd: 5, netPnlUsd: -6, timestamp: TS });
  assert.equal(pnl.feesUsd, 0);
  assert.ok(Object.isFrozen(pnl));

  assert.throws(
    () => createPortfolioSnapshot({ equityUsd: 340, availableBalanceUsd: 300, balances: 'nope', positions: [], timestamp: TS }),
    ValidationError,
  );
});

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

test('domain: market ticks refuse a crossed book', () => {
  const tick = createMarketTick({ symbol: 'BTCUSDT', price: 50_000, bid: 49_999, ask: 50_001, timestamp: TS });
  assert.equal(tick.bid, 49_999);
  assert.throws(() => createMarketTick({ symbol: 'BTCUSDT', price: 50_000, bid: 100, ask: 90, timestamp: TS }), ValidationError);
  assert.throws(() => createMarketTick({ symbol: 'BTCUSDT', price: 0, timestamp: TS }), ValidationError);
});

test('domain: order book requires sorted, uncrossed levels', () => {
  const book = createOrderBookSnapshot({
    symbol: 'BTCUSDT',
    bids: [[49_999, 1], [49_998, 2]],
    asks: [[50_001, 1], [50_002, 2]],
    timestamp: TS,
  });
  assert.equal(book.bids[0][0], 49_999);
  assert.ok(Object.isFrozen(book.bids[0]));

  assert.throws(
    () => createOrderBookSnapshot({ symbol: 'BTCUSDT', bids: [[49_998, 1], [49_999, 1]], asks: [], timestamp: TS }),
    ValidationError,
    'bids must be descending',
  );
  assert.throws(
    () => createOrderBookSnapshot({ symbol: 'BTCUSDT', bids: [[50_000, 1]], asks: [[49_999, 1]], timestamp: TS }),
    ValidationError,
    'crossed book must be refused',
  );
});

// ---------------------------------------------------------------------------
// Strategy decision / signal
// ---------------------------------------------------------------------------

test('domain: a signal carries direction but never sizing', () => {
  const signal = createTradingSignal({ strategyId: 'ma-cross', symbol: 'BTCUSDT', side: 'LONG', confidence: 0.7, timestamp: TS });
  assert.equal(signal.side, 'LONG');
  assert.throws(
    () => createTradingSignal({ strategyId: 's', symbol: 'BTCUSDT', side: 'LONG', confidence: 1.5, timestamp: TS }),
    ValidationError,
  );
  assert.throws(
    () => createTradingSignal({ strategyId: 's', symbol: 'BTCUSDT', side: 'LONG', confidence: 0.5, quantity: 3, timestamp: TS }),
    ValidationError,
    'a signal must not accept a quantity',
  );
});

test('domain: strategy decision enforces EMIT/NO_SIGNAL consistency', () => {
  const emit = createStrategyDecision({
    strategyId: 'ma-cross',
    symbol: 'BTCUSDT',
    action: 'EMIT',
    signal: { strategyId: 'ma-cross', symbol: 'BTCUSDT', side: 'LONG', confidence: 0.7, timestamp: TS },
    timestamp: TS,
  });
  assert.equal(emit.signal.side, 'LONG');

  const noSignal = createStrategyDecision({ strategyId: 'ma-cross', symbol: 'BTCUSDT', action: 'NO_SIGNAL', timestamp: TS });
  assert.equal(noSignal.signal, undefined);

  assert.throws(
    () => createStrategyDecision({ strategyId: 's', symbol: 'BTCUSDT', action: 'EMIT', timestamp: TS }),
    ValidationError,
    'EMIT requires a signal',
  );
  assert.throws(
    () =>
      createStrategyDecision({
        strategyId: 's',
        symbol: 'BTCUSDT',
        action: 'NO_SIGNAL',
        signal: { strategyId: 's', symbol: 'BTCUSDT', side: 'LONG', confidence: 0.5, timestamp: TS },
        timestamp: TS,
      }),
    ValidationError,
    'NO_SIGNAL must not carry a signal',
  );
});

// ---------------------------------------------------------------------------
// Feature / AI analysis schema
// ---------------------------------------------------------------------------

test('domain: a market feature requires a finite value', () => {
  const feature = createMarketFeature({ name: 'atr', value: 123.4, symbol: 'BTCUSDT', timestamp: TS });
  assert.equal(feature.value, 123.4);
  assert.throws(() => createMarketFeature({ name: 'atr', value: Number.NaN }), ValidationError);
});

test('domain: an AI analysis is schema-only and cannot smuggle an order', () => {
  const analysis = createAIAnalysis({
    schemaVersion: '1',
    symbol: 'BTCUSDT',
    bias: 'BULLISH',
    confidence: 0.6,
    rationale: 'trend up',
    evidence: ['smaFast > smaSlow'],
    modelId: 'test-model',
    generatedAt: TS,
  });
  assert.equal(analysis.bias, 'BULLISH');
  assert.ok(Object.isFrozen(analysis.evidence));

  assert.throws(
    () => createAIAnalysis({ schemaVersion: '1', symbol: 'BTCUSDT', bias: 'SIDEWAYS', confidence: 0.5, modelId: 'm', generatedAt: TS }),
    ValidationError,
  );
  assert.throws(
    () =>
      createAIAnalysis({
        schemaVersion: '1',
        symbol: 'BTCUSDT',
        bias: 'BULLISH',
        confidence: 0.5,
        modelId: 'm',
        generatedAt: TS,
        quantity: 10,
      }),
    ValidationError,
    'AI output must not carry an order quantity',
  );
});
