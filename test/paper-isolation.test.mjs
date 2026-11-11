/**
 * PAPER isolation proof.
 *
 * The claim under test is structural, not configurational: there is no PAPER
 * execution path that can reach an authenticated exchange request, whatever the
 * environment happens to say. Three independent proofs are asserted here.
 *
 *   1. STATIC — walk the entire import closure of `src/session/paper-session.mjs`
 *      and assert that no reachable module imports an HTTP client, an exchange
 *      SDK, a signer, or a Telegram layer. The adversary in this scenario is a
 *      future refactor, so the test reads the real source rather than trusting
 *      a comment.
 *   2. INTERFACE — the paper adapter declares `canPlaceRealOrders: false`, has
 *      no order-placing method, and every operation in
 *      FORBIDDEN_EXCHANGE_OPERATIONS is absent from it.
 *   3. RUNTIME — a full lifecycle (entry, mark, stop, close, restart) is run
 *      with `globalThis.fetch` replaced by a counting stub. Zero calls proves
 *      the path performs no network I/O at all, authenticated or otherwise.
 *
 * Live mode is also asserted to remain refused by the session factory, so a
 * misconfiguration cannot promote a PAPER run into a real one.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPaperExecutionAdapter } from '../src/execution/paper-execution-adapter.mjs';
import { FORBIDDEN_EXCHANGE_OPERATIONS } from '../src/execution/execution-adapter.mjs';
import { adapterKindForMode, createTradingSession } from '../src/session/trading-session.mjs';
import { createPaperAccountState } from '../src/state/paper-account.mjs';
import { createRateFeeModel } from '../src/state/fee-model.mjs';
import { ConfigError } from '../src/config/config-error.mjs';
import { makeSession, marketAt, proposal, quietLogger } from './paper-fixtures.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(projectRoot, 'src');

/** Directories whose presence in the PAPER closure would break the claim. */
const FORBIDDEN_PREFIXES = Object.freeze([
  join(srcRoot, 'testnet'),
  join(srcRoot, 'adapters'),
  join(srcRoot, 'telegram'),
  join(srcRoot, 'providers'),
  join(srcRoot, 'ai'),
  join(srcRoot, 'reconciliation'),
  join(srcRoot, 'recovery'),
  join(srcRoot, 'safety'),
]);

/** Specifiers that would mean "this module can talk to the outside world". */
const FORBIDDEN_SPECIFIERS = Object.freeze([
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:dgram',
  'undici',
  'axios',
  'node-fetch',
  'ws',
  'bybit-official-trading-server',
  'grammy',
  '@modelcontextprotocol/sdk',
]);

/**
 * Every static (and simple dynamic) import specifier in a module.
 *
 * @param {string} source
 * @returns {string[]}
 */
function importSpecifiers(source) {
  const patterns = [
    /^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /^\s*export\s+[^'"]*from\s+['"]([^'"]+)['"]/gm,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  /** @type {string[]} */
  const specs = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(match[1]);
  }
  return specs;
}

/**
 * Transitive import closure of a module, as absolute paths plus the set of
 * bare (package/node:) specifiers encountered.
 *
 * @param {string} entry absolute path
 * @returns {{ modules: string[], bare: string[], specifiersByModule: Map<string, string[]> }}
 */
function importClosure(entry) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Set<string>} */
  const bare = new Set();
  /** @type {Map<string, string[]>} */
  const specifiersByModule = new Map();
  const queue = [entry];

  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.pop());
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, 'utf8');
    const specs = importSpecifiers(source);
    specifiersByModule.set(file, specs);

    for (const spec of specs) {
      if (spec.startsWith('.')) {
        queue.push(resolve(dirname(file), spec));
      } else {
        bare.add(spec);
      }
    }
  }

  return { modules: [...seen], bare: [...bare].sort(), specifiersByModule };
}

// ---------------------------------------------------------------------------
// 1. Static proof
// ---------------------------------------------------------------------------
test('ISOLATION: the PAPER import closure reaches no exchange, HTTP or Telegram module', () => {
  const closure = importClosure(join(srcRoot, 'session/paper-session.mjs'));

  assert.ok(closure.modules.length > 10, `expected a real closure, got ${closure.modules.length} modules`);

  const forbiddenModules = closure.modules.filter((file) => FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)));
  assert.deepEqual(forbiddenModules, [], `PAPER closure reaches forbidden modules: ${forbiddenModules.join(', ')}`);

  const forbiddenSpecifiers = closure.bare.filter((spec) => FORBIDDEN_SPECIFIERS.includes(spec) || spec.includes('bybit'));
  assert.deepEqual(forbiddenSpecifiers, [], `PAPER closure imports forbidden packages: ${forbiddenSpecifiers.join(', ')}`);

  // The closure is genuinely offline: the only Node builtins it uses are the
  // filesystem and path helpers needed for persistence.
  assert.deepEqual(closure.bare.slice().sort(), ['node:fs/promises', 'node:path']);
});

