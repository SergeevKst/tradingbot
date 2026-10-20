#!/usr/bin/env node
/**
 * Move USDT out of Bybit Earn (FlexibleSaving) into the UNIFIED trading account.
 *
 *   node --env-file=.env scripts/earn_to_trading.mjs              # dry run, no writes
 *   node --env-file=.env scripts/earn_to_trading.mjs --execute    # perform the move
 *
 * Redemption is IRREVERSIBLE once submitted, so the execute path:
 *   1. redeems a 1 USDT probe first and verifies where the funds land,
 *   2. then redeems the remaining balance with the proven parameters,
 *   3. transfers anything sitting in FUND to UNIFIED.
 * Every step re-reads live balances, so re-running is safe.
 */
import { createHmac, randomUUID } from 'node:crypto';

const EXECUTE = process.argv.includes('--execute');
const isTestnet = process.env.BYBIT_TESTNET === 'true' || process.env.TESTNET_ENABLED === 'true';
const KEY = isTestnet
  ? (process.env.BYBIT_TESTNET_API_KEY || process.env.BYBIT_API_KEY)
  : process.env.BYBIT_API_KEY;
const SECRET = isTestnet
  ? (process.env.BYBIT_TESTNET_API_SECRET || process.env.BYBIT_API_SECRET)
  : process.env.BYBIT_API_SECRET;
const RW = '5000';
const BASE = process.env.BYBIT_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
const COIN = 'USDT';
const PROBE_AMOUNT = '1';

if (!KEY || !SECRET) {
  console.error('Missing BYBIT_API_KEY / BYBIT_API_SECRET (or BYBIT_TESTNET_* for testnet, run with --env-file=.env)');
  process.exit(2);
}

const sign = (ts, payload) => createHmac('sha256', SECRET).update(ts + KEY + RW + payload).digest('hex');

