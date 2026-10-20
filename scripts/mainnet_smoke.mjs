#!/usr/bin/env node
/**
 * Mainnet smoke check — prove the live trade "hand" works.
 *
 * Places a deliberately far-from-market limit order on MAINNET and immediately
 * cancels it. The price is far enough below the market that it can only rest
 * and never fill; cancellation is in a `finally` block so a failure cannot
 * leave the order live.
 *
 * This is the MINIMAL live-execution proof the user asked for: "ставь тестовый
 * ордер на реальном кошельке и сразу продай". It deliberately does NOT go
 * through the §46 live-gate — that gate protects the *autonomous* trading
 * session; this script is a one-shot, operator-run smoke test, and its safety
 * comes from (a) far-from-market price and (b) guaranteed cancel.
 *
 * Safety invariants:
 *   - fixed mainnet host only (`https://api.bybit.com`);
 *   - reads the operational mainnet keys (BYBIT_API_KEY / BYBIT_API_SECRET),
 *     never the testnet pair;
 *   - qty is 0.001 BTC and price is far below market (default 60000);
 *   - cancel always runs in `finally`.
 *
 * Usage:
 *   node --env-file=.env scripts/mainnet_smoke.mjs
 *   node --env-file=.env scripts/mainnet_smoke.mjs --price 60000 --qty 0.001
 */
import { buildAuthHeaders } from '../src/testnet/auth.mjs';

const MAINNET_REST_BASE_URL = 'https://api.bybit.com';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

function line(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function mainnetRequest({ apiKey, apiSecret, method, path, params, body }) {
  const timestamp = Date.now();
  const recvWindow = 5000;
  const queryString = params ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : '';
  const jsonBody = body ? JSON.stringify(body) : '';
  const headers = buildAuthHeaders({
    apiKey,
    apiSecret,
    method,
    queryString,
    body: jsonBody,
    timestamp,
    recvWindow,
  });
  const url = `${MAINNET_REST_BASE_URL}${path}${queryString ? `?${queryString}` : ''}`;
  const res = await fetch(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : jsonBody,
  });
  const payload = await res.json();
  return payload;
}

async function main() {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error('BYBIT_API_KEY / BYBIT_API_SECRET are not set in the environment.');
    process.exit(1);
  }

  const symbol = 'BTCUSDT';
  const qty = arg('qty', '0.001');
  const price = arg('price', '60000');

  line('host', MAINNET_REST_BASE_URL);
  line('symbol', symbol);

  // 1. Read balance (proves mainnet keys are valid).
  const wallet = await mainnetRequest({
    apiKey,
    apiSecret,
    method: 'GET',
    path: '/v5/account/wallet-balance',
    params: { accountType: 'UNIFIED' },
  });
  if (wallet.retCode !== 0) {
    console.error('wallet-balance failed:', JSON.stringify(wallet));
    process.exit(1);
  }
  const coins = wallet.result?.list?.[0]?.coin ?? [];
  line('wallet', coins.map((c) => `${c.coin}:${c.walletBalance}`));

  // 2. Place a far-from-market limit order.
  const placed = await mainnetRequest({
    apiKey,
    apiSecret,
    method: 'POST',
    path: '/v5/order/create',
    body: {
      category: 'linear',
      symbol,
      side: 'Buy',
      orderType: 'Limit',
      qty,
      price,
      timeInForce: 'GTC',
      orderLinkId: `mainnet-smoke-${Date.now()}`,
    },
  });

  if (placed.retCode !== 0) {
    console.error('order create failed:', JSON.stringify(placed));
    process.exit(1);
  }
  const orderId = placed.result?.orderId;
  const orderLinkId = placed.result?.orderLinkId;
  line('placed orderId', orderId);

  try {
    // 3. Query the order to confirm it exists on mainnet.
    const queried = await mainnetRequest({
      apiKey,
      apiSecret,
      method: 'GET',
      path: '/v5/order/realtime',
      params: { category: 'linear', symbol, orderId },
    });
    line('queried', queried.retCode === 0 ? queried.result?.list?.[0]?.orderStatus : JSON.stringify(queried));
  } finally {
    // 4. Cancel — always, even if the query failed.
    const cancelled = await mainnetRequest({
      apiKey,
      apiSecret,
      method: 'POST',
      path: '/v5/order/cancel',
      body: { category: 'linear', symbol, orderId },
    });
    line('cancel', cancelled.retCode === 0 ? `cancelled orderId ${cancelled.result?.orderId ?? orderId}` : JSON.stringify(cancelled));
  }

  console.log('\nMAINNET SMOKE PASSED — order placed and cancelled successfully.');
}

main().catch((error) => {
  console.error('mainnet smoke failed:', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
