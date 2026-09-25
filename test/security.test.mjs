/**
 * Security / isolation tests.
 *
 * These assert architectural properties by reading the actual source files, so
 * they fail if someone later imports an exchange client into the risk layer or
 * introduces a real order call into the core. They are the executable form of
 * the Stage 1 boundary rules.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(projectRoot, 'src');

/**
 * Recursively collect .mjs files under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function collectModules(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectModules(full));
    } else if (extname(entry) === '.mjs') {
      found.push(full);
    }
  }
  return found;
}

const allModules = collectModules(srcRoot);

/** Modules under a directory prefix. */
function modulesUnder(...segments) {
  const prefix = join(srcRoot, ...segments);
  return allModules.filter((file) => file.startsWith(prefix));
}

/**
 * Extract every static import/export-from specifier from a module's source.
 * @param {string} file
 * @returns {string[]}
 */
function importSpecifiers(file) {
  const source = readFileSync(file, 'utf8');
  /** @type {string[]} */
  const specs = [];
  const patterns = [
    /^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /^\s*export\s+[^'"]*from\s+['"]([^'"]+)['"]/gm,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(match[1]);
  }
  return specs;
}

/** Read a module's source. */
function source(file) {
  return readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------------------
// The risk layer must be pure domain code
// ---------------------------------------------------------------------------
test('SECURITY: the risk layer imports no HTTP, exchange, MCP or AI modules', () => {
  const forbidden = [
    'node:http',
    'node:https',
    'node:net',
    'node:dgram',
    'node:tls',
    'undici',
    'axios',
    'node-fetch',
    'ws',
    'bybit',
    'bybit-api',
    '@deepseek',
    'deepseek',
    'openai',
    'mcp',
  ];

  const riskModules = modulesUnder('risk');
  assert.ok(riskModules.length > 0, 'expected risk modules to exist');

  for (const file of riskModules) {
    const rel = relative(projectRoot, file);
    for (const spec of importSpecifiers(file)) {
      const lower = spec.toLowerCase();
      for (const banned of forbidden) {
        assert.ok(
          !lower.includes(banned),
          `${rel} must not import "${spec}" (matched forbidden "${banned}") — the risk layer must stay isolated`,
        );
      }
    }
  }
});

test('SECURITY: the risk layer performs no network or process side effects', () => {
  const riskModules = modulesUnder('risk');
  const bannedCalls = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'child_process', 'execSync', 'spawn('];

  for (const file of riskModules) {
    const text = source(file);
    const rel = relative(projectRoot, file);
    for (const banned of bannedCalls) {
      assert.ok(!text.includes(banned), `${rel} must not contain "${banned}"`);
    }
  }
});

