#!/usr/bin/env node
/**
 * One-shot Codex connectivity check — the *only* script in this repository that
 * intentionally performs real subscription-backed inference.
 *
 * It is deliberately NOT part of `npm test`: the suite must stay hermetic, and a
 * real call consumes the owner's ChatGPT/Codex allowance. Run it by hand, once,
 * after configuring the environment:
 *
 *   AI_CODEX_ENABLED=true npm run codex:check -- --yes
 *
 * What it does:
 *   1. loads the same configuration the provider uses (AI_CODEX_* variables);
 *   2. builds the real CLI transport and the real Codex provider;
 *   3. sends ONE analysis prompt derived from a synthetic, obviously fake market
 *      context (fixed prices, no network, no account, no order);
 *   4. prints the outcome status, model, duration and token usage.
 *
 * What it cannot do: place an order, read a credential, read an exchange, or run
 * a trading decision. There is no exchange module anywhere in this path.
 */
import { loadCodexProviderConfig, CODEX_ROUTINE_MODEL } from '../src/config/codex.mjs';
import { createCodexCliTransport, createCodexProvider } from '../src/providers/codex/index.mjs';

const argv = process.argv.slice(2);
if (!argv.includes('--yes')) {
  process.stderr.write(
    'Refusing to spend subscription usage without confirmation.\n' +
      'Re-run with --yes:  AI_CODEX_ENABLED=true npm run codex:check -- --yes\n',
  );
  process.exit(2);
}

const config = loadCodexProviderConfig(process.env);
if (!config.enabled) {
  process.stderr.write(
    'Codex provider is disabled (AI_CODEX_ENABLED is not true). Set it explicitly for this one command:\n' +
      '  AI_CODEX_ENABLED=true npm run codex:check -- --yes\n',
  );
  process.exit(2);
}
const transport = createCodexCliTransport({
  command: config.command,
  timeoutMs: config.timeoutMs,
  maxCallsPerHour: config.maxCallsPerHour,
  env: config.childEnv,
  allowedModels: [config.model],
});
const provider = createCodexProvider({
  model: config.model ?? CODEX_ROUTINE_MODEL,
  transport,
  operation: 'ANALYZE',
  astraOperations: config.astraOperations,
});

// A synthetic context: fixed numbers, no real account, no real market feed.
const context = Object.freeze({
  schemaVersion: '1',
  generatedAt: Date.now(),
  market: Object.freeze({
    symbol: 'BTCUSDT',
    timeframe: '15',
    lastPrice: 100,
    bid: 99.9,
    ask: 100.1,
    candles: Object.freeze([]),
    indicators: Object.freeze({ smaFast: 100, smaSlow: 100.5, atr: 1 }),
  }),
  position: null,
  portfolio: null,
  strategy: null,
  risk: null,
});

const startedAt = Date.now();
const outcome = await provider.analyze(context);
const durationMs = Date.now() - startedAt;

process.stdout.write(
  `${JSON.stringify(
    {
      provider: provider.id,
      modelId: provider.modelId,
      status: outcome.status,
      ok: outcome.ok,
      bias: outcome.analysis?.bias ?? null,
      confidence: outcome.analysis?.confidence ?? null,
      issues: outcome.issues,
      promptVersion: outcome.promptVersion,
      durationMs,
      transport: transport.stats(),
    },
    null,
    2,
  )}\n`,
);

process.exit(outcome.ok ? 0 : 1);
