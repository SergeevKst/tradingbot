/**
 * Error taxonomy tests (MASTER_SPEC §22).
 *
 * The taxonomy is only useful if behaviour — the stable code and the
 * retryability default — is fixed, and if the pre-existing ConfigError still
 * behaves exactly as every caller expects.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  AppError,
  ERROR_CODE,
  ValidationError,
  ConfigurationError,
  ExchangeError,
  NetworkError,
  AuthenticationError,
  RateLimitError,
  OrderError,
  RiskError,
  AIProviderError,
  DataError,
  ReconciliationError,
  isAppError,
  isRetryable,
} from '../src/errors/index.mjs';
import { ConfigError } from '../src/config/config-error.mjs';

test('errors: AppError defaults are fail-closed', () => {
  const error = new AppError('boom');
  assert.equal(error.name, 'AppError');
  assert.equal(error.code, 'APP_ERROR');
  assert.equal(error.retryable, false, 'an unclassified error must not be retryable');
  assert.ok(Object.isFrozen(error.details));
  assert.equal(isAppError(error), true);
  assert.equal(isAppError(new Error('plain')), false);
});

test('errors: AppError preserves structured details and cause', () => {
  const cause = new Error('root');
  const error = new AppError('wrapped', { code: 'X', retryable: true, details: { field: 'a' }, cause });
  assert.equal(error.code, 'X');
  assert.equal(error.retryable, true);
  assert.deepEqual(error.details, { field: 'a' });
  assert.equal(error.cause, cause);
});

test('errors: toJSON exposes classification, not a stack', () => {
  const json = new NetworkError('timeout').toJSON();
  assert.deepEqual(json, {
    name: 'NetworkError',
    code: ERROR_CODE.NETWORK,
    retryable: true,
    message: 'timeout',
  });
});

test('errors: every taxonomy class has the expected code and retryability', () => {
  const cases = [
    [ValidationError, ERROR_CODE.VALIDATION, false],
    [ConfigurationError, ERROR_CODE.CONFIGURATION, false],
    [ExchangeError, ERROR_CODE.EXCHANGE, false],
    [NetworkError, ERROR_CODE.NETWORK, true],
    [AuthenticationError, ERROR_CODE.AUTHENTICATION, false],
    [RateLimitError, ERROR_CODE.RATE_LIMIT, true],
    [OrderError, ERROR_CODE.ORDER, false],
    [RiskError, ERROR_CODE.RISK, false],
    [AIProviderError, ERROR_CODE.AI_PROVIDER, true],
    [DataError, ERROR_CODE.DATA, false],
    [ReconciliationError, ERROR_CODE.RECONCILIATION, false],
  ];

  for (const [ErrorClass, code, retryable] of cases) {
    const error = new ErrorClass('x');
    assert.ok(error instanceof AppError, `${ErrorClass.name} must extend AppError`);
    assert.equal(error.name, ErrorClass.name);
    assert.equal(error.code, code, `${ErrorClass.name} code`);
    assert.equal(error.retryable, retryable, `${ErrorClass.name} retryable`);
    assert.equal(isRetryable(error), retryable);
  }
});

test('errors: non-idempotent OrderError is never blindly retryable', () => {
  assert.equal(isRetryable(new OrderError('rejected')), false);
});

test('errors: an unknown error is not retryable', () => {
  assert.equal(isRetryable(new Error('who knows')), false);
  assert.equal(isRetryable('not an error'), false);
  assert.equal(isRetryable(null), false);
});

test('errors: ConfigError is now the configuration member of the taxonomy', () => {
  const error = new ConfigError('bad value', { field: 'RISK_MAX_LEVERAGE', value: 'abc' });
  assert.ok(error instanceof ConfigError);
  assert.ok(error instanceof ConfigurationError, 'ConfigError must extend ConfigurationError');
  assert.ok(error instanceof AppError);
  assert.equal(error.name, 'ConfigError');
  assert.equal(error.code, ERROR_CODE.CONFIGURATION);
  assert.equal(error.retryable, false);
  // Existing public shape must be preserved.
  assert.equal(error.field, 'RISK_MAX_LEVERAGE');
  assert.equal(error.value, 'abc');
  assert.equal(error.details.field, 'RISK_MAX_LEVERAGE');
});

test('errors: domain validation throws the typed ValidationError', async () => {
  const { createMarketTick } = await import('../src/domain/index.mjs');
  assert.throws(() => createMarketTick({ symbol: 'BTCUSDT', price: -1, timestamp: 1 }), ValidationError);
  assert.throws(
    () => createMarketTick({ symbol: 'BTCUSDT', price: 1, timestamp: 1, bogus: true }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.code, ERROR_CODE.VALIDATION);
      return true;
    },
    'an unknown field must surface as a typed ValidationError',
  );
});
