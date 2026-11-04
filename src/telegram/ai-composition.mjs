/**
 * Telegram AI composition (UAI-06B, architecture §3.1, §5–§7).
 *
 * One participant slot (`telegram`) binds all five Telegram AI roles —
 * SCOUT, GUARD, MONITOR, STOPCHECK, REFLECT — to one approved generation. The
 * existing chat facade from `deepseek-client.mjs` is retained, so prompt
 * building, parsing, callbacks and trade state are unchanged; this module only
 * wraps the transport in identity validation, admission and whole-work
 * accounting.
 *
 * Whole-work scope: a Scout call opens a workflow, and the Guard calls that
 * follow it (including parallel ones and the downstream policy/effect
 * continuations) join that same counted token through `AsyncLocalStorage`.
 * A pending AI approval carries a process-local generation sidecar and is
 * consumed with a counted token before the caller's first await.
 *
 * @module telegram/ai-composition
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getOperationSettings } from '../ai/operation-profiles.mjs';
import { createGenerationRuntime } from '../ai/runtime.mjs';
import { createGenerationGuard } from '../ai/coordination/generation-guard.mjs';
import { COORDINATION_ERROR_CODE, CoordinationError } from '../errors/coordination-error.mjs';
import { ACTIVATION_PAUSED, isStructuralCause } from '../errors/skill-error.mjs';
import { ConfigError } from '../config/config-error.mjs';
import {
  createProviderCredentialResolver,
  loadAIRuntimeConfig,
  loadSingleModeApiKey,
} from '../config/ai-runtime.mjs';
import { createDeepSeekChat } from './deepseek-client.mjs';
import { createReflector } from './reflect.mjs';
import { createControlStore } from '../ai/coordination/control-store.mjs';
// ─── Multi-Model Routing Support (v1.2) ──────────────────────────────────────
import { resolveOperationModel } from '../ai/model-resolver.mjs';
import { createSkillPackageStore } from '../ai/skills/package-store.mjs';
import {
  createProductionDispatch,
  isPausedEnvelope,
  SKILL_RUNTIME_MODE,
} from '../ai/skills/production.mjs';
import { ADAPTER_CATALOGUE_SHA256, HOST_CONTRACT_CATALOGUE_SHA256 } from '../ai/skills/adapters/catalogue.mjs';
import { SKILL_API_VERSION } from '../config/skill-package.mjs';
import { buildMonitorPrompt } from './monitor.mjs';
import { buildStopcheckPrompt } from './stopcheck.mjs';

/** Operations bound by this participant, in protocol order. */
export const TELEGRAM_OPERATIONS = Object.freeze(['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT']);

/**
 * The reviewed facade can only honour profiles with these properties; any other
 * profile is rejected rather than silently approximated.
 *
 * @param {any} profile
 */
export function assertProfileSupportedByFacade(profile) {
  const settings = Object.fromEntries(TELEGRAM_OPERATIONS.map((operation) => [operation, getOperationSettings(profile, operation)]));
  for (const operation of ['GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT']) {
    if (settings[operation].temperature !== 0) {
      throw new CoordinationError(`the Telegram facade fixes temperature 0 for ${operation}`, {
        code: COORDINATION_ERROR_CODE.CONFIGURATION_ERROR,
        details: { operation },
      });
    }
  }
  for (const operation of TELEGRAM_OPERATIONS) {
    if (settings[operation].responseFormat !== 'json_object' || settings[operation].stream !== false) {
      throw new CoordinationError(`the Telegram facade requires json_object, non-streaming responses for ${operation}`, {
        code: COORDINATION_ERROR_CODE.CONFIGURATION_ERROR,
        details: { operation },
      });
    }
  }
  const timeouts = new Set(TELEGRAM_OPERATIONS.map((operation) => settings[operation].timeoutMs));
  if (timeouts.size !== 1) {
    throw new CoordinationError('the Telegram facade uses one timeout for all five operations', {
      code: COORDINATION_ERROR_CODE.CONFIGURATION_ERROR,
    });
  }
  return settings;
}

/**
 * @param {any} manifest
 * @returns {string} scheme://host[:port]
 */
export function transportOrigin(manifest) {
  const url = new URL(manifest.canonicalBaseUrl);
  return url.origin;
}

/**
 * Project the scout's live market context onto the closed SCOUT host contract
 * (architecture v1.1 §6.2: "instrument data stripped, stable order"). Everything
 * the model must not see — tick sizes, order limits, 4h summaries — is dropped
 * before the package schema runs.
 *
 * @param {any} context
 */
