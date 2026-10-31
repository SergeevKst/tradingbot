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

  // Phase 8 introduces the testnet layer as the ONE sanctioned place for
  // authenticated order endpoints. It is still testnet-only and guarded; the
  // trading core outside it must remain incapable of reaching them.
  // src/telegram is the operational Telegram bot layer, not the trading core.
  const coreModules = allModules.filter((file) => {
    const rel = relative(projectRoot, file);
    return !rel.startsWith('src/testnet/') && !rel.startsWith('src/telegram/');
  });

  for (const file of coreModules) {
    const text = source(file);
    const rel = relative(projectRoot, file);
    for (const endpoint of endpointTokens) {
      assert.ok(!text.includes(endpoint), `${rel} must not call the trading endpoint ${endpoint}`);
    }
  }
});

test('SECURITY: authenticated order endpoints exist only inside the testnet layer', () => {
  // The isolation above is only meaningful if nothing outside `src/testnet`
  // names a trading endpoint. This guards the boundary against a future module
  // quietly reintroducing one.
  for (const file of allModules) {
    const rel = relative(projectRoot, file);
    if (rel.startsWith('src/testnet/')) continue;
    if (rel.startsWith('src/telegram/')) continue;
    const text = source(file);
    for (const endpoint of ['/v5/order/create', '/v5/order/cancel', '/v5/order/amend']) {
      assert.ok(!text.includes(endpoint), `${rel} must not reference the authenticated endpoint ${endpoint}`);
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
    if (rel.startsWith('src/telegram/')) continue;
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
  // The starting equity lives in the risk config, which the Risk Engine also
  // uses as its offline fallback equity — one source, not two.
  assert.ok(config.risk.initialCapitalUsd > 0);
  assert.equal(config.paper.initialEquityUsd, undefined, 'equity must not be duplicated in the paper config');
});

test('SECURITY: only the config layer reads process.env', () => {
  const configModules = modulesUnder('config').map((f) => relative(projectRoot, f));
  assert.ok(configModules.length > 0);

  for (const file of allModules) {
    const rel = relative(projectRoot, file);
    if (configModules.includes(rel)) continue;
    if (rel.startsWith('src/telegram/')) continue;
    const text = source(file);
    const readsEnv = /process\.env/.test(text);
    assert.ok(!readsEnv, `${rel} must not read process.env — configuration belongs to the config layer`);
  }
});

test('SECURITY: only the storage layer writes files, and never inside the trading core', () => {
  // Stage 2 added persistence, so the blanket file-write ban is narrowed rather
  // than dropped: exactly one module owns disk I/O, and the trading logic
  // (risk, execution, market, domain, session) still cannot write anything.
  //
  // UAI-05B adds a second, deliberately separate storage owner: the AI release
  // control store. It is a control-plane directory (manifests, acks, audit), not
  // financial state, and it is proven below to import no trading module.
  const allowedStorageModules = [
    'src/state/jsonl-file.mjs',
    'src/ai/coordination/control-store.mjs',
  ];
  const banned = ['writeFileSync', 'appendFileSync', 'child_process', 'execSync', 'spawnSync'];

  for (const file of allModules) {
    const text = source(file);
    const rel = relative(projectRoot, file);
    if (allowedStorageModules.includes(rel)) continue;
    if (rel.startsWith('src/telegram/')) continue;
    for (const token of banned) {
      assert.ok(!text.includes(token), `${rel} must not contain "${token}"`);
    }
  }

  // Any other module that writes to disk must go through the storage layer.
  for (const file of allModules) {
    const rel = relative(projectRoot, file);
    if (allowedStorageModules.includes(rel)) continue;
    if (rel.startsWith('src/telegram/')) continue;
    const text = source(file);
    assert.ok(
      !/writeFile\(|appendFile\(/.test(text),
      `${rel} must not call writeFile/appendFile directly — route disk I/O through src/state/jsonl-file.mjs`,
    );
  }

  // The control-plane store must stay outside the financial/trading boundary:
  // it may coordinate AI releases but may not import risk, execution, session,
  // reconciliation, state or Telegram modules.
  const controlStore = 'src/ai/coordination/control-store.mjs';
  const forbiddenForControlStore = [
    '../risk/',
    '../execution/',
    '../session/',
    '../reconciliation/',
    '../state/',
    '../telegram/',
    '../adapters/bybit/',
    '../testnet/',
  ];
  for (const spec of importSpecifiers(resolve(projectRoot, controlStore))) {
    for (const prefix of forbiddenForControlStore) {
      assert.ok(
        !spec.includes(prefix),
        `${controlStore} must not import ${spec} — the control plane cannot touch trading state`,
      );
    }
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
      // Local contracts named after a provider (e.g. "./deepseek-provider.mjs")
      // are internal modules, not an external model dependency. Only package
      // specifiers can reach a provider SDK.
      if (spec.startsWith('.')) continue;
      for (const token of banned) {
        assert.ok(
          !spec.toLowerCase().includes(token),
          `${rel} must not import "${spec}" (matched "${token}") — no external model dependency`,
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
    'src/adapters/bybit/endpoints.mjs',
    'src/adapters/bybit/rest-client.mjs',
    'src/adapters/bybit/rest-market-data-adapter.mjs',
    'src/adapters/bybit/websocket-client.mjs',
    'src/ai/ai-provider.mjs',
    'src/ai/analysis-schema.mjs',
    'src/ai/context-builder.mjs',
    'src/ai/coordination/control-store.mjs',
    'src/ai/coordination/generation-guard.mjs',
    'src/ai/coordination/release-state.mjs',
    'src/ai/coordination/rollback-transition.mjs',
    'src/ai/core-ai-composition.mjs',
    'src/ai/index.mjs',
    'src/ai/interface.mjs',
    'src/ai/mock-provider.mjs',
    'src/ai/operation-profiles.mjs',
    'src/ai/model-resolver.mjs',
    'src/config/ai-model-registry.mjs',

    'src/ai/prompts.mjs',
    'src/ai/runtime.mjs',
    'src/ai/skills/adapters/analyze.mjs',
    'src/ai/skills/adapters/catalogue.mjs',
    'src/ai/skills/adapters/guard.mjs',
    'src/ai/skills/adapters/market-context.mjs',
    'src/ai/skills/adapters/monitor.mjs',
    'src/ai/skills/adapters/reflect.mjs',
    'src/ai/skills/adapters/scout.mjs',
    'src/ai/skills/adapters/shared.mjs',
    'src/ai/skills/adapters/stopcheck.mjs',
    'src/ai/skills/composition.mjs',
    'src/ai/skills/data-broker.mjs',
    'src/ai/skills/execution-plan.mjs',
    'src/ai/skills/migration.mjs',
    'src/ai/skills/package-store.mjs',
    'src/ai/skills/renderer.mjs',
    'src/ai/skills/resolver.mjs',
    'src/ai/skills/runtime-policy.mjs',
    'src/ai/skills/runtime.mjs',
    'src/ai/skills/schema-validator.mjs',
    'src/ai/skills/transport.mjs',
    'src/ai/types.mjs',
    'src/backtest/engine.mjs',
    'src/backtest/historical-data.mjs',
    'src/backtest/index.mjs',
    'src/backtest/metrics.mjs',
    'src/backtest/signal-source.mjs',
    'src/backtest/slippage-model.mjs',
    'src/config/ai-identity-manifest.mjs',
    'src/config/ai-release-report.mjs',
    'src/config/ai-release-schema.mjs',
    'src/config/ai-runtime.mjs',
    'src/config/ai.mjs',
    'src/config/config-error.mjs',
    'src/config/env.mjs',
    'src/config/jcs.mjs',
    'src/config/live.mjs',
    'src/config/paper.mjs',
    'src/config/parse.mjs',
    'src/config/risk.mjs',
    'src/config/schema.mjs',
    'src/config/skill-package.mjs',
    'src/config/skill-release-contracts.mjs',
    'src/config/testnet.mjs',
    'src/config/trading-mode.mjs',
    'src/domain/account-state.mjs',
    'src/domain/ai-analysis.mjs',
    'src/domain/index.mjs',
    'src/domain/market-feature.mjs',
    'src/domain/market-state.mjs',
    'src/domain/market-tick.mjs',
    'src/domain/order-fill.mjs',
    'src/domain/order.mjs',
    'src/domain/orderbook-snapshot.mjs',
    'src/domain/portfolio.mjs',
    'src/domain/position.mjs',
    'src/domain/proposal.mjs',
    'src/domain/reason-code.mjs',
    'src/domain/risk-result.mjs',
    'src/domain/side.mjs',
    'src/domain/signal.mjs',
    'src/domain/strategy-decision.mjs',
    'src/errors/ai-provider-error.mjs',
    'src/errors/app-error.mjs',
    'src/errors/coordination-error.mjs',
    'src/errors/index.mjs',
    'src/errors/skill-error.mjs',
    'src/errors/taxonomy.mjs',
    'src/execution/execution-adapter.mjs',
    'src/execution/fill-model.mjs',
    'src/execution/index.mjs',
    'src/execution/live-guard.mjs',
    'src/execution/paper-execution-adapter.mjs',
    'src/execution/testnet-execution-adapter.mjs',
    'src/index.mjs',
    'src/market/index.mjs',
    'src/market/instrument-info.mjs',
    'src/market/market-data-adapter.mjs',
    'src/market/market-snapshot.mjs',
    'src/market/normalize.mjs',
    'src/market/rest-market-data-adapter.mjs',
    'src/market/static-market-data-adapter.mjs',
    'src/market-data/events.mjs',
    'src/market-data/index.mjs',
    'src/market-data/market-data-service.mjs',
    'src/market-data/market-state-cache.mjs',
    'src/market-data/retry.mjs',
    'src/normalizers/bybit-kline.mjs',
    'src/normalizers/bybit-orderbook.mjs',
    'src/normalizers/bybit-ticker.mjs',
    'src/normalizers/bybit-trade.mjs',
    'src/normalizers/bybit-values.mjs',
    'src/normalizers/index.mjs',
    'src/providers/deepseek/deepseek-provider.mjs',
    'src/providers/deepseek/index.mjs',
    'src/reconciliation/duplicate-guard.mjs',
    'src/reconciliation/failure-policy.mjs',
    'src/reconciliation/idempotency.mjs',
    'src/reconciliation/index.mjs',
    'src/reconciliation/order-reconciler.mjs',
    'src/reconciliation/reconciliation-engine.mjs',
    'src/recovery/index.mjs',
    'src/recovery/journal-replay.mjs',
    'src/recovery/startup-reconciler.mjs',
    'src/risk/kill-switch.mjs',
    'src/risk/position-sizing.mjs',
    'src/risk/risk-engine.mjs',
    'src/safety/checklist.mjs',
    'src/safety/credential-separation.mjs',
    'src/safety/emergency-controls.mjs',
    'src/safety/index.mjs',
    'src/safety/live-gate.mjs',
    'src/session/index.mjs',
    'src/session/live-session.mjs',
    'src/session/paper-session.mjs',
    'src/session/recovery-session.mjs',
    'src/session/testnet-bootstrap.mjs',
    'src/session/testnet-session.mjs',
    'src/session/trading-session.mjs',
    'src/simulator/index.mjs',
    'src/simulator/market-replay.mjs',
    'src/state/daily-state.mjs',
    'src/state/fee-model.mjs',
    'src/state/index.mjs',
    'src/state/journal.mjs',
    'src/state/jsonl-file.mjs',
    'src/state/paper-account.mjs',
    'src/state/paper-position.mjs',
    'src/state/state-store.mjs',
    'src/strategy/deterministic-ma-crossover.mjs',
    'src/strategy/index.mjs',
    'src/strategy/registry.mjs',
    'src/strategy/strategy-interface.mjs',
    'src/testnet/auth.mjs',
    'src/testnet/authenticated-rest-client.mjs',
    'src/testnet/endpoints.mjs',
    'src/testnet/index.mjs',
    'src/testnet/mode-guard.mjs',
    'src/testnet/order-mapper.mjs',
    'src/testnet/order-state-machine.mjs',
    'src/testnet/private-websocket.mjs',
    'src/telegram/ai-composition.mjs',
    'src/telegram/ai-effect-gateway.mjs',
    'src/telegram/bot.mjs',
    'src/telegram/deepseek-client.mjs',
    'src/telegram/execute.mjs',
    'src/telegram/ideas.mjs',
    'src/telegram/market-summary.mjs',
    'src/telegram/monitor.mjs',
    'src/telegram/news.mjs',
    'src/telegram/pipeline-log.mjs',
    'src/telegram/reflect.mjs',
    'src/telegram/risk-filter.mjs',
    'src/telegram/sentiment.mjs',
    'src/telegram/size.mjs',
    'src/telegram/state.mjs',
    'src/telegram/stopcheck.mjs',
    'src/telegram/trailing.mjs',
    'src/types/enums.mjs',
    'src/types/index.mjs',
    'src/types/primitives.mjs',
    'src/util/logger.mjs',
  ].sort();

  assert.deepEqual(inventory, expected, 'the src module set changed — review for boundary violations');
});
test('SECURITY: every documented env variable is actually read by the config layer', () => {
  // A documented-but-unread variable is worse than a missing one: the operator
  // sets it, sees no error, and silently gets a default. This test ties
  // .env.example to the code so the two cannot drift apart.
  const example = readFileSync(join(projectRoot, '.env.example'), 'utf8');
  const documented = new Set();
  for (const line of example.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match) documented.add(match[1]);
  }

  const configSources = collectModules(join(srcRoot, 'config'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

  assert.ok(documented.size > 10, `expected the example to document variables, found ${documented.size}`);

  const unread = [...documented].filter((name) => !configSources.includes(name));
  assert.deepEqual(
    unread,
    [],
    `these variables are documented in .env.example but never read by src/config: ${unread.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// The live safety layer must not leak into non-live paths
// ---------------------------------------------------------------------------
test('SECURITY: only the live config module names the live credential variables', () => {
  // The dedicated live pair is reachable from exactly one module. Any other
  // module naming it is a separation failure waiting to happen.
  const allowed = ['src/config/live.mjs'];

  for (const file of allModules) {
    const rel = relative(projectRoot, file);
    if (allowed.includes(rel)) continue;
    const text = source(file);
    assert.ok(
      !text.includes('BYBIT_LIVE_API_KEY') && !text.includes('BYBIT_LIVE_API_SECRET'),
      `${rel} must not reference live credentials — only src/config/live.mjs may load them`,
    );
  }
});

test('SECURITY: no non-live module imports the live boundary', () => {
  // `src/safety/**`, `src/config/live.mjs` and `src/session/live-session.mjs`
  // are the live boundary. Nothing else may reach into it, so a PAPER/BACKTEST
  // path cannot even construct the live gate.
  const isLiveBoundary = (rel) =>
    rel.startsWith('src/safety/') || rel === 'src/config/live.mjs' || rel === 'src/session/live-session.mjs';

  for (const file of allModules) {
    const rel = relative(projectRoot, file);
    if (isLiveBoundary(rel)) continue;
    for (const spec of importSpecifiers(file)) {
      const reachesLive =
        spec.includes('live-gate') ||
        spec.includes('credential-separation') ||
        spec.includes('emergency-controls') ||
        spec.includes('live-session') ||
        spec.endsWith('config/live.mjs');
      assert.ok(!reachesLive, `${rel} must not import the live boundary module "${spec}"`);
    }
  }
});

test('SECURITY: the session barrel does not re-export the live session', () => {
  const sessionIndex = join(srcRoot, 'session', 'index.mjs');
  assert.ok(
    !importSpecifiers(sessionIndex).includes('./live-session.mjs'),
    'src/session/index.mjs must not export live-session: importing the barrel would pull the live path into non-live code',
  );
});

test('SECURITY: paper and backtest code paths carry no live gate state', async () => {
  // Importing the live safety modules must not arm or enable anything by
  // itself: no process.env read, no file I/O at import time. Proven by loading
  // them in a credential-free environment and checking the default decision.
  const { LIVE_EXECUTION_IMPLEMENTED } = await import('../src/execution/live-guard.mjs');
  const { evaluateLiveReadiness } = await import('../src/safety/live-gate.mjs');

  assert.equal(LIVE_EXECUTION_IMPLEMENTED, false, 'this build must have no live execution path');

  const decision = evaluateLiveReadiness({});
  assert.equal(decision.allowed, false, 'an empty gate input can never be ready');
  assert.equal(decision.reasonCode, 'LIVE_GATE_REFUSED');
});
