#!/usr/bin/env node
// READ-ONLY: inspect every Bybit account bucket + Earn positions. No writes.
import { createHmac } from 'node:crypto';
const isTestnet = process.env.BYBIT_TESTNET === 'true' || process.env.TESTNET_ENABLED === 'true';
const KEY = isTestnet
  ? (process.env.BYBIT_TESTNET_API_KEY || process.env.BYBIT_API_KEY)
  : process.env.BYBIT_API_KEY;
const SECRET = isTestnet
  ? (process.env.BYBIT_TESTNET_API_SECRET || process.env.BYBIT_API_SECRET)
  : process.env.BYBIT_API_SECRET;
const RW = '5000';
const BASE = process.env.BYBIT_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
const sign = (ts, q) => createHmac('sha256', SECRET).update(ts + KEY + RW + q).digest('hex');

async function get(path, query = '', tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ts = Date.now().toString();
      const res = await fetch(`${BASE}${path}${query ? '?' + query : ''}`, {
        headers: { 'X-BAPI-API-KEY': KEY, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': RW, 'X-BAPI-SIGN': sign(ts, query) },
        signal: AbortSignal.timeout(20000),
      });
      return await res.json();
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1500)); }
  }
  return { retCode: 'NETWORK', retMsg: lastErr?.message ?? 'failed', result: {} };
}

const probes = [
  ['FUND (funding account)', '/v5/asset/transfer/query-account-coins-balance', 'accountType=FUND'],
  ['SPOT', '/v5/asset/transfer/query-account-coins-balance', 'accountType=SPOT'],
  ['Earn: flexible', '/v5/earn/position', 'category=FlexibleSaving'],
  ['Earn: on-chain', '/v5/earn/position', 'category=OnChain'],
  ['Earn: fixed term', '/v5/earn/position', 'category=FixedTermSaving'],
];

for (const [label, path, q] of probes) {
  const r = await get(path, q);
  console.log(`\n### ${label}  (${path}?${q})\nretCode=${r.retCode}  retMsg=${r.retMsg}`);
  const list = r.result?.balance ?? r.result?.list ?? r.result?.data ?? [];
  if (Array.isArray(list) && list.length) {
    for (const item of list) {
      const nonzero = Object.fromEntries(Object.entries(item).filter(([k, v]) =>
        ['coin','walletBalance','transferBalance','equity','free','totalAmount','amount','usdValue','category','productId','orderId','status','stakingAmount','estimatedAmount'].includes(k) && v !== '' && v !== '0'));
      console.log('  ', JSON.stringify(nonzero));
    }
  } else {
    console.log('  ', JSON.stringify(r.result ?? {}).slice(0, 300));
  }
}
