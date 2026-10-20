#!/usr/bin/env node
// Verify Bybit V5 API credentials (HMAC-SHA256) against mainnet and testnet.
import { createHmac } from 'node:crypto';

const isTestnet = process.env.BYBIT_TESTNET === 'true' || process.env.TESTNET_ENABLED === 'true';
const API_KEY = isTestnet
  ? (process.env.BYBIT_TESTNET_API_KEY || process.env.BYBIT_API_KEY)
  : process.env.BYBIT_API_KEY;
const API_SECRET = isTestnet
  ? (process.env.BYBIT_TESTNET_API_SECRET || process.env.BYBIT_API_SECRET)
  : process.env.BYBIT_API_SECRET;
const RECV_WINDOW = '5000';

if (!API_KEY || !API_SECRET) {
  console.error('Missing BYBIT_API_KEY / BYBIT_API_SECRET (or BYBIT_TESTNET_* for testnet)');
  process.exit(2);
}

function sign(timestamp, queryString) {
  return createHmac('sha256', API_SECRET)
    .update(timestamp + API_KEY + RECV_WINDOW + queryString)
    .digest('hex');
}

async function signedGet(base, path, query = '') {
  const ts = Date.now().toString();
  const res = await fetch(base + path + (query ? `?${query}` : ''), {
    headers: {
      'X-BAPI-API-KEY': API_KEY,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
      'X-BAPI-SIGN': sign(ts, query),
    },
  });
  const json = await res.json();
  return { http: res.status, ...json };
}

const bases = [
  ['mainnet', 'https://api.bybit.com'],
  ['testnet', 'https://api-testnet.bybit.com'],
];

for (const [label, base] of bases) {
  console.log(`\n=== ${label} (${base}) ===`);
  try {
    const r = await signedGet(base, '/v5/user/query-api');
    console.log('retCode:', r.retCode, '| retMsg:', r.retMsg);
    if (r.retCode === 0) {
      const x = r.result ?? {};
      console.log(JSON.stringify({
        note: x.note, unified: x.unified, readOnly: x.readOnly,
        permissions: x.permissions, ips: x.ips,
        expiredAt: x.expiredAt, deadlineDay: x.deadlineDay,
        userID: x.userID, vipLevel: x.vipLevel,
      }, null, 2));
    }
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}