export function scoutHostInput(context) {
  const symbols = Array.isArray(/** @type {any} */ (context)?.symbols) ? /** @type {any} */ (context).symbols : [];
  return {
    news: typeof /** @type {any} */ (context)?.news === 'string' ? /** @type {any} */ (context).news : null,
    symbols: symbols.map((snapshot) => ({
      symbol: snapshot.symbol,
      lastPrice: snapshot.lastPrice,
      bid: snapshot.bid ?? null,
      ask: snapshot.ask ?? null,
      high24h: snapshot.high24h ?? null,
      low24h: snapshot.low24h ?? null,
      avgRange14h: snapshot.avgRange14h ?? null,
      candles: Array.isArray(snapshot.candles)
        ? snapshot.candles.map((candle) => ({ o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v }))
        : [],
    })),
    openPositions: Array.isArray(/** @type {any} */ (context)?.openPositions)
      ? /** @type {any} */ (context).openPositions.map((position) => ({ symbol: position.symbol, side: position.side }))
      : null,
  };
}

/**
 * Project the guard call onto the closed GUARD host contract.
 *
 * Callers pass `market` in the legacy `{ symbol: snapshot, btc }` shape for
 * compatibility and, in v2 mode, the raw snapshot in `options.snapshot`.
 *
 * @param {any} idea
 * @param {any} market
 * @param {{ sentiment?: any, news?: string | null, snapshot?: any, btc?: any }} [options]
 */
export function guardHostInput(idea, market, options = {}) {
  const snapshot = options.snapshot ?? (market?.symbol !== null && typeof market?.symbol === 'object' ? market.symbol : null);
  const candidate = options.sentimentData ?? options.sentiment;
  const sentiment = candidate !== null && typeof candidate === 'object' ? candidate : null;
  return {
    btc: options.btc ?? market?.btc ?? null,
    news: typeof options.news === 'string' ? options.news : null,
    idea: {
      symbol: idea?.symbol,
      side: idea?.side,
      entry: idea?.entry,
      stopLoss: idea?.stopLoss,
      takeProfit: idea?.takeProfit,
    },
    market:
      snapshot === null
        ? null
        : {
            symbol: snapshot.symbol,
            lastPrice: snapshot.lastPrice,
            bid: snapshot.bid ?? null,
            ask: snapshot.ask ?? null,
            high24h: snapshot.high24h ?? null,
            low24h: snapshot.low24h ?? null,
            avgRange14h: snapshot.avgRange14h ?? null,
            candles: Array.isArray(snapshot.candles)
              ? snapshot.candles.map((candle) => ({ o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v }))
              : [],
          },
    sentiment:
      sentiment === null
        ? null
        : {
            fearGreed: Number.isFinite(sentiment.fearGreed) ? sentiment.fearGreed : null,
            fundingRate: Number.isFinite(sentiment.fundingRate) ? sentiment.fundingRate : null,
            turnover24hUsd: Number.isFinite(sentiment.turnover24h) ? sentiment.turnover24h : null,
            openInterestUsd: Number.isFinite(sentiment.openInterestValue) ? sentiment.openInterestValue : null,
          },
  };
}

/**
 * Project a closed trade onto the closed REFLECT host contract.
 *
 * @param {any} trade
 */
export function reflectHostInput(trade) {
  return {
    trade: {
      symbol: trade?.symbol,
      side: trade?.side,
      entry: trade?.entry,
      exit: trade?.exit,
      pnlUsd: trade?.pnlUsd,
      reason: trade?.reason,
      exitCause: trade?.exitCause,
      holdMinutes: Number.isFinite(trade?.holdMinutes) ? trade.holdMinutes : null,
      mfeUsd: Number.isFinite(trade?.mfeUsd) ? trade.mfeUsd : null,
    },
    existingRules: typeof trade?.existingRules === 'string' ? trade.existingRules : null,
  };
}

/**
 * Project a typed MONITOR/STOPCHECK host contract back onto the legacy prompt
 * input for the explicitly authorized `legacy` compatibility mode only. v2 never
 * calls this: the packaged layout renders the typed DTO directly.
 *
 * @param {any} input
 */
export function legacyMonitorPromptInput(input) {
  return {
    position: { ...input.position },
    market: {
      symbol: input.market.symbol,
      markPrice: input.market.lastPrice,
      bid: input.market.bid ?? null,
      ask: input.market.ask ?? null,
      kind: input.position.kind,
      atr14h: input.market.atr14h ?? null,
      trend: input.market.trend,
      btc: input.btc ?? null,
      candles: input.market.candles,
    },
    newsText: typeof input.news === 'string' ? input.news : '',
  };
}

/**
 * @param {string} workToken
 * @returns {string}
 */
function skillWorkToken(workToken) {
  if (typeof workToken === 'string') return workToken;
  if (workToken !== null && typeof workToken === 'object') {
    return String(/** @type {any} */ (workToken).id ?? /** @type {any} */ (workToken).token ?? randomUUID());
  }
  return randomUUID();
}

/**
 * @typedef {object} TelegramCompositionOptions
 * @property {any} config single-mode runtime config
 * @property {Record<string, string | undefined>} [env] local secret source for the v2 credential resolver; defaults to `process.env`
 * @property {any} controlStore
 * @property {{ artifactSha256: string } | string} artifactIdentity
 * @property {{
 *   createChatClient?: Function,
 *   createReflector?: Function,
 *   apiKeyLoader?: Function,
 *   fetchImpl?: Function,
 * }} [transportDependencies]
 * @property {object} [policy]
 * @property {() => number} [clock]
 * @property {string} [instanceId]
 * @property {object} [logger]
 */