test('ISOLATION: no module in the PAPER closure reads exchange credentials', () => {
  const closure = importClosure(join(srcRoot, 'session/paper-session.mjs'));

  // `loadExchangeCredentials` is defined in config/env.mjs, which the closure
  // reaches only for the LOG_LEVEL constant via util/logger.mjs. The accessor
  // itself must never be called from a reachable module.
  for (const file of closure.modules) {
    if (file.endsWith(join('config', 'env.mjs'))) continue;
    const source = readFileSync(file, 'utf8');
    assert.equal(
      source.includes('loadExchangeCredentials'),
      false,
      `${file} references loadExchangeCredentials inside the PAPER closure`,
    );
  }

  // And no reachable module embeds an order-placing path or a signing header.
  for (const file of closure.modules) {
    const source = readFileSync(file, 'utf8');
    for (const token of ['/v5/order', 'X-BAPI', 'X-BAPI-SIGN']) {
      assert.equal(source.includes(token), false, `${file} contains the exchange token ${token}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Interface proof
// ---------------------------------------------------------------------------
test('ISOLATION: the paper adapter cannot place a real order by construction', () => {
  const adapter = createPaperExecutionAdapter({
    account: createPaperAccountState({ equityUsd: 340 }),
    feeModel: createRateFeeModel({ entryRate: 0.001, exitRate: 0.001 }),
    logger: quietLogger,
  });

  assert.equal(adapter.kind(), 'PAPER');
  assert.equal(adapter.canPlaceRealOrders, false, 'the adapter declares itself incapable of real orders');

  for (const operation of FORBIDDEN_EXCHANGE_OPERATIONS) {
    assert.equal(
      typeof /** @type {Record<string, unknown>} */ (adapter)[operation],
      'undefined',
      `the paper adapter must not expose ${operation}`,
    );
  }
});

test('ISOLATION: no adapter method is a shell around an exchange call', () => {
  const adapter = createPaperExecutionAdapter({
    account: createPaperAccountState({ equityUsd: 340 }),
    feeModel: createRateFeeModel({ entryRate: 0.001, exitRate: 0.001 }),
    logger: quietLogger,
  });

  // Every exposed function is enumerated explicitly: a new method has to be
  // added here deliberately, which makes an accidental `createOrder` visible in
  // review rather than silently reachable.
  const exposed = Object.keys(adapter).sort();
  assert.deepEqual(exposed, [
    'canPlaceRealOrders',
    'closePosition',
    'getAccountState',
    'getOpenPositions',
    'getPosition',
    'kind',
    'modifyPositionProtection',
    'onMarketUpdate',
    'openPosition',
    'setAccount',
    'snapshot',
  ]);
});

// ---------------------------------------------------------------------------
// 3. Runtime proof
// ---------------------------------------------------------------------------
test('ISOLATION: a full PAPER lifecycle performs zero network calls', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  /** @type {string[]} */
  const attempts = [];

  // @ts-expect-error — deliberately replacing the global for the test.
  globalThis.fetch = (...args) => {
    calls += 1;
    attempts.push(String(args[0]));
    throw new Error('network access is forbidden in the PAPER path');
  };

  const { session, cleanup, restart } = await makeSession();
  try {
    const market = marketAt(86000);
    const opened = await session.submit({
      proposal: proposal({ entryPrice: 86000, stopLossPrice: 85280, takeProfitPrice: 87620 }),
      market: await market.getSnapshot('BTCUSDT'),
    });
    assert.equal(opened.executed, true, `${opened.reasonCode}: ${opened.message ?? ''}`);

    market.setTicker({ markPrice: 86500, bid: 86499.9, ask: 86500.1, lastPrice: 86500 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    market.setTicker({ markPrice: 85000, bid: 84999.9, ask: 85000.1, lastPrice: 85000 });
    await session.onMarketUpdate(await market.getSnapshot('BTCUSDT'));

    const revived = await restart();
    assert.equal(revived.restored, true);

    assert.equal(calls, 0, `the PAPER path attempted network access: ${attempts.join(', ')}`);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Live mode stays refused
// ---------------------------------------------------------------------------
test('ISOLATION: the session factory never maps PAPER onto an authenticated adapter', async () => {
  assert.equal(adapterKindForMode('PAPER'), 'PAPER');
  assert.equal(adapterKindForMode('TESTNET'), 'TESTNET');
  assert.equal(adapterKindForMode('TESTNET_ONCE'), 'TESTNET');

  // An absent/blank mode resolves to the PAPER default — a safe default, not a
  // fallback to live.
  assert.equal(adapterKindForMode(undefined), 'PAPER');
  assert.equal(adapterKindForMode(''), 'PAPER');

  for (const mode of ['LIVE', 'BACKTEST', 'NOPE']) {
    assert.throws(() => adapterKindForMode(mode), ConfigError, `mode ${JSON.stringify(mode)} must be refused`);
    await assert.rejects(() => createTradingSession({ mode }), ConfigError);
  }
});
