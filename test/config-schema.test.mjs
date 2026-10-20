/**
 * Configuration schema tests (MASTER_SPEC §19).
 *
 * Invalid configuration must prevent trading from starting; these tests pin the
 * fail-closed behaviour of `assertRuntimeConfig`.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { assertRuntimeConfig } from '../src/config/schema.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';

function validConfig(overrides = {}) {
  return {
    exchange: { testnet: false, baseUrl: 'https://api.bybit.com', category: 'linear' },
    trading: { mode: 'PAPER', offlineMode: true, liveTradingAllowed: false },
    risk: { ...DEFAULT_RISK_LIMITS },
    strategy: { defaultStrategyId: 'deterministic-ma-crossover', parameters: { fastPeriod: 3 } },
    ai: { enabled: false },
    logging: { level: 'INFO' },
    ...overrides,
  };
}

test('config-schema: a valid PAPER runtime config passes through', () => {
  const config = validConfig();
  assert.equal(assertRuntimeConfig(config), config);
});

test('config-schema: LIVE is refused as configuration', () => {
  assert.throws(() => assertRuntimeConfig(validConfig({ trading: { mode: 'LIVE', offlineMode: false, liveTradingAllowed: true } })), ConfigError);
});

test('config-schema: an unknown trading mode is refused', () => {
  assert.throws(
    () => assertRuntimeConfig(validConfig({ trading: { mode: 'TURBO', offlineMode: true, liveTradingAllowed: false } })),
    ConfigError,
  );
});

test('config-schema: invalid risk limits are refused', () => {
  assert.throws(() => assertRuntimeConfig(validConfig({ risk: { ...DEFAULT_RISK_LIMITS, maxLeverage: 0 } })), ConfigError);
});

test('config-schema: a bad log level is refused', () => {
  assert.throws(() => assertRuntimeConfig(validConfig({ logging: { level: 'LOUD' } })), ConfigError);
});

test('config-schema: AI must be an explicit boolean and defaults off', () => {
  assert.throws(() => assertRuntimeConfig(validConfig({ ai: { enabled: 'yes' } })), ConfigError);
});

test('config-schema: strategy parameters must be finite numbers', () => {
  assert.throws(
    () => assertRuntimeConfig(validConfig({ strategy: { defaultStrategyId: null, parameters: { fastPeriod: 'three' } } })),
    ConfigError,
  );
});

test('config-schema: nested config sections are required', () => {
  const missing = validConfig();
  delete missing.exchange;
  assert.throws(() => assertRuntimeConfig(missing), ConfigError);
  assert.throws(() => assertRuntimeConfig(null), ConfigError);
  assert.throws(() => assertRuntimeConfig('nope'), ConfigError);
});
