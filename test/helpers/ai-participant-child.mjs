#!/usr/bin/env node
/**
 * Cross-process participant helper (UAI-06C).
 *
 * A real, separately spawned Node process that imports the *production*
 * composition seams (core composition / Telegram composition), shares only a
 * temporary control directory, and exposes a small JSON-over-IPC command set for
 * deterministic orchestration by the parent test.
 *
 * It never imports a bot entrypoint, never polls Telegram, never touches a real
 * provider or exchange, and denies external network by replacing `fetch`.
 *
 * Trace records (JSONL) are the evidence the parent verifies: they contain no
 * secrets, only slot/instance/generation/dispatch/effect metadata.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createControlStore } from '../../src/ai/coordination/control-store.mjs';
import { createCoreAIComposition } from '../../src/ai/core-ai-composition.mjs';
import { createTelegramAIComposition } from '../../src/telegram/ai-composition.mjs';
import { createAIEffectGateway } from '../../src/telegram/ai-effect-gateway.mjs';
import { validateObserverIdentity } from '../../src/ai/coordination/generation-guard.mjs';
import { createDeepSeekChat } from '../../src/telegram/deepseek-client.mjs';
import { createReflector } from '../../src/telegram/reflect.mjs';

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write('missing config path\n');
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

/** @param {object} record */
function emit(record) {
  fs.appendFileSync(config.trace, `${JSON.stringify({ ...record, at: Date.now(), pid: process.pid })}\n`);
}

// No external network in a conformance run, ever.
globalThis.fetch = async () => {
  throw new Error('external network is denied in the conformance harness');
};

/** @type {{ promise: Promise<void>, resolve: () => void } | null} */
let gate = null;
function holdGate() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  gate = { promise, resolve };
  return gate;
}
function releaseGate() {
  if (gate) gate.resolve();
  gate = null;
}

const RESPONSES = Object.freeze({
  SCOUT: JSON.stringify({
    ideas: [{ symbol: 'BTCUSDT', side: 'LONG', entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'trend up' }],
  }),
  GUARD: JSON.stringify({ verdict: 'APPROVED', confidence: 0.8, reasons: ['aligned'] }),
  MONITOR: JSON.stringify({ action: 'HOLD', reason: 'trend intact', confidence: 0.6 }),
  STOPCHECK: JSON.stringify({ action: 'HOLD', reason: 'noise', confidence: 0.4 }),
  REFLECT: JSON.stringify({ lesson: 'lesson', proposedRule: '', severity: 'low', matchedExistingRule: true }),
  ANALYZE: JSON.stringify({ bias: 'BULLISH', confidence: 0.7, rationale: 'trend' }),
});

/**
 * A transport that records the exact serialized request and returns a canned
 * response. `hold` makes it wait for the parent's release command.
 */
function recordingFetch() {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const operation = detectOperation(url, body);
    emit({ event: 'provider-request', operation, url, model: body?.model ?? null, temperature: body?.temperature ?? null, messageCount: body?.messages?.length ?? 0 });
    if (gate) await gate.promise;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: RESPONSES[operation] ?? RESPONSES.GUARD } }],
        usage: { prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 1 },
      }),
    };
  };
}

/**
 * @param {string} url
 * @param {any} body
 */
function detectOperation(url, body) {
  const system = body?.messages?.[0]?.content ?? '';
  if (/trade ideas/i.test(system) || /scout/i.test(system)) return 'SCOUT';
  if (/stop-check|stopcheck/i.test(system)) return 'STOPCHECK';
  if (/monitor/i.test(system)) return 'MONITOR';
  if (/closed trade/i.test(system)) return 'REFLECT';
  if (/adversar|guard/i.test(system)) return 'GUARD';
  if (/analysis|analyst/i.test(system)) return 'ANALYZE';
  return 'GUARD';
}

const store = createControlStore({ controlDir: config.controlDir });
const runtimeConfig = {
  mode: 'single',
  controlDir: config.controlDir,
  deploymentId: config.deploymentId,
  slot: config.slot,
  expectedManifestVersion: config.expectedManifestVersion,
  expectedManifestSha256: config.expectedManifestSha256,
  artifactSha256: config.artifactSha256,
  hasApiKey: true,
};
const INSTANCE_ID = config.instanceId ?? randomUUID();
const transportDeps = {
  apiKeyLoader: () => 'fake-secret-sentinel',
  fetchImpl: recordingFetch(),
  createChatClient: (options) => {
    // Use the real facade with the recording transport so the captured request
    // body is exactly what production would serialize.
    const realFetch = globalThis.fetch;
    globalThis.fetch = recordingFetch();
    try {
      return createDeepSeekChat(options);
    } finally {
      globalThis.fetch = realFetch;
    }
  },
  createReflector: (options) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = recordingFetch();
    try {
      return createReflector(options);
    } finally {
      globalThis.fetch = realFetch;
    }
  },
};