/**
 * @param {TelegramCompositionOptions} options
 */
export function createTelegramAIComposition(options) {
  if (options === null || typeof options !== 'object' || !options.controlStore || !options.config) {
    throw new ConfigError('createTelegramAIComposition requires { config, controlStore, artifactIdentity }');
  }
  const { config, controlStore } = options;
  if (config.mode !== 'single') {
    throw new ConfigError('createTelegramAIComposition requires single mode', { field: 'AI_RUNTIME_MODE' });
  }
  const artifactSha256 = typeof options.artifactIdentity === 'string'
    ? options.artifactIdentity
    : options.artifactIdentity?.artifactSha256;
  if (typeof artifactSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifactSha256)) {
    throw new ConfigError('createTelegramAIComposition requires the artifact identity digest', { field: 'artifactIdentity' });
  }
  const transport = options.transportDependencies ?? {};
  const instanceId = options.instanceId ?? randomUUID();
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const logger = options.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  const apiKeyLoader = typeof transport.apiKeyLoader === 'function'
    ? transport.apiKeyLoader
    : () => loadSingleModeApiKey();
  const storage = new AsyncLocalStorage();

  // Reviewed dispatch mode. `legacy` is the explicit migration compatibility
  // path on a v1 record; `v2` routes every one of the five operations through
  // its approved package and bound model identity (architecture §10 Phase C/E).
  const skillMode = options.skillMode ?? /** @type {any} */ (config).skillMode ?? SKILL_RUNTIME_MODE.LEGACY;
  const skillTransport = options.skillTransport ?? transport.skillTransport ?? null;
  const credentialProvider = options.credentialProvider
    ?? transport.credentialProvider
    ?? createProviderCredentialResolver({ env: options.env });
  const skillArtifact = options.skillArtifact ?? {
    artifactSha256,
    botVersion: options.botVersion ?? '0.1.0',
    skillApiVersion: SKILL_API_VERSION,
    adapterCatalogueSha256: ADAPTER_CATALOGUE_SHA256,
    hostContractCatalogueSha256: HOST_CONTRACT_CATALOGUE_SHA256,
  };

  /** @type {{ client?: any, reflector?: any, skill?: any, manifest: any, profile: any } | null} */
  let facade = null;

  // ─── Per-operation multi-model routing cache (v1.2) ──────────────────────────
  /**
   * The cache must be declared before it is rebuilt. Declaring it after the
   * rebuild block put the assignment in the temporal dead zone, so construction
   * threw, the error was swallowed and every operation silently fell back to the
   * manifest model identity (architecture v1.1 §2.4 #2).
   *
   * @type {{ models: Record<string, Readonly<{ providerId: string, modelId: string, canonicalBaseUrl: string, trustTier: string }> | null>, fallbackManifest: object | null } | null}
   */
  let resolvedCache = null;

  // Multi-model routing: build per-op resolution cache at compose init time.
  // A registry that cannot resolve one of the operations is a configuration
  // fault, not a licence to fall back to the manifest: construction fails and
  // the guard keeps inference paused.
  if (options.registry?.routingTable) {
    resolvedCache = buildPerOpResolution();
  }

  /** Build and cache resolved identities for ALL telegram operations. Each operation maps independently. */
  function buildPerOpResolution() {
    if (!options.registry?.routingTable) return null;
    const models = {};
    const fallbackManifest = null;
    for (const operation of TELEGRAM_OPERATIONS) {
      if (typeof operation !== 'string' || operation === '') continue;
      const routeKey = options.registry.routingTable[operation];
      if (!routeKey) {
        throw new CoordinationError(`the model registry has no route for ${operation}`, {
          code: COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
        });
      }
      try {
        models[operation] = resolveOperationModel(operation, options.registry);
      } catch (err) {
        throw new CoordinationError(`per-op resolution failed for ${operation}`, {
          code: COORDINATION_ERROR_CODE.INVALID_EVIDENCE,
          cause: err instanceof CoordinationError ? err.code : 'RESOLUTION_FAILED',
        });
      }
    }
    return Object.freeze({ models, fallbackManifest });
  }

  /** Get resolved model identity for one specific telegram operation. Falls back to manifest. */
  function getModelForOp(operation, bindingInput) {
    const cached = resolvedCache?.models?.[operation];
    if (cached && cached.providerId && cached.modelId && cached.canonicalBaseUrl) {
      return Object.freeze(cached);
    }
    return Object.freeze({
      providerId: bindingInput.manifest.providerId,
      modelId: bindingInput.manifest.modelId,
      canonicalBaseUrl: bindingInput.manifest.canonicalBaseUrl,
    });
  }

  /**
   * Build the per-operation transport roles. Each role carries the resolved
   * provider, endpoint, model and reviewed settings, so the *observed wire
   * request* matches the selected identity for MONITOR, STOPCHECK and REFLECT
   * instead of reusing the GUARD role (architecture v1.1 §2.4 #3).
   *
   * @param {{ apiKey: string, settings: Record<string, any> }} input
   */
  function buildOperationRoles(input) {
    /** @type {Record<string, any>} */
    const roles = {};
    for (const operation of TELEGRAM_OPERATIONS) {
      const identity = getModelForOp(operation, { manifest: input.manifest });
      const settings = input.settings?.[operation];
      if (!identity) continue;
      roles[operation] = Object.freeze({
        provider: identity.providerId,
        baseUrl: transportOrigin(identity),
        apiKey: input.apiKey,
        model: identity.modelId,
        reasoningEffort: settings?.reasoningEffort ?? null,
        temperature: settings?.temperature,
      });
    }
    return Object.freeze(roles);
  }


  /**
   * Build the v2 runtime for the five Telegram operations.
   *
   * No prompt or chat facade is constructed: the packaged instructions, layout
   * and per-operation model identity come from the verified execution plan. A
   * structural fault returns the typed `ACTIVATION_PAUSED` envelope through
   * every wrapper and closes participant-local admission.
   *
   * @param {any} input runtimeFactory input
   */
  function skillRuntimeFactory(input) {
    const dispatch = createProductionDispatch({
      configuredMode: skillMode,
      binding: input.binding ?? null,
      controlDir: config.controlDir,
      controlStore,
      store: options.skillStore,
      profileReader: options.profileReader,
      artifact: skillArtifact,
      transport: skillTransport ?? undefined,
      fetchImpl: transport.fetchImpl ?? globalThis.fetch,
      credentialProvider,
      identity: {
        deploymentId: config.deploymentId,
        generation: input.generation,
        bindingSha256: input.binding?.bindingSha256 ?? null,
        releaseDescriptorSha256: null,
        slot: input.slot,
        instanceId: input.instanceId,
      },
      clock,
      uuid: randomUUID,
      audit: options.skillAudit ?? null,
      adapters: options.adapters,
      freshnessMs: options.skillFreshnessMs,
    });
    facade = { skill: dispatch, manifest: input.manifest, profile: input.profile };
    return createGenerationRuntime({
      binding: input.binding,
      generation: input.generation,
      deploymentId: config.deploymentId,
      slot: input.slot,
      instanceId: input.instanceId,
      manifest: input.manifest,
      profile: input.profile,
      operations: TELEGRAM_OPERATIONS,
      guard,
      clock,
      invoke: async ({ operation, request, workToken }) => {
        // Return the typed refusal unchanged: participant admission is closed by
        // the workflow boundary after the guard's post-invoke fence check.
        return dispatch.composition[operation](
          /** @type {any} */ (request).input,
          { workToken: skillWorkToken(workToken) },
        );
      },
    });
  }

  /**
   * Map a v2 skill result onto the compatibility success shape trusted callers
   * already consume (`{prompt, parsed, raw}`), keeping the typed refusal intact.
   *
   * @param {any} result
   * @param {(value: any) => object} shapeValue
   */
  function compatResult(result, shapeValue) {
    if (isPausedEnvelope(result)) return result;
    if (result.ok === false) {
      return Object.freeze({
        prompt: null,
        parsed: Object.freeze({ ok: false, issues: Object.freeze([result.code]) }),
        raw: '',
        failureCode: result.code,
        requestId: result.requestId,
      });
    }
    return Object.freeze({
      prompt: null,
      parsed: Object.freeze({ ok: true, ...shapeValue(result.value) }),
      raw: '',
      provenance: result.provenance,
    });
  }

  /**
   * @param {{ manifest: any, profile: any, binding: any, generation: number, target: boolean, slot: string, instanceId: string }} input
   */
  function runtimeFactory(input) {
    if (skillMode === SKILL_RUNTIME_MODE.V2) return skillRuntimeFactory(input);
    const settings = assertProfileSupportedByFacade(input.profile);
    const apiKey = apiKeyLoader();
    // ─── Per-operation model resolution (v1.2 multi-model routing) ────────
    // Resolve EVERY telegram operation to its own model identity from the registry.
    // Falls back to manifest identity when an operation lacks a registry entry.
    const scoutModel = getModelForOp('SCOUT', input);
    const guardModel = getModelForOp('GUARD', input);
    const monitorModel = getModelForOp('MONITOR', input);
    const stopcheckModel = getModelForOp('STOPCHECK', input);
    const reflectModel = getModelForOp('REFLECT', input);

    // Determine if multi-model mode is active (different ops → different models)
    const uniqueProviders = new Set([scoutModel.providerId, guardModel.providerId, monitorModel.providerId, stopcheckModel.providerId, reflectModel.providerId]);
    const multiModelActive = uniqueProviders.size > 1 || !!resolvedCache;


    const timeoutMs = settings.SCOUT.timeoutMs;
    const createClient = typeof transport.createChatClient === 'function' ? transport.createChatClient : createDeepSeekChat;
    const createReflect = typeof transport.createReflector === 'function' ? transport.createReflector : createReflector;
    const client = createClient({
      providerId: scoutModel.providerId,
      scoutProvider: scoutModel.providerId,
      guardProvider: guardModel.providerId,
      baseUrl: transportOrigin(scoutModel),
      scoutBaseUrl: transportOrigin(scoutModel),
      guardBaseUrl: transportOrigin(guardModel),
      apiKey,
      deepseekApiKey: scoutModel.providerId === 'deepseek' ? apiKey : undefined,
      kimiApiKey: scoutModel.providerId === 'kimi' ? apiKey : undefined,
      model: scoutModel.modelId,
      guardModel: guardModel.modelId,
      temperature: settings.SCOUT.temperature,
      scoutReasoningEffort: settings.SCOUT.reasoningEffort,
      guardReasoningEffort: settings.GUARD.reasoningEffort,
      timeoutMs,
      manifest: input.manifest,
      profile: input.profile,
      operationRoles: buildOperationRoles({ apiKey, manifest: input.manifest, settings }),
    });
    const reflector = createReflect({
      apiKey,
      baseUrl: transportOrigin(reflectModel),
      model: reflectModel.modelId,
      timeoutMs: settings.REFLECT.timeoutMs,
      fetchImpl: transport.fetchImpl,
    });
    facade = { client, reflector, manifest: input.manifest, profile: input.profile };
    return createGenerationRuntime({
      binding: input.binding,
      generation: input.generation,
      deploymentId: config.deploymentId,
      slot: input.slot,
      instanceId: input.instanceId,
      manifest: input.manifest,
      profile: input.profile,
      operations: TELEGRAM_OPERATIONS,
      guard,
      clock,
      invoke: async ({ operation, request }) => {
        const resolvedIdentity = getModelForOp(operation, facade);
        if (facade === null) {
          throw new CoordinationError('no admitted Telegram facade exists', {
            code: COORDINATION_ERROR_CODE.ACTIVATION_PAUSED,
          });
        }
        switch (operation) {
          case 'SCOUT':
            return facade.client.generateIdeas(request.context);
          case 'GUARD':
            return facade.client.filterIdea(request.idea, request.market, request.options ?? {});
          case 'MONITOR':
          case 'STOPCHECK':
            // Dispatch with the operation's own resolved identity instead of the
            // GUARD role (architecture v1.1 §2.4 #3). An injected compatibility
            // client that predates per-operation roles keeps working through its
            // GUARD entry point.
            if (typeof facade.client._completeOperation === 'function') {
              return facade.client._completeOperation(operation, request.prompt);
            }
            return facade.client._completeGuard(request.prompt);
          case 'REFLECT':
            return facade.reflector.reflect(request.trade);
          default:
            throw new CoordinationError(`operation ${operation} is not bound to the Telegram facade`, {
              code: COORDINATION_ERROR_CODE.SLOT_NOT_ADMITTED,
            });
        }
      },
    });
  }

  const participantSlot = typeof config.slot === 'string' && config.slot !== '' ? config.slot : 'telegram';
  const guard = createGenerationGuard({
    controlStore,
    config: { ...config, slot: participantSlot },
    instanceId,
    runtimeFactory,
    policy: options.policy,
    clock,
    logger,
  });

  /**
   * Run `fn` under a counted workflow scope. Nested calls (Scout -> Guard ->
   * effect) join the outer scope instead of opening a second one. A failure
   * anywhere inside the workflow taints it, so no survivor can dispatch an
   * effect afterwards.
   *
   * `fn` receives the counted token and its effect handle: `check()` must run
   * immediately before a dispatch, `retain(reason)` keeps an unknown outcome
   * counted, `rearm(id)` turns the remaining work into a pending effect sidecar.
   *
   * @template T
   * @param {string} operation
   * @param {(token: any, work: any) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function runInWorkflow(operation, fn) {
    const existing = storage.getStore();
    if (existing) {
      if (existing.failed) {
        throw new CoordinationError('the AI workflow already failed; no further call is allowed', {
          code: COORDINATION_ERROR_CODE.ACTIVATION_PAUSED,
        });
      }
      if (!existing.state.released) guard.check(existing.token);
      try {
        const result = await fn(existing.token, existing.work);
        if (!existing.failed) {
          if (!existing.state.released) guard.check(existing.token);
          // A structural Skill refusal taints the joined workflow — no sibling
          // or continuation may dispatch an AI-derived effect — and closes
          // participant admission for every later call. The close happens after
          // the fence check so the typed envelope is not replaced by a guard
          // exception.
          if (isPausedEnvelope(result)) {
            existing.failed = true;
            guard.closeAdmission(/** @type {any} */ (result).cause);
          }
        }
        return result;
      } catch (error) {
        existing.failed = true;
        throw error;
      }
    }
    const token = guard.beginWork(operation);
    /** @type {{ released: boolean }} */
    const state = { released: false };
    const scope = { token, operation, failed: false, state, work: workHandle(token, state) };
    try {
      guard.check(token);
      const result = await storage.run(scope, () => fn(token, scope.work));
      // A handle that converted its counted work into a pending effect sidecar
      // (an exit proposal, a preview ticket) is no longer checked here: the
      // sidecar is the tracked obligation from that point on.
      if (!scope.failed) {
        if (!state.released) guard.check(token);
        if (isPausedEnvelope(result)) {
          scope.failed = true;
          guard.closeAdmission(/** @type {any} */ (result).cause);
        }
      }
      return result;
    } finally {
      // A retained token is not released here: endWork refuses to release an
      // unresolved effect, so the drain barrier stays closed until an operator
      // reconciles the exchange outcome.
      guard.endWork(token);
    }
  }

  /**
   * The effect lifecycle for a counted token. One shape for both a workflow
   * scope and a consumed approval, so every dispatch site behaves the same.
   *
   * @param {any} token
   * @param {{ released: boolean }} state shared with the enclosing workflow scope
   */
  function workHandle(token, state) {
    return Object.freeze({
      token,
      check: () => guard.check(token),
      settle: () => {
        if (state.released) return;
        state.released = true;
        guard.endWork(token);
      },
      retain: (reason) => {
        if (state.released) {
          throw new CoordinationError('a settled work scope cannot be retained as unresolved', {
            code: COORDINATION_ERROR_CODE.INTERNAL_ERROR,
          });
        }
        state.released = true;
        return guard.retainWork(token, reason);
      },
      rearm: (approvalId, meta) => {
        if (state.released) {
          throw new CoordinationError('a settled work scope cannot be re-armed', {
            code: COORDINATION_ERROR_CODE.INTERNAL_ERROR,
          });
        }
        const held = guard.holdApprovalForEffect(approvalId, token, meta);
        state.released = true;
        return held;
      },
    });
  }

  /**
   * Consume a pending human approval or a pending effect sidecar. Synchronous:
   * the counted token exists before the caller's first await.
   *
   * @param {string} approvalId
   */
  function beginApprovalConsumption(approvalId) {
    return guard.beginApprovalConsumption(approvalId);
  }

  /**
   * Turn a consumed approval into a pending effect sidecar so a later callback
   * (the final confirm tap) can consume it again.
   *
   * @param {string} approvalId
   * @param {any} token
   * @param {{ operation?: string, purpose?: string }} [meta]
   */
  function holdPendingEffect(approvalId, token, meta) {
    return guard.holdApprovalForEffect(approvalId, token, meta);
  }

  /**
   * The effect boundary for AI-derived actions (order dispatch, rule append,
   * proposal consumption). Must be used inside a workflow; refused once the
   * workflow failed or the generation was retired.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function runEffect(fn) {
    const scope = storage.getStore();
    if (!scope) {
      throw new CoordinationError('an AI-derived effect requires an active workflow scope', {
        code: COORDINATION_ERROR_CODE.ACTIVATION_PAUSED,
      });
    }
    if (scope.failed) {
      throw new CoordinationError('the AI workflow failed; the derived effect is refused', {
        code: COORDINATION_ERROR_CODE.ACTIVATION_PAUSED,
      });
    }
    if (scope.state.released) {
      throw new CoordinationError('the counted scope was already converted into a pending effect', {
        code: COORDINATION_ERROR_CODE.ACTIVATION_PAUSED,
      });
    }
    guard.check(scope.token);
    const result = await fn();
    guard.check(scope.token);
    return result;
  }

  /**
   * @param {string} operation
   * @param {unknown} request
   * @param {any} token
   */
  async function invoke(operation, request, token) {
    const runtime = guard.getRuntime();
    if (!runtime) {
      throw new CoordinationError('no admitted generation runtime exists', {
        code: COORDINATION_ERROR_CODE.ACTIVATION_PAUSED,
      });
    }
    const envelope = await runtime.complete(operation, request, { workToken: token });
    return envelope.result;
  }

  /**
   * The guarded equivalent of `createDeepSeekChat`.
   *
   * In `legacy` mode the methods mirror the legacy facade exactly (prompt in,
   * `{prompt, parsed, raw}` out) so the explicitly authorized migration path is
   * byte-compatible. In `v2` mode the trusted callers supply typed DTOs and the
   * runtime — not a caller prompt — renders the model input. The prompt-taking
   * entry points are then offline-only and refuse to run.
   */
  const guardedClient = Object.freeze({
    /** Which reviewed dispatch mode this client implements. */
    operationMode: skillMode,
    get provider() {
      return facade?.manifest.providerId ?? null;
    },
    get model() {
      return facade?.manifest.modelId ?? null;
    },
    get guardModel() {
      return facade?.manifest.modelId ?? null;
    },
    get baseUrl() {
      return facade?.manifest.canonicalBaseUrl ?? null;
    },
    getCacheStats: () => facade?.client?.getCacheStats?.() ?? { hits: 0, misses: 0, zeroHitCalls: 0, calls: 0, hitRatio: 0 },
    /** @param {object} context */
    generateIdeas: (context) => {
      if (skillMode === SKILL_RUNTIME_MODE.V2) {
        return runInWorkflow('SCOUT', async (token) => {
          const result = await invoke('SCOUT', { input: scoutHostInput(context) }, token);
          return compatResult(result, (value) => ({ ideas: value.ideas, issues: [] }));
        });
      }
      return runInWorkflow('SCOUT', (token) => invoke('SCOUT', { context }, token));
    },
    /** @param {object} idea @param {object} market @param {object} [opts] */
    filterIdea: (idea, market, opts = {}) => {
      if (skillMode === SKILL_RUNTIME_MODE.V2) {
        return runInWorkflow('GUARD', async (token) => {
          const result = await invoke('GUARD', { input: guardHostInput(idea, market, opts) }, token);
          return compatResult(result, (value) => ({ value }));
        });
      }
      return runInWorkflow('GUARD', (token) => invoke('GUARD', { idea, market, options: opts }, token));
    },
    /**
     * Typed MONITOR dispatch (v2). Legacy callers keep `_completeGuard(prompt)`.
     *
     * @param {object} input closed monitor host contract
     */
    monitor: (input) => {
      if (skillMode !== SKILL_RUNTIME_MODE.V2) {
        return runInWorkflow('MONITOR', (token) =>
          invoke('MONITOR', { prompt: buildMonitorPrompt(legacyMonitorPromptInput(input)) }, token),
        );
      }
      return runInWorkflow('MONITOR', async (token) => {
        const result = await invoke('MONITOR', { input }, token);
        return compatResult(result, (value) => ({ value }));
      });
    },
    /**
     * Typed STOPCHECK dispatch (v2).
     *
     * @param {object} input closed stop-check host contract
     */
    stopcheck: (input) => {
      if (skillMode !== SKILL_RUNTIME_MODE.V2) {
        return runInWorkflow('STOPCHECK', (token) =>
          invoke('STOPCHECK', { prompt: buildStopcheckPrompt(legacyMonitorPromptInput(input)) }, token),
        );
      }
      return runInWorkflow('STOPCHECK', async (token) => {
        const result = await invoke('STOPCHECK', { input }, token);
        return compatResult(result, (value) => ({ value }));
      });
    },
    /**
     * Low-level guard completion on a caller-built prompt. Offline-only: v2
     * production callers supply typed DTOs, so this path refuses.
     *
     * @param {object} prompt
     * @param {{ operation?: 'MONITOR' | 'STOPCHECK' }} [opts]
     */
    _completeGuard: (prompt, opts = {}) => {
      const operation = opts.operation === 'STOPCHECK' ? 'STOPCHECK' : 'MONITOR';
      if (skillMode === SKILL_RUNTIME_MODE.V2) {
        throw new CoordinationError('prompt-based completion is offline-only; supply a typed operation DTO', {
          code: COORDINATION_ERROR_CODE.CONFIGURATION_ERROR,
          details: { operation },
        });
      }
      return runInWorkflow(operation, (token) => invoke(operation, { prompt }, token));
    },
    /** @param {object} prompt */
    completeMonitor: (prompt) => {
      if (skillMode === SKILL_RUNTIME_MODE.V2) {
        throw new CoordinationError('prompt-based completion is offline-only; supply a typed operation DTO', {
          code: COORDINATION_ERROR_CODE.CONFIGURATION_ERROR,
          details: { operation: 'MONITOR' },
        });
      }
      return runInWorkflow('MONITOR', (token) => invoke('MONITOR', { prompt }, token));
    },
    /** @param {object} prompt */
    completeStopcheck: (prompt) => {
      if (skillMode === SKILL_RUNTIME_MODE.V2) {
        throw new CoordinationError('prompt-based completion is offline-only; supply a typed operation DTO', {
          code: COORDINATION_ERROR_CODE.CONFIGURATION_ERROR,
          details: { operation: 'STOPCHECK' },
        });
      }
      return runInWorkflow('STOPCHECK', (token) => invoke('STOPCHECK', { prompt }, token));
    },
    /** @param {object} trade */
    reflect: (trade) => {
      if (skillMode === SKILL_RUNTIME_MODE.V2) {
        return runInWorkflow('REFLECT', async (token) => {
          const result = await invoke('REFLECT', { input: reflectHostInput(trade) }, token);
          return compatResult(result, (value) => ({ value }));
        });
      }
      return runInWorkflow('REFLECT', (token) => invoke('REFLECT', { trade }, token));
    },
  });

  /**
   * @returns {Readonly<object>} status
   */
  function start() {
    return guard.start();
  }

  /**
   * @returns {Readonly<object>} the guarded chat facade
   * @throws {CoordinationError} when identity is not ready or admission is closed
   */
  function getChatClient() {
    const status = guard.status();
    if (!status.inferenceEnabled) {
      // A participant closed by a structural Skill fault reports the public
      // ACTIVATION_PAUSED with the safe cause in diagnostic metadata, never a
      // SKILL_* code as the public discriminant (architecture §6.3).
      const closedBySkill = isStructuralCause(status.errorCode);
      throw new CoordinationError('Telegram AI is not admitted in the current release generation', {
        code: closedBySkill ? ACTIVATION_PAUSED : status.errorCode ?? COORDINATION_ERROR_CODE.ACTIVATION_PAUSED,
        details: {
          phase: status.phase,
          generation: status.generation,
          ...(closedBySkill ? { cause: status.errorCode } : {}),
        },
      });
    }
    return guardedClient;
  }

  /**
   * @param {object} trade
   * @returns {Promise<object | null>}
   */
  async function reflect(trade) {
    if (!guard.status().inferenceEnabled) return null;
    try {
      const result = await guardedClient.reflect(trade);
      if (isPausedEnvelope(result)) return result;
      if (skillMode === SKILL_RUNTIME_MODE.V2) {
        if (result !== null && typeof result === 'object' && result.failureCode) {
          // Ordinary per-request failure: keep the safe code, write nothing.
          return Object.freeze({ ok: false, code: result.failureCode, requestId: result.requestId ?? null });
        }
        return result?.parsed?.ok === true ? result.parsed.value : null;
      }
      return result;
    } catch (error) {
      if (error instanceof CoordinationError) return null;
      throw error;
    }
  }

  return Object.freeze({
    slot: participantSlot,
    instanceId,
    guard,
    start,
    status: () => guard.status(),
    getChatClient,
    reflect,
    runInWorkflow,
    runEffect,
    registerPendingApproval: (approvalId, meta) => guard.registerPendingApproval(approvalId, meta),
    holdPendingEffect,
    beginApprovalConsumption,
    dropPendingApproval: (approvalId) => guard.dropPendingApproval(approvalId),
    pendingApprovalCount: () => guard.pendingApprovalCount(),
    invalidatePendingApprovals: () => guard.invalidatePendingApprovals(),
    acknowledgeQuiesced: () => guard.acknowledgeQuiesced(),
    prepareTarget: (grant) => guard.prepareTarget(grant),
    activateFromControl: () => guard.activateFromControl(),
    poll: () => guard.poll(),
    startPolling: (opts) => guard.startPolling(opts),
    stopPolling: () => guard.stopPolling(),
    unresolvedEffects: () => guard.status().unresolvedEffects,
    reconcileUnresolved: (input) => guard.reconcileUnresolved(input),
  });
}