test('SECURITY: the risk layer has no write capability at all', () => {
  const riskModules = modulesUnder('risk');
  const writeCalls = ['createOrder', 'batchCreateOrders', 'amendOrder', 'cancelOrder', 'cancelAllOrders'];

  for (const file of riskModules) {
    const text = source(file);
    const rel = relative(projectRoot, file);
    for (const banned of writeCalls) {
      assert.ok(!text.includes(banned), `${rel} must not reference the write operation "${banned}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// The trading core must not reach the operational scripts
// ---------------------------------------------------------------------------
test('SECURITY: no src module imports the operational scripts', () => {
  const scripts = ['earn_to_trading', 'inspect_accounts', 'verify_bybit_key', 'list_tools', 'test_mcp_proxy'];

  for (const file of allModules) {
    const rel = relative(projectRoot, file);
    for (const spec of importSpecifiers(file)) {
      for (const script of scripts) {
        assert.ok(!spec.includes(script), `${rel} must not import the operational script "${script}"`);
      }
    }
  }
});

test('SECURITY: no src module references transfer, withdrawal or deposit endpoints', () => {
  const banned = [
    'inter-transfer',
    'universal-transfer',
    'withdraw',
    'deposit',
    'queryWithdraw',
    'asset/transfer',
    'place-order', // Earn staking/redeeming also moves money
  ];

  for (const file of allModules) {
    const text = source(file).toLowerCase();
    const rel = relative(projectRoot, file);
    for (const token of banned) {
      assert.ok(
        !text.includes(token.toLowerCase()),
        `${rel} must not reference money-movement token "${token}"`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// No live trading calls anywhere in the core
// ---------------------------------------------------------------------------
test('SECURITY: the core never calls Bybit trading endpoints', () => {
  const endpointTokens = [
    '/v5/order/create',
    '/v5/order/amend',
    '/v5/order/cancel',
    '/v5/position/set-leverage',
    '/v5/position/trading-stop',
    '/v5/account/set-margin-mode',
    '/v5/position/switch-mode',
    '/v5/position/set-auto-add-margin',
    '/v5/position/set-trading-stop',
  ];

  for (const file of allModules) {
    const text = source(file);
    const rel = relative(projectRoot, file);
    for (const endpoint of endpointTokens) {
      assert.ok(!text.includes(endpoint), `${rel} must not call the trading endpoint ${endpoint}`);
    }
  }
});

test('SECURITY: the core has no Bybit client dependency', () => {
  for (const file of allModules) {
    const rel = relative(projectRoot, file);
    for (const spec of importSpecifiers(file)) {
      assert.ok(!/bybit-official-trading-server/.test(spec), `${rel} must not import the Bybit MCP server`);
      assert.ok(!/^bybit-api/.test(spec), `${rel} must not import a Bybit SDK`);
    }
  }
});

test('SECURITY: live execution is disabled by construction', async () => {
  const { LIVE_EXECUTION_IMPLEMENTED, checkLiveExecution, assertLiveExecutionAllowed } = await import(
    '../src/execution/live-guard.mjs'
  );

  assert.equal(LIVE_EXECUTION_IMPLEMENTED, false, 'Stage 1 must not implement live execution');

  const decision = checkLiveExecution({
    tradingMode: 'LIVE',
    liveTradingAllowed: true,
    acknowledgedLiveRisk: true,
  });
  assert.equal(decision.allowed, false, 'live execution must be refused even with every opt-in set');

  assert.throws(() => assertLiveExecutionAllowed({ tradingMode: 'LIVE', liveTradingAllowed: true }));
});

// ---------------------------------------------------------------------------
// Secrets must never be logged
// ---------------------------------------------------------------------------
test('SECURITY: the logger redacts secret-looking fields', async () => {
  const { redact } = await import('../src/util/logger.mjs');

  const redacted = redact({
    BYBIT_API_KEY: 'super-secret-key-value',
    apiSecret: 'super-secret-secret-value',
    authorization: 'Bearer abcdef',
    password: 'hunter2',
    token: 'xyz',
    privateKey: 'pem',
    symbol: 'BTCUSDT',
    nested: { api_key: 'nested-secret', keep: 1 },
  });

  const serialized = JSON.stringify(redacted);
  for (const secret of [
    'super-secret-key-value',
    'super-secret-secret-value',
    'Bearer abcdef',
    'hunter2',
    'xyz',
    'pem',
    'nested-secret',
  ]) {
    assert.ok(!serialized.includes(secret), `redaction leaked "${secret}"`);
  }
  assert.equal(redacted.symbol, 'BTCUSDT', 'non-secret fields must survive redaction');
  assert.equal(redacted.nested.keep, 1);
});

test('SECURITY: config description never contains secret material', async () => {
  const { loadConfig, describeConfig } = await import('../src/config/env.mjs');

  const config = loadConfig({
    BYBIT_API_KEY: 'LEAK-CANARY-KEY',
    BYBIT_API_SECRET: 'LEAK-CANARY-SECRET',
    TRADING_MODE: 'PAPER',
  });

  const serialized = JSON.stringify(describeConfig(config));
  assert.ok(!serialized.includes('LEAK-CANARY-KEY'), 'API key leaked through describeConfig');
  assert.ok(!serialized.includes('LEAK-CANARY-SECRET'), 'API secret leaked through describeConfig');
});

test('SECURITY: the trading core does not read BYBIT_API_KEY / BYBIT_API_SECRET at all', () => {
  // Stage 2 requirement: PAPER must run with no credentials present, so no
  // module on the trading path may even name these variables.
  const allowed = ['src/config/env.mjs'];

  for (const file of allModules) {
    const rel = relative(projectRoot, file);
    if (allowed.includes(rel)) continue;
    const text = source(file);
    assert.ok(
      !text.includes('BYBIT_API_KEY') && !text.includes('BYBIT_API_SECRET'),
      `${rel} must not reference exchange credentials — they are not needed by the trading core`,
    );
  }
});

test('SECURITY: loadConfig loads without any credentials in the environment', async () => {
  const { loadConfig } = await import('../src/config/env.mjs');

  // A completely credential-free environment must still produce a working
  // PAPER configuration.
  const config = loadConfig({ TRADING_MODE: 'PAPER' });
  assert.equal(config.tradingMode, 'PAPER');
  assert.equal(config.credentials.hasApiKey, false);
  assert.equal(config.credentials.hasApiSecret, false);
  assert.ok(config.paper.initialEquityUsd > 0);
});

test('SECURITY: only the config layer reads process.env', () => {
  const configModules = modulesUnder('config').map((f) => relative(projectRoot, f));
  assert.ok(configModules.length > 0);

  for (const file of allModules) {
    const rel = relative(projectRoot, file);
    if (configModules.includes(rel)) continue;
    const text = source(file);
    const readsEnv = /process\.env/.test(text);
    assert.ok(!readsEnv, `${rel} must not read process.env — configuration belongs to the config layer`);
  }
});

test('SECURITY: only the storage layer writes files, and never inside the trading core', () => {
  // Stage 2 added persistence, so the blanket file-write ban is narrowed rather
  // than dropped: exactly one module owns disk I/O, and the trading logic
  // (risk, execution, market, domain, session) still cannot write anything.
  const allowedStorageModules = ['src/state/jsonl-file.mjs'];
  const banned = ['writeFileSync', 'appendFileSync', 'child_process', 'execSync', 'spawnSync'];

  for (const file of allModules) {
    const text = source(file);
    const rel = relative(projectRoot, file);
    if (allowedStorageModules.includes(rel)) continue;
    for (const token of banned) {
      assert.ok(!text.includes(token), `${rel} must not contain "${token}"`);
    }
  }

  // Any other module that writes to disk must go through the storage layer.
  for (const file of allModules) {
    const rel = relative(projectRoot, file);
    if (allowedStorageModules.includes(rel)) continue;
    const text = source(file);
    assert.ok(
      !/writeFile\(|appendFile\(/.test(text),
      `${rel} must not call writeFile/appendFile directly — route disk I/O through src/state/jsonl-file.mjs`,
    );
  }
});

test('SECURITY: the paper execution layer cannot import a Bybit write client', () => {
  const executionModules = modulesUnder('execution');
  assert.ok(executionModules.length > 0);

  const forbidden = [
    'bybit-official-trading-server',
    'bybit-api',
    '@modelcontextprotocol',
    'node:http',
    'node:https',
    'openai',
    'deepseek',
    'anthropic',
  ];

  for (const file of executionModules) {
    const rel = relative(projectRoot, file);
    const text = source(file);
    for (const spec of importSpecifiers(file)) {
      for (const banned of forbidden) {
        assert.ok(
          !spec.toLowerCase().includes(banned),
          `${rel} must not import "${spec}" (matched "${banned}") — the paper executor is local-only`,
        );
      }
    }
    // The forbidden write operations may only be *named* in the module that
    // declares them as forbidden.
    if (!rel.endsWith('execution-adapter.mjs')) {
      for (const operation of [
        'createOrder',
        'batchCreateOrders',
        'amendOrder',
        'cancelOrder',
        'cancelAllOrders',
        'setLeverage',
        'setMarginMode',
        'setTradingStop',
      ]) {
        assert.ok(
          !new RegExp(`\\b${operation}\\s*\\(`).test(text),
          `${rel} must not call the exchange write operation "${operation}"`,
        );
      }
    }
  }
});

test('SECURITY: the market layer holds no credentials and only reads', () => {
  for (const file of modulesUnder('market')) {
    const rel = relative(projectRoot, file);
    const text = source(file);

    assert.ok(!text.includes('loadExchangeCredentials'), `${rel} must not load exchange credentials`);
    assert.ok(!/Authorization|X-BAPI|signature/i.test(text), `${rel} must not build authenticated requests`);

    // Every outbound request in this layer must be a GET to a public endpoint.
    const verbMatches = text.match(/method:\s*'([A-Z]+)'/g) ?? [];
    for (const match of verbMatches) {
      assert.ok(match.includes('GET'), `${rel} must only issue GET requests, found ${match}`);
    }
  }
});

test('SECURITY: no module on the trading path reaches an AI provider', () => {
  // Checked against imports rather than raw text, so prose in a comment (such as
  // "JSON/LLM payloads") is not mistaken for a dependency on a model provider.
  const banned = ['openai', 'deepseek', 'anthropic', 'gemini', '@google/generative', 'langchain', 'transformers'];

  for (const file of allModules) {
    const rel = relative(projectRoot, file);
    for (const spec of importSpecifiers(file)) {
      for (const token of banned) {
        assert.ok(
          !spec.toLowerCase().includes(token),
          `${rel} must not import "${spec}" (matched "${token}") — no AI in this stage`,
        );
      }
    }
  }

  // No network client may be imported anywhere in the core either, AI or not.
  for (const file of allModules) {
    const rel = relative(projectRoot, file);
    for (const spec of importSpecifiers(file)) {
      assert.ok(
        !['node:http', 'node:https', 'axios', 'node-fetch', 'undici'].some((lib) => spec.includes(lib)),
        `${rel} must not import the network client "${spec}"`,
      );
    }
  }
});

test('SECURITY: the module inventory is exactly what Stage 2 intends', () => {
  const inventory = allModules.map((f) => relative(projectRoot, f)).sort();

  // Recorded explicitly so an unexpected new module shows up in review.
  const expected = [
    'src/config/config-error.mjs',
    'src/config/env.mjs',
    'src/config/paper.mjs',
    'src/config/parse.mjs',
    'src/config/risk.mjs',
    'src/config/trading-mode.mjs',
    'src/domain/account-state.mjs',
    'src/domain/index.mjs',
    'src/domain/market-state.mjs',
    'src/domain/proposal.mjs',
    'src/domain/reason-code.mjs',
    'src/domain/risk-result.mjs',
    'src/domain/side.mjs',
    'src/execution/execution-adapter.mjs',
    'src/execution/index.mjs',
    'src/execution/live-guard.mjs',
    'src/execution/paper-execution-adapter.mjs',
    'src/index.mjs',
    'src/market/index.mjs',
    'src/market/instrument-info.mjs',
    'src/market/market-data-adapter.mjs',
    'src/market/market-snapshot.mjs',
    'src/market/normalize.mjs',
    'src/market/rest-market-data-adapter.mjs',
    'src/market/static-market-data-adapter.mjs',
    'src/risk/position-sizing.mjs',
    'src/risk/risk-engine.mjs',
    'src/session/index.mjs',
    'src/session/paper-session.mjs',
    'src/state/daily-state.mjs',
    'src/state/fee-model.mjs',
    'src/state/index.mjs',
    'src/state/journal.mjs',
    'src/state/jsonl-file.mjs',
    'src/state/paper-account.mjs',
    'src/state/paper-position.mjs',
    'src/state/state-store.mjs',
    'src/util/logger.mjs',
  ].sort();

  assert.deepEqual(inventory, expected, 'the src module set changed — review for boundary violations');
});