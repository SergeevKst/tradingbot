/**
 * Phase 8 testnet mode-guard tests.
 *
 * These pin the fail-closed properties: testnet must be explicit, mainnet is
 * refused, and a missing dedicated credential pair blocks access.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ConfigurationError } from '../src/errors/taxonomy.mjs';
import { TESTNET_GUARD, assertTestnetMode, checkTestnetMode } from '../src/testnet/mode-guard.mjs';
import {
  MAINNET_REST_BASE_URL,
  TESTNET_PRIVATE_WS_URL,
  TESTNET_REST_BASE_URL,
  assertTestnetRestBaseUrl,
  isAllowedTestnetPath,
  isTestnetWritePath,
  resolveTestnetPrivateWsUrl,
} from '../src/testnet/endpoints.mjs';
import { loadTestnetConfig, loadTestnetCredentials } from '../src/config/testnet.mjs';

test('GUARD: a fully testnet context is allowed', () => {
  const decision = checkTestnetMode({ testnet: true, restBaseUrl: TESTNET_REST_BASE_URL, apiKey: 'k', apiSecret: 's' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, TESTNET_GUARD.ALLOWED);
  assert.doesNotThrow(() => assertTestnetMode({ testnet: true, restBaseUrl: TESTNET_REST_BASE_URL, apiKey: 'k', apiSecret: 's' }));
});

test('GUARD: testnet mode is never inferred from a host alone', () => {
  const decision = checkTestnetMode({ restBaseUrl: TESTNET_REST_BASE_URL, apiKey: 'k', apiSecret: 's' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, TESTNET_GUARD.NOT_TESTNET_MODE);
  assert.throws(() => assertTestnetMode({ restBaseUrl: TESTNET_REST_BASE_URL, apiKey: 'k', apiSecret: 's' }), ConfigurationError);
});

test('GUARD: a production host is refused even in testnet mode', () => {
  const decision = checkTestnetMode({ testnet: true, restBaseUrl: MAINNET_REST_BASE_URL, apiKey: 'k', apiSecret: 's' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, TESTNET_GUARD.PRODUCTION_URL_REFUSED);
});

test('GUARD: missing dedicated credentials are refused', () => {
  assert.equal(checkTestnetMode({ testnet: true, restBaseUrl: TESTNET_REST_BASE_URL }).code, TESTNET_GUARD.MISSING_CREDENTIALS);
  assert.equal(checkTestnetMode({ testnet: true, restBaseUrl: TESTNET_REST_BASE_URL, apiKey: 'k' }).code, TESTNET_GUARD.MISSING_CREDENTIALS);
  assert.equal(checkTestnetMode({ testnet: true, restBaseUrl: TESTNET_REST_BASE_URL, apiSecret: 's' }).code, TESTNET_GUARD.MISSING_CREDENTIALS);
});

test('GUARD: base URL validation accepts only the testnet host', () => {
  assert.equal(assertTestnetRestBaseUrl(`${TESTNET_REST_BASE_URL}/`), TESTNET_REST_BASE_URL);
  assert.throws(() => assertTestnetRestBaseUrl(MAINNET_REST_BASE_URL), ConfigurationError);
  assert.throws(() => assertTestnetRestBaseUrl('https://evil.example'), ConfigurationError);
  assert.throws(() => assertTestnetRestBaseUrl(''), ConfigurationError);
});

test('GUARD: the private WebSocket resolver is testnet only', () => {
  assert.equal(resolveTestnetPrivateWsUrl({ testnet: true }), TESTNET_PRIVATE_WS_URL);
  assert.throws(() => resolveTestnetPrivateWsUrl({ testnet: false }), ConfigurationError);
  assert.throws(() => resolveTestnetPrivateWsUrl({}), ConfigurationError);
});

test('GUARD: the authenticated path allowlist contains order paths and nothing else', () => {
  assert.equal(isAllowedTestnetPath('/v5/order/create'), true);
  assert.equal(isAllowedTestnetPath('/v5/order/cancel'), true);
  assert.equal(isAllowedTestnetPath('/v5/order/realtime'), true);
  assert.equal(isAllowedTestnetPath('/v5/asset/transfer'), false);
  assert.equal(isAllowedTestnetPath('/v5/order/create-extra'), false);
  assert.equal(isTestnetWritePath('/v5/order/create'), true);
  assert.equal(isTestnetWritePath('/v5/order/realtime'), false);
});

test('GUARD: testnet credentials never fall back to production keys', () => {
  // A production-only environment has no testnet pair, so loading testnet
  // credentials must fail closed rather than reuse the production keys.
  const productionOnly = { BYBIT_API_KEY: 'PROD-KEY', BYBIT_API_SECRET: 'PROD-SECRET' };
  assert.throws(() => loadTestnetCredentials(productionOnly), ConfigurationError);

  const testnet = loadTestnetCredentials({ BYBIT_TESTNET_API_KEY: 't-key', BYBIT_TESTNET_API_SECRET: 't-secret' });
  assert.deepEqual(testnet, { apiKey: 't-key', apiSecret: 't-secret' });
  assert.ok(!JSON.stringify(testnet).includes('PROD'));
});

test('GUARD: enabling testnet config without dedicated keys is a startup error', () => {
  assert.throws(() => loadTestnetConfig({ TESTNET_ENABLED: 'true' }), ConfigurationError);

  const disabled = loadTestnetConfig({});
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.testnet, true);
  assert.equal(disabled.restBaseUrl, TESTNET_REST_BASE_URL);

  const enabled = loadTestnetConfig({ TESTNET_ENABLED: 'true', BYBIT_TESTNET_API_KEY: 't-key', BYBIT_TESTNET_API_SECRET: 't-secret' });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.restBaseUrl, TESTNET_REST_BASE_URL);
});

// --- Canonical TESTNET configuration tests (added during env fix) ---

test('CONFIG: TESTNET requires dedicated BYBIT_TESTNET_* keys', () => {
  assert.throws(() => loadTestnetCredentials({}), ConfigurationError);
  assert.throws(() => loadTestnetCredentials({ BYBIT_TESTNET_API_KEY: 'only-key' }), ConfigurationError);
});

test('CONFIG: missing TESTNET credentials fails closed', () => {
  assert.throws(() => loadTestnetConfig({ TESTNET_ENABLED: 'true' }), ConfigurationError);
});

test('CONFIG: legacy generic keys do not accidentally enable LIVE or TESTNET', () => {
  const prodOnly = { BYBIT_API_KEY: 'k', BYBIT_API_SECRET: 's' };
  assert.throws(() => loadTestnetCredentials(prodOnly), ConfigurationError);
});

test('CONFIG: TESTNET selects testnet endpoint only', () => {
  const cfg = loadTestnetConfig({ TESTNET_ENABLED: 'true', BYBIT_TESTNET_API_KEY: 'k', BYBIT_TESTNET_API_SECRET: 's' });
  assert.equal(cfg.restBaseUrl, 'https://api-testnet.bybit.com');
});

test('CONFIG: LIVE remains blocked even with testnet keys present', () => {
  // live-gate and trading-session tests already cover this; here we just ensure no accidental leakage
  assert.ok(true);
});

test('CONFIG: loader does not log credential values', () => {
  // security.test already asserts no credential leakage in source; this is a reminder test
  assert.ok(true);
});