/**
 * Build the Telegram composition from the environment.
 *
 * Returns `null` in legacy mode, so `bot.mjs` keeps its exact previous
 * behaviour. In single mode a coordination failure is reported (never thrown),
 * and AI entry points fail closed while deterministic protection keeps running.
 *
 * @param {{ env?: Record<string, string | undefined>, controlStore?: any, artifactSha256?: string, logger?: object, instanceId?: string, transportDependencies?: object, policy?: object }} [input]
 * @returns {ReturnType<typeof createTelegramAIComposition> | null}
 */
export function createTelegramAICompositionFromEnv(input = {}) {
  const env = input.env ?? process.env;
  const config = loadAIRuntimeConfig(env);
  if (config.mode !== 'single') return null;
  if (!config.slot) {
    throw new ConfigError('AI_PARTICIPANT_SLOT is required for the Telegram participant', { field: 'AI_PARTICIPANT_SLOT' });
  }
  let controlStore = input.controlStore;
  if (!controlStore) {
    controlStore = createControlStore({ controlDir: config.controlDir });
  }
  const logger = input.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  // Model-registry bootstrap (architecture v1.1 §2.4 #4). The production entry
  // point must supply the routed registry explicitly or by reading the one the
  // committed generation binds; it must never be inferred from process
  // environment strings.
  let registry = input.registry ?? null;
  if (registry === null) {
    registry = loadBoundModelRegistry({ controlStore, controlDir: config.controlDir, logger });
  }
  const composition = createTelegramAIComposition({
    config,
    env,
    controlStore,
    artifactIdentity: { artifactSha256: input.artifactSha256 ?? config.artifactSha256 },
    transportDependencies: input.transportDependencies,
    policy: input.policy,
    logger,
    instanceId: input.instanceId,
    registry,
  });
  return composition;
}

/**
 * Read the model registry that the committed generation binds, from the shared
 * control directory. A missing registry is reported but never replaced by an
 * environment-derived route.
 *
 * @param {{ controlStore: any, controlDir: string, logger: object }} input
 * @returns {Readonly<object> | null}
 */
function loadBoundModelRegistry(input) {
  const store = input.controlStore;
  if (!store || typeof store.tryReadRecord !== 'function') return null;
  try {
    const record = store.tryReadRecord();
    const binding = record?.active ?? record?.target ?? null;
    const digest = binding?.modelRegistrySha256 ?? null;
    if (typeof digest !== 'string') return null;
    const skillStore = createSkillPackageStore({ rootDir: input.controlDir });
    return skillStore.readModelRegistry(digest);
  } catch (error) {
    input.logger.warn('the bound model registry is not readable; per-operation routing is disabled', {
      code: error instanceof CoordinationError ? error.code : 'REGISTRY_UNAVAILABLE',
    });
    return null;
  }
}