async function call(method, path, params = {}, tries = 4) {
  const query = method === 'GET' ? new URLSearchParams(params).toString() : '';
  const body = method === 'GET' ? '' : JSON.stringify(params);
  const payload = method === 'GET' ? query : body;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ts = Date.now().toString();
      const res = await fetch(`${BASE}${path}${query ? '?' + query : ''}`, {
        method,
        headers: {
          'X-BAPI-API-KEY': KEY,
          'X-BAPI-TIMESTAMP': ts,
          'X-BAPI-RECV-WINDOW': RW,
          'X-BAPI-SIGN': sign(ts, payload),
          ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(method === 'GET' ? {} : { body }),
        signal: AbortSignal.timeout(20000),
      });
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { retCode: 'NETWORK', retMsg: lastErr?.message ?? 'request failed', result: {} };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function earnUsdt() {
  const r = await call('GET', '/v5/earn/position', { category: 'FlexibleSaving' });
  const pos = (r.result?.list ?? []).find((p) => p.coin === COIN && p.productId === '1');
  return { available: Number(pos?.availableAmount ?? 0), total: Number(pos?.amount ?? 0), pnl: pos?.totalPnl ?? '0' };
}

async function accountBalance(accountType) {
  const r = await call('GET', '/v5/asset/transfer/query-account-coins-balance', { accountType, coin: COIN });
  const row = (r.result?.balance ?? [])[0];
  return {
    wallet: Number(row?.walletBalance ?? 0),
    transferable: Number(row?.transferBalance ?? 0),
    raw: r,
  };
}

async function unifiedUsdt() {
  const r = await call('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  const coins = r.result?.list?.[0]?.coin ?? [];
  const usdt = coins.find((c) => c.coin === COIN);
  return {
    wallet: Number(usdt?.walletBalance ?? 0),
    equity: Number(usdt?.equity ?? 0),
    totalEquityUsd: Number(r.result?.list?.[0]?.totalEquity ?? 0),
  };
}

function redeem(amount, accountType, toAccountType) {
  return call('POST', '/v5/earn/place-order', {
    category: 'FlexibleSaving',
    orderType: 'Redeem',
    accountType,
    toAccountType,
    coin: COIN,
    amount,
    productId: '1',
    orderLinkId: randomUUID(),
  });
}

function transferToUnified(amount) {
  return call('POST', '/v5/asset/transfer/inter-transfer', {
    transferId: randomUUID(),
    coin: COIN,
    amount,
    fromAccountType: 'FUND',
    toAccountType: 'UNIFIED',
  });
}

async function waitForArrival(label, before, read, seconds = 90) {
  for (let i = 0; i < seconds / 5; i++) {
    await sleep(5000);
    const now = await read();
    if (now > before) return now;
  }
  console.log(`  ${label}: funds not visible yet after ${seconds}s`);
  return before;
}

// ---------------------------------------------------------------------------
console.log(`mode: ${EXECUTE ? 'EXECUTE (writes!)' : 'DRY RUN'}  |  host: ${BASE}\n`);

const before = { earn: await earnUsdt(), fund: await accountBalance('FUND'), unified: await unifiedUsdt() };
console.log('BEFORE');
console.log(`  Earn FlexibleSaving USDT : ${before.earn.available} (total ${before.earn.total}, pnl ${before.earn.pnl})`);
console.log(`  FUND USDT               : wallet ${before.fund.wallet}, transferable ${before.fund.transferable}`);
console.log(`  UNIFIED USDT            : wallet ${before.unified.wallet}, account equity $${before.unified.totalEquityUsd}`);

if (before.earn.available < 0.0001 && before.fund.transferable < 0.0001) {
  console.log('\nNothing to move: Earn is empty and FUND holds no transferable USDT.');
  process.exit(0);
}

const plan = [
  `redeem 1 ${COIN} from Earn (probe) -> verify destination`,
  `redeem the remaining ${Math.max(0, before.earn.available - 1).toFixed(4)} ${COIN}`,
  `transfer any USDT in FUND -> UNIFIED`,
];
console.log('\nPLAN');
plan.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));

if (!EXECUTE) {
  console.log('\nDry run only — nothing was changed. Re-run with --execute to perform the move.');
  process.exit(0);
}

// ---- step 1: probe --------------------------------------------------------
let earn = before.earn;
if (earn.available >= Number(PROBE_AMOUNT)) {
  console.log(`\n[1] probe redeem ${PROBE_AMOUNT} ${COIN} ...`);
  let r = await redeem(PROBE_AMOUNT, 'FUND', 'UNIFIED');
  console.log('    accountType=FUND ->', r.retCode, r.retMsg);
  if (r.retCode !== 0) {
    r = await redeem(PROBE_AMOUNT, 'UNIFIED', 'UNIFIED');
    console.log('    accountType=UNIFIED ->', r.retCode, r.retMsg);
  }
  if (r.retCode !== 0) {
    console.error('\nProbe failed — no redemption submitted for the rest. Stopping.');
    process.exit(1);
  }
  const landed = await waitForArrival(
    'probe',
    before.fund.wallet + before.unified.wallet,
    async () => (await accountBalance('FUND')).wallet + (await unifiedUsdt()).wallet,
  );
  console.log(`    probe funds visible: ${landed}`);
}

// ---- step 2: redeem the rest ---------------------------------------------
// Re-read the position: whatever is still available gets redeemed in full.
// (The probe already reduced `available`, so it must NOT be subtracted again.)
earn = await earnUsdt();
const remaining = Number(earn.available.toFixed(4));
if (remaining > 0.0001) {
  console.log(`\n[2] redeem remaining ${remaining} ${COIN} ...`);
  const r = await redeem(remaining.toFixed(4), 'FUND', 'UNIFIED');
  console.log('   ->', r.retCode, r.retMsg);
  if (r.retCode !== 0) {
    console.error('   Redeem of the remainder failed — check the Bybit UI. Stopping.');
    process.exit(1);
  }
  await waitForArrival('remainder', 0, async () => (await accountBalance('FUND')).wallet + (await unifiedUsdt()).wallet);
} else {
  console.log('\n[2] nothing left to redeem.');
}

// ---- step 3: FUND -> UNIFIED ---------------------------------------------
const fund = await accountBalance('FUND');
const amount = Math.floor(fund.transferable * 10000) / 10000;
if (amount > 0.0001) {
  console.log(`\n[3] transfer ${amount} ${COIN} FUND -> UNIFIED ...`);
  const r = await transferToUnified(amount.toFixed(4));
  console.log('   ->', r.retCode, r.retMsg, JSON.stringify(r.result ?? {}));
} else {
  console.log(`\n[3] FUND transferable is ${fund.transferable} — nothing to transfer.`);
}

// ---- result ---------------------------------------------------------------
const after = { earn: await earnUsdt(), fund: await accountBalance('FUND'), unified: await unifiedUsdt() };
console.log('\nAFTER');
console.log(`  Earn FlexibleSaving USDT : ${after.earn.available}`);
console.log(`  FUND USDT               : wallet ${after.fund.wallet}, transferable ${after.fund.transferable}`);
console.log(`  UNIFIED USDT            : wallet ${after.unified.wallet}, account equity $${after.unified.totalEquityUsd}`);