/** @type {any} */
let ai = null;
/** @type {any} */
let gateway = null;
let protectionTicks = 0;
/** @type {any} */
let whereHeldAnalysis = null;

function start() {
  if (config.role === 'core') {
    ai = createCoreAIComposition({
      config: runtimeConfig,
      controlStore: store,
      artifactIdentity: { artifactSha256: config.artifactSha256 },
      transportDependencies: transportDeps,
      instanceId: INSTANCE_ID,
    });
  } else if (config.role === 'telegram') {
    ai = createTelegramAIComposition({
      config: runtimeConfig,
      controlStore: store,
      artifactIdentity: { artifactSha256: config.artifactSha256 },
      transportDependencies: transportDeps,
      instanceId: INSTANCE_ID,
    });
    // The same gateway `bot.mjs` uses: every AI-derived exchange write in this
    // process goes through it.
    gateway = createAIEffectGateway({
      composition: ai,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
  } else if (config.role === 'observer') {
    return validateObserverIdentity({
      controlStore: store,
      deploymentId: config.deploymentId,
      expectedManifestVersion: config.expectedManifestVersion,
      expectedManifestSha256: config.expectedManifestSha256,
      artifactSha256: config.artifactSha256,
      observerId: config.observerId ?? 'core-bootstrap',
      transitionId: config.transitionId ?? null,
    });
  } else {
    throw new Error(`unknown role ${config.role}`);
  }
  const status = ai.start();
  emit({ event: 'start', role: config.role, slot: config.slot, instanceId: INSTANCE_ID, status });
  return status;
}

/** @type {Map<string, Promise<any>>} */
const pendingOperations = new Map();

async function handle(command) {
  switch (command.cmd) {
    case 'start':
      return start();
    case 'status':
      return ai ? ai.status() : { identityReady: false };
    case 'analyze': {
      const outcome = await ai.analyze({
        schemaVersion: '1',
        generatedAt: Date.now(),
        market: { symbol: 'BTCUSDT' },
        position: null,
        portfolio: null,
        strategy: null,
        risk: null,
      });
      emit({ event: 'dispatch', operation: 'ANALYZE', ok: outcome.ok, status: outcome.status });
      return { ok: outcome.ok, status: outcome.status, issues: outcome.issues };
    }
    case 'scout': {
      const client = ai.getChatClient();
      const result = await client.generateIdeas({ symbols: [{ symbol: 'BTCUSDT' }] });
      emit({ event: 'dispatch', operation: 'SCOUT', ok: result.parsed.ok });
      return { ok: result.parsed.ok, ideas: result.parsed.ideas.length, promptVersion: result.prompt.version };
    }
    case 'guard': {
      const client = ai.getChatClient();
      const result = await client.filterIdea({ symbol: 'BTCUSDT', side: 'LONG', entry: 100 }, { markPrice: 100 }, {});
      emit({ event: 'dispatch', operation: 'GUARD', ok: result.parsed.ok });
      return { ok: result.parsed.ok, verdict: result.parsed.value?.verdict ?? null };
    }
    case 'monitor': {
      const client = ai.getChatClient();
      const raw = await client.completeMonitor({ system: 'monitor', user: 'x' });
      emit({ event: 'dispatch', operation: 'MONITOR' });
      return { raw };
    }
    case 'stopcheck': {
      const client = ai.getChatClient();
      const raw = await client.completeStopcheck({ system: 'stopcheck', user: 'x' });
      emit({ event: 'dispatch', operation: 'STOPCHECK' });
      return { raw };
    }
    case 'reflect': {
      const trade = { symbol: 'BTCUSDT', side: 'LONG', entry: 100, exit: 101, pnlUsd: 1, reason: 'tp', exitCause: 'target' };
      const result = await ai.reflect(trade);
      emit({ event: 'dispatch', operation: 'REFLECT', appended: result !== null });
      return { reflected: result !== null, lesson: result?.lesson ?? null };
    }
    case 'hold-next':
      holdGate();
      return { holding: true };
    case 'release':
      releaseGate();
      return { released: true };
    case 'guarded-effect-async': {
      // Start a counted workflow that performs a transport call and then an
      // effect; the parent can interleave a transition while it is in flight.
      if (config.role !== 'telegram') throw new Error('guarded-effect-async is a Telegram-participant command');
      const key = command.opId ?? 'effect';
      const client = ai.getChatClient();
      const promise = (async () => {
        await ai.runInWorkflow(command.operation ?? 'GUARD', async () => {
          await client.filterIdea({ symbol: 'BTCUSDT', side: 'LONG', entry: 100 }, { markPrice: 100 }, {});
          await ai.runEffect(async () => {
            emit({ event: 'effect', label: command.label ?? key });
          });
        });
        return { effected: true };
      })();
      pendingOperations.set(key, promise);
      emit({ event: 'operation-started', operation: 'GUARD', key });
      return { started: true, key };
    }
    case 'await-operation': {
      const promise = pendingOperations.get(command.opId ?? 'effect');
      if (!promise) throw new Error(`no pending operation ${command.opId}`);
      try {
        const result = await promise;
        pendingOperations.delete(command.opId ?? 'effect');
        return { ok: true, result };
      } catch (error) {
        pendingOperations.delete(command.opId ?? 'effect');
        return { ok: false, error: { code: error?.code ?? 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
      }
    }
    case 'hold-analysis-async': {
      holdGate();
      const promise = ai.analyzeWithProvenance({
        schemaVersion: '1',
        generatedAt: Date.now(),
        market: { symbol: 'BTCUSDT' },
        position: null,
        portfolio: null,
        strategy: null,
        risk: null,
      });
      pendingOperations.set('analysis', promise);
      emit({ event: 'operation-started', operation: 'ANALYZE', key: 'analysis' });
      return { started: true };
    }
    case 'await-analysis': {
      const promise = pendingOperations.get('analysis');
      if (!promise) throw new Error('no pending analysis');
      try {
        const held = await promise;
        pendingOperations.delete('analysis');
        const result = {
          ok: held.outcome.ok,
          status: held.outcome.status,
          issues: held.outcome.issues,
          provenance: held.provenance,
          outstandingWork: ai.guard.status().outstandingWork,
          settle: null,
        };
        whereHeldAnalysis = held;
        return result;
      } catch (error) {
        pendingOperations.delete('analysis');
        return { ok: false, error: { code: error?.code ?? 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
      }
    }
    case 'settle-analysis': {
      if (whereHeldAnalysis) whereHeldAnalysis.settle();
      whereHeldAnalysis = null;
      return { settled: true, outstandingWork: ai.guard.status().outstandingWork };
    }
    case 'ack':
      return ai.acknowledgeQuiesced();
    case 'prepare':
      return ai.prepareTarget(command.grant ?? null);
    case 'poll':
      return ai.poll();
    case 'register-approval':
      return ai.registerPendingApproval(command.approvalId, { operation: command.operation ?? 'GUARD' });
    case 'consume-approval': {
      const scope = ai.beginApprovalConsumption(command.approvalId);
      emit({ event: 'approval-consumed', approvalId: command.approvalId });
      scope.settle();
      return { consumed: true };
    }
    case 'drop-approval':
      return { dropped: ai.dropPendingApproval(command.approvalId) };
    case 'pending-count':
      return { pending: ai.pendingApprovalCount() };

    // --- bot-shape effect commands (the real gateway seam) ------------------
    //
    // `prepare-entry`: the /trade approve tap — consume the analysis sidecar and
    //  hand it to the preview ticket as a pending effect.
    case 'prepare-entry': {
      if (gateway === null) throw new Error('prepare-entry is a Telegram-participant command');
      ai.registerPendingApproval(command.cardId ?? 'batch:0', { operation: 'GUARD' });
      const analysis = gateway.consume(command.cardId ?? 'batch:0');
      const held = gateway.hold(command.ticket ?? 'effect:pv-1', analysis, { operation: 'GUARD', purpose: 'entry' });
      emit({ event: 'effect-held', ticket: command.ticket ?? 'effect:pv-1', generation: held.generation });
      return {
        held: true,
        generation: held.generation,
        pending: ai.pendingApprovalCount(),
        outstandingWork: ai.guard.status().outstandingWork,
      };
    }
    // `entry-dispatch`: the exec tap — consume the ticket provenance, then run
    // the real plan shape: preparation (the price/leverage work) inside the
    // counted scope, the control read, then the write. The effect dereferences
    // what preparation produced, exactly like `exec:` dereferences `spotQty`.
    case 'entry-dispatch': {
      if (gateway === null) throw new Error('entry-dispatch is a Telegram-participant command');
      const key = command.opId ?? 'entry';
      const promise = (async () => {
        const handle = gateway.consume(command.ticket ?? 'effect:pv-1');
        emit({ event: 'ticket-consumed', ticket: command.ticket ?? 'effect:pv-1', workId: handle.token.id });
        if (command.hold === true) await holdGate().promise;
        /** @type {string | null} */
        let spotQty = null;
        return gateway.dispatch(handle, {
          lane: 'entry-linear',
          rearmAs: command.ticket ?? 'effect:pv-1',
          prepare: async () => {
            emit({ event: 'prepare', lane: 'entry-linear' });
            if (command.abort === true) return { abort: 'the market moved past the slippage threshold' };
            spotQty = '0.001';
            return {};
          },
          effect: async () => {
            emit({ event: 'effect', label: 'exchange-order', lane: 'entry-linear', qty: spotQty });
            if (spotQty === null) throw new Error('prepare did not run: the order would carry qty: null');
            return { orderId: 'fake-order-1', qty: spotQty };
          },
        });
      })();
      pendingOperations.set(key, promise);
      emit({ event: 'operation-started', operation: 'GUARD', key });
      return { started: true, key };
    }
    // `auto-close`: the stop-check path — one counted workflow from the model
    // response to the close dispatch, with the position resolved by `prepare`
    // inside that scope (the shape `stopcheck` uses for its close).
    case 'auto-close': {
      if (gateway === null) throw new Error('auto-close is a Telegram-participant command');
      const key = command.opId ?? 'auto-close';
      const promise = (async () => {
        const client = ai.getChatClient();
        await gateway.workflow('STOPCHECK', async (work) => {
          await client._completeGuard({ system: 'stop-check', user: 'position at a loss' });
          emit({ event: 'stopcheck-verdict', action: 'AUTO_CLOSE' });
          if (command.hold === true) await holdGate().promise;
          /** @type {{ side: string, size: string } | null} */
          let position = null;
          const outcome = await gateway.dispatchInScope(work, {
            lane: 'stopcheck-auto-close',
            prepare: async () => {
              emit({ event: 'prepare', lane: 'stopcheck-auto-close' });
              if (command.abort === true) return { abort: 'the position is already closed' };
              position = { side: 'LONG', size: '0.25' };
              return {};
            },
            effect: async () => {
              emit({ event: 'effect', label: 'exchange-close', lane: 'stopcheck-auto-close', qty: position?.size ?? null });
              if (position === null) throw new Error('prepare did not run: close has no position to close');
              return { orderId: 'fake-close-1', side: position.side, qty: position.size };
            },
          });
          return outcome;
        });
        return { closed: true };
      })();
      pendingOperations.set(key, promise);
      emit({ event: 'operation-started', operation: 'STOPCHECK', key });
      return { started: true, key };
    }
    // `release-effect`: let a held dispatch proceed (the human pressed the
    //  button / the prep finished).
    case 'release-effect':
      releaseGate();
      return { released: true };
    case 'unresolved-count':
      return { unresolved: ai.guard.status().unresolvedEffects };
    case 'protection-tick':
      protectionTicks += 1;
      emit({ event: 'protection', ticks: protectionTicks });
      return { ticks: protectionTicks };
    case 'protection-count':
      return { ticks: protectionTicks };
    case 'guard-status':
      return ai.guard.status();
    case 'crash':
      process.exit(command.code ?? 9);
      break;
    case 'exit':
      process.exit(0);
      break;
    default:
      throw new Error(`unknown command ${command.cmd}`);
  }
  return null;
}

process.on('message', async (message) => {
  try {
    const result = await handle(message);
    if (process.send) process.send({ id: message.id, ok: true, result });
  } catch (error) {
    if (process.send) {
      process.send({
        id: message.id,
        ok: false,
        error: { code: error?.code ?? 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
});

process.on('uncaughtException', (error) => {
  emit({ event: 'child-error', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  emit({ event: 'child-rejection', message: error instanceof Error ? error.message : String(error) });
});

if (process.send) process.send({ id: 0, ok: true, result: { ready: true, instanceId: INSTANCE_ID, pid: process.pid } });
