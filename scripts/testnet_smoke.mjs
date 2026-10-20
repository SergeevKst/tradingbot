#!/usr/bin/env node
/**
 * Testnet smoke check (Phase 8).
 *
 * Read-only by default: it authenticates against api-testnet.bybit.com and
 * queries open orders. Pass `--place` to also place and immediately cancel a
 * deliberately far-from-market limit order, which exercises the full
 * place/query/cancel path.
 *
 * Safety:
 *   - requires TESTNET_ENABLED=true and dedicated BYBIT_TESTNET_* keys;
 *   - exits 0 with a clear message when they are absent (so it is CI-safe);
 *   - the host is fixed to testnet and production credentials are never read.
 *
 * Run: node --env-file=.env scripts/testnet_smoke.mjs [--place]
 */
import { loadTestnetConfig, loadTestnetCredentials } from '../src/config/testnet.mjs';
import { createBybitTestnetRestClient } from '../src/testnet/authenticated-rest-client.mjs';

const withOrder = process.argv.includes('--place');

function line(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function main() {
  const config = loadTestnetConfig();
  if (!config.enabled) {
    console.log('TESTNET_ENABLED is not true — skipping (no testnet I/O performed).');
    return;
  }

  const credentials = loadTestnetCredentials();
  const client = createBybitTestnetRestClient({
    testnet: true,
    baseUrl: config.restBaseUrl,
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    category: config.category,
  });

  line('host', client.baseUrl);
  const wallet = await client.getWalletBalance();
  line('wallet coins', (wallet.list?.[0]?.coin ?? []).map((coin) => `${coin.coin}:${coin.walletBalance}`));

  const open = await client.getOpenOrders({ symbol: 'BTCUSDT' });
  line('open BTCUSDT orders', Array.isArray(open.list) ? open.list.length : 0);

  if (withOrder) {
    // A price far below the market can only rest, never fill; and it is
    // cancelled in a finally block so a failure cannot leave it live.
    const placed = await client.placeOrder({
      symbol: 'BTCUSDT',
      side: 'Buy',
      orderType: 'Limit',
      qty: '0.001',
      price: '1000',
      timeInForce: 'GTC',
      orderLinkId: `smoke-${Date.now()}`,
    });
    line('placed orderId', placed.orderId);
    try {
      const queried = await client.getOrder({ symbol: 'BTCUSDT', orderId: placed.orderId });
      line('queried status', queried.status);
    } finally {
      const cancelled = await client.cancelOrder({ symbol: 'BTCUSDT', orderId: placed.orderId });
      line('cancelled orderId', cancelled.orderId);
    }
  }
}

main().catch((error) => {
  console.error('testnet smoke failed:', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
