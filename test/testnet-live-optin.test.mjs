/**
 * Phase 8 opt-in REAL testnet connectivity check.
 *
 * This test is SKIPPED unless an operator deliberately sets
 * `RUN_TESTNET_TESTS=true` AND supplies dedicated testnet credentials. It only
 * performs read-only authenticated calls, so the default `npm test` run never
 * touches the network and never places an order.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createBybitTestnetRestClient } from '../src/testnet/authenticated-rest-client.mjs';

const enabled = process.env.RUN_TESTNET_TESTS === 'true';
const hasKeys = Boolean(process.env.BYBIT_TESTNET_API_KEY && process.env.BYBIT_TESTNET_API_SECRET);

test(
  'TESTNET LIVE: an authenticated read-only call succeeds against api-testnet.bybit.com',
  { skip: !enabled || !hasKeys ? 'set RUN_TESTNET_TESTS=true and BYBIT_TESTNET_API_KEY/SECRET to enable' : false },
  async () => {
    const client = createBybitTestnetRestClient({
      testnet: true,
      baseUrl: 'https://api-testnet.bybit.com',
      apiKey: process.env.BYBIT_TESTNET_API_KEY,
      apiSecret: process.env.BYBIT_TESTNET_API_SECRET,
      category: 'linear',
    });

    // Read-only: proves signed connectivity without creating exchange state.
    const result = await client.getOpenOrders({ symbol: 'BTCUSDT' });
    assert.equal(typeof result, 'object');
    assert.ok(Array.isArray(result.list), 'a real testnet response carries a list');
  },
);
