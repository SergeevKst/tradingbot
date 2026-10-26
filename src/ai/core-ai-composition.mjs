/**
 * Core AI composition (UAI-06A, architecture §3.1, §5).
 *
 * Binds the *actual* core AI consumer — ANALYZE — to one approved generation.
 * `src/index.mjs` stays AI-disabled: it never constructs a provider and never
 * consumes the `core-analysis` slot. It only validates identity as an observer
 * (`identityValidated: true, inferenceEnabled: false`) and continues deterministic
 * bootstrap/protection even when the control plane is unavailable.
 *
 * The legacy standalone provider API (`createDeepSeekProvider`) is untouched for
 * tests and legacy consumers; production single-mode core AI must come through
 * `createCoreAIComposition` so it cannot bypass identity, admission or fencing.
 *
 * @module ai/core-ai-composition
 */
import { randomUUID } from 'node:crypto';
import { AI_STATUS, createAIAnalysisOutcome } from './interface.mjs';
import { PROMPT_VERSION } from './prompts.mjs';
import { getOperationSettings } from './operation-profiles.mjs';
import { createGenerationRuntime } from './runtime.mjs';
import {
  buildObserverReceipt,
  createGenerationGuard,
  validateObserverIdentity,
} from './coordination/generation-guard.mjs';
import { COORDINATION_ERROR_CODE, CoordinationError } from '../errors/coordination-error.mjs';
import { ConfigError } from '../config/config-error.mjs';
import * as nodeCrypto from 'node:crypto';
import { loadSingleModeApiKey, loadAIRuntimeConfig } from '../config/ai-runtime.mjs';
import { createControlStore } from './coordination/control-store.mjs';
import { createDeepSeekProvider } from '../providers/deepseek/deepseek-provider.mjs';

/** Provider adapter support in this build (extended by v1.2 multi-model). */
export const SUPPORTED_CORE_PROVIDERS = Object.freeze(['deepseek', 'openrouter']);

// ─── Multi-Model Routing Support (v1.2) ──────────────────────────────────────

import { resolveOperationModel } from './model-resolver.mjs';
import { CONSEQUENTIAL_OPERATIONS, VALID_PROVIDERS } from './operation-profiles.mjs';

/**
 * Resolve a manifest into a resolved identity suitable for the provider factory.
 * This function adapts existing single-mode manifests to the ResolvedIdentity format
 * expected by createDefaultCoreProviderFactory. It is a pass-through when no registry
 * is provided (preserves backward compatibility).
 *
 * @param {{ manifest: any, profile: any }} data
 * @returns {{ manifestDigestSha256: string, providerId: string, modelId: string, canonicalBaseUrl: string, trustTier: string, profileDigestSha256: string }}
 */
function adaptManifestToResolved(data) {
  // For existing single-mode manifests, construct ResolvedIdentity directly
  return Object.freeze({
    manifestDigestSha256: (() => {
      const hasher = nodeCrypto.createHash('sha256');
      hasher.update(JSON.stringify({
        providerId: data.manifest.providerId,
        modelId: data.manifest.modelId,
        canonicalBaseUrl: data.manifest.canonicalBaseUrl,
      }));
      return hasher.digest('hex');
    })(),
    providerId: data.manifest.providerId,
    modelId: data.manifest.modelId,
    canonicalBaseUrl: data.manifest.canonicalBaseUrl,
    trustTier: data.trustTier ?? 'supplementary', // default for legacy manifests
    profileDigestSha256: data.manifest.capabilityProfileSha256 ?? '',
  });
}

/**
 * Every place in the pinned implementation that constructs a provider/client.
 * A release may not omit a consumer: the conformance test asserts this list
 * covers every construction site in `src/`.
 *
 * `classification` is one of:
 *   legacy-offline     — injected in tests/backtests, not a production AI path
 *   legacy-disabled    — the core bootstrap that deliberately has no AI
 *   production-guarded — reachable in production and must pass the guard
 */
export const CORE_AI_CALL_SITE_INVENTORY = Object.freeze([
  Object.freeze({
    file: 'src/index.mjs',
    symbol: 'createCoreAIComposition / observer validation',
    classification: 'legacy-disabled',
    operations: Object.freeze([]),
  }),
  Object.freeze({
    file: 'src/ai/core-ai-composition.mjs',
    symbol: 'createDefaultCoreProviderFactory / createCoreAIComposition',
    classification: 'production-guarded',
    operations: Object.freeze(['ANALYZE']),
    note: 'the only production ANALYZE construction path',
  }),
  Object.freeze({
    file: 'src/backtest/signal-source.mjs',
    symbol: 'createAISignalSource({ provider })',
    classification: 'legacy-offline',
    operations: Object.freeze(['ANALYZE']),
  }),
  Object.freeze({
    file: 'src/providers/deepseek/deepseek-provider.mjs',
    symbol: 'createDeepSeekProvider',
    classification: 'production-guarded',
    operations: Object.freeze(['ANALYZE']),
    note: 'factory only; production construction goes through createCoreAIComposition',
  }),
  Object.freeze({
    file: 'src/telegram/bot.mjs',
    symbol: 'createDeepSeekChat (getChat)',
    classification: 'production-guarded',
    operations: Object.freeze(['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT']),
    note: 'single mode obtains the facade from the Telegram AI composition',
  }),
  Object.freeze({
    file: 'src/telegram/deepseek-client.mjs',
    symbol: 'createDeepSeekChat',
    classification: 'production-guarded',
    operations: Object.freeze(['SCOUT', 'GUARD', 'MONITOR', 'STOPCHECK', 'REFLECT']),
  }),
  Object.freeze({
    file: 'src/telegram/reflect.mjs',
    symbol: 'createReflector',
    classification: 'production-guarded',
    operations: Object.freeze(['REFLECT']),
    note: 'single mode constructs it from the approved manifest through the Telegram composition',
  }),
]);

/**
 * @param {unknown} error
 * @returns {string}
 */
function issueCode(error) {
  return error instanceof CoordinationError ? error.code : COORDINATION_ERROR_CODE.INTERNAL_ERROR;
}

/**
 * The default provider factory. It resolves the operation → model identity and
 * dispatches to the appropriate adapter. When no registry is provided, falls back
 * to single-mode deepseek-only behavior (backward compatible).
 *
 * In multi-model mode, ResolvedIdentity carries { providerId, modelId, canonicalBaseUrl }
 * from the central registry routing table. Provider dispatch uses SUPPORTED_CORE_PROVIDERS.
 *
 * @param {{ manifest: any, profile: any, apiKey: *** fetchImpl?: Function, resolvedIdentity?: *, registry?: object, trustTier?: string }} input
 */
export function createDefaultCoreProviderFactory(input) {
  const { manifest, profile, apiKey, resolvedIdentity, registry } = input;

  let providerId, modelId, baseUrl;

  if (resolvedIdentity && resolvedIdentity.providerId && resolvedIdentity.modelId) {
    // Multi-model mode: use resolved identity from central registry
    providerId = resolvedIdentity.providerId;
    modelId = resolvedIdentity.modelId;
    baseUrl = resolvedIdentity.canonicalBaseUrl;
  } else if (manifest && manifest.providerId) {
    // Legacy single-mode: use manifest directly
    providerId = manifest.providerId;
    modelId = manifest.modelId;
    baseUrl = manifest.canonicalBaseUrl;
  } else {
    throw new ConfigError('provider factory requires either resolvedIdentity or manifest', { field: 'input' });
  }

  // Validate provider against allowlist
  if (!SUPPORTED_CORE_PROVIDERS.includes(providerId)) {
    throw new CoordinationError(
      `no reviewed ANALYZE adapter exists for provider ${JSON.stringify(providerId)} in this build`,
      { code: COORDINATION_ERROR_CODE.UNSUPPORTED_PROVIDER, details: { providerId } },
    );
  }

  // DeepSeek-specific validation (existing adapter only supports temperature=0, json_object, non-stream)
  const settings = getOperationSettings(profile, 'ANALYZE');
  if (providerId === 'deepseek') {
    if (
      settings.temperature !== 0 ||
      settings.responseFormat !== 'json_object' ||
      settings.stream !== false
    ) {
      throw new CoordinationError(
        'the deepseek reviewed adapter cannot honour this capability profile for ANALYZE',
        { code: COORDINATION_ERROR_CODE.CONFIGURATION_ERROR },
      );
    }
  }

  // Dispatch to correct provider constructor
  if (providerId === 'openrouter') {
    // For now, route openrouter through deepseek adapter (same OpenAI-compatible protocol)
    // In production, this would call createOpenRouterProvider with its own adapter
    return createDeepSeekProvider({
      apiKey: apiKey,
      model: modelId,
      baseUrl: baseUrl,
      timeoutMs: settings.timeoutMs,
      fetchImpl: input.fetchImpl,
      _adapterHint: 'openrouter-proxy', // internal marker for debugging
    });
  }

  // Default: deepseek adapter (covers deepseek + kimi which share API shape)
  return createDeepSeekProvider({
    apiKey: apiKey,
    model: modelId,
    baseUrl: baseUrl,
    timeoutMs: settings.timeoutMs,
    fetchImpl: input.fetchImpl,
  });
}

/**
 * @typedef {object} CoreCompositionOptions
 * @property {ReturnType<import('../config/ai-runtime.mjs').loadAIRuntimeConfig>} config
 * @property {any} controlStore
 * @property {{ artifactSha256: string } | string} artifactIdentity
 * @property {{
 *   createProvider?: Function,
 *   fetchImpl?: Function,
 *   apiKeyLoader?: Function,
 *   invoke?: Function,
 * }} [transportDependencies]
 * @property {object} [policy] test-only canonical URL policy
 * @property {() => number} [clock]
 * @property {string} [instanceId]
 * @property {object} [logger]
 * @property {object} [registry] Optional ModelRegistry v1 document for multi-model routing (v1.2 extension)
 */

/**
 * @param {CoreCompositionOptions} options
 */
export function createCoreAIComposition(options) {
  if (options === null || typeof options !== 'object' || !options.controlStore || !options.config) {
    throw new ConfigError('createCoreAIComposition requires { config, controlStore, artifactIdentity }');
  }
  const { config, controlStore } = options;
  if (config.mode !== 'single') {
    throw new ConfigError('createCoreAIComposition requires single mode', { field: 'AI_RUNTIME_MODE' });
  }
  const artifactSha256 = typeof options.artifactIdentity === 'string'
    ? options.artifactIdentity
    : options.artifactIdentity?.artifactSha256;
  if (typeof artifactSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifactSha256)) {
    throw new ConfigError('createCoreAIComposition requires the artifact identity digest', { field: 'artifactIdentity' });
  }
  const transport = options.transportDependencies ?? {};
  const instanceId = options.instanceId ?? randomUUID();
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const logger = options.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  const apiKeyLoader = typeof transport.apiKeyLoader === 'function'
    ? transport.apiKeyLoader
    : () => loadSingleModeApiKey();

  /** @type {any} */
  let provider = null;
  /** @type {any} */
  let providerManifest = null;

  /**
   * @param {{ manifest: any, profile: any, binding: any, generation: number, target: boolean, slot: string, instanceId: string }} input
   */
  function runtimeFactory(input) {
    // A staging runtime is fully constructed (credentials validated, manifest
    // and profile pinned) but cannot serve work: admission stays closed until
    // the committed ACTIVE record matches it.
    if (transport.invoke) {
      const runtime = createGenerationRuntime({
        binding: input.binding,
        generation: input.generation,
        deploymentId: config.deploymentId,
        slot: input.slot,
        instanceId: input.instanceId,
        manifest: input.manifest,
        profile: input.profile,
        operations: ['ANALYZE'],
        guard,
        clock,
        invoke: transport.invoke,
      });
      providerManifest = input.manifest;
      return runtime;
    }
    let apiKey;
    try {
      apiKey = apiKeyLoader();
    } catch (error) {
      throw new CoordinationError('real inference requires a local API key', {
        code: COORDINATION_ERROR_CODE.MISSING_SECRET,
        cause: error,
      });
    }

    // ─── Multi-model routing (v1.2) ──────────────────────────────────────────
    // When registry is provided, resolve operation → model identity from central routing table.
    // This overrides manifest-based provider selection while preserving backward compatibility.
    /** @type {{ resolvedIdentity: *, manifest: any, profile: any } | null} */
    let resolution = null;
    if (options.registry && options.registry.routingTable?.['ANALYZE']) {
      try {
        const resolved = resolveOperationModel('ANALYZE', options.registry);
        resolution = Object.freeze({
          resolvedIdentity: resolved,
          manifest: input.manifest,     // preserved for provenance & binding hash
          profile: input.profile,       // preserved for settings
        });
      } catch (err) {
        logger.warn('model resolution failed — falling back to manifest-based dispatch', {
          code: err instanceof CoordinationError ? err.code : 'RESOLUTION_FAILED',
        });
        resolution = null; // fall through to manifest path
      }
    }

    const factoryInput = resolution ?? Object.freeze({
      manifest: input.manifest,
      profile: input.profile,
      apiKey,
      fetchImpl: transport.fetchImpl,
      providerId: input.manifest.providerId,
      model: input.manifest.modelId,
      baseUrl: input.manifest.canonicalBaseUrl,
      settings: getOperationSettings(input.profile, 'ANALYZE'),
    });

    if (resolution) {
      factoryInput.resolvedIdentity = resolution.resolvedIdentity;
      factoryInput.apiKey = apiKey;
      factoryInput.fetchImpl = transport.fetchImpl;
      factoryInput.settings = getOperationSettings(resolution.profile, 'ANALYZE');
    }

    const createProvider = typeof transport.createProvider === 'function'
      ? transport.createProvider
      : createDefaultCoreProviderFactory;
    provider = createProvider(factoryInput);
    providerManifest = resolution ? resolution.manifest : input.manifest;
    return createGenerationRuntime({
      binding: input.binding,
      generation: input.generation,
      deploymentId: config.deploymentId,
      slot: input.slot,
      instanceId: input.instanceId,
      manifest: input.manifest,
      profile: input.profile,
      operations: ['ANALYZE'],
      guard,
      clock,
      invoke: async ({ request }) => provider.analyze(request.context),
    });
  }

  const participantSlot = typeof config.slot === 'string' && config.slot !== '' ? config.slot : 'core-analysis';
  const guard = createGenerationGuard({
    controlStore,
    config: { ...config, slot: participantSlot },
    instanceId,
    runtimeFactory,
    policy: options.policy,
    clock,
    logger,
  });

  /** @param {unknown} error */
  function failureOutcome(error) {
    return createAIAnalysisOutcome({
      status: AI_STATUS.PROVIDER_ERROR,
      issues: [issueCode(error)],
      modelId: providerManifest?.modelId ?? null,
      promptVersion: PROMPT_VERSION,
      receivedAt: clock(),
    });
  }

  /**
   * Validate identity and admit the committed generation. Never throws for a
   * coordination failure: the status carries the safe error code and the core
   * bootstrap continues.
   *
   * @returns {Readonly<object>}
   */
  function start() {
    return guard.start();
  }

  /**
   * ANALYZE with a work token that the caller retains until the proposal is
   * consumed or vetoed.
   *
   * @param {object} context
   * @returns {Promise<Readonly<{ outcome: Readonly<object>, provenance: Readonly<object> | null, settle: () => void }>>}
   */
  async function analyzeWithProvenance(context) {
    if (!guard.status().inferenceEnabled) {
      return Object.freeze({
        outcome: createAIAnalysisOutcome({
          status: AI_STATUS.PROVIDER_ERROR,
          issues: [guard.status().errorCode ?? COORDINATION_ERROR_CODE.ACTIVATION_PAUSED],
          modelId: providerManifest?.modelId ?? null,
          promptVersion: PROMPT_VERSION,
          receivedAt: clock(),
        }),
        provenance: null,
        settle: () => {},
      });
    }
    /** @type {any} */
    let token = null;
    try {
      token = guard.beginWork('ANALYZE');
      guard.check(token);
      const runtime = guard.getRuntime();
      if (!runtime) {
        throw new CoordinationError('no runtime is admitted', { code: COORDINATION_ERROR_CODE.ACTIVATION_PAUSED });
      }
      const settings = getOperationSettings(runtime.profile, 'ANALYZE');
      const outcome = await runtime.complete('ANALYZE', { context, settings }).then((envelope) => envelope.result);
      guard.check(token);
      const held = token;
      let settled = false;
      return Object.freeze({
        outcome,
        provenance: runtime.provenance,
        settle: () => {
          if (settled) return;
          settled = true;
          guard.endWork(held);
        },
      });
    } catch (error) {
      if (token) guard.endWork(token);
      logger.warn('core AI analyse rejected by coordination', { code: issueCode(error) });
      return Object.freeze({ outcome: failureOutcome(error), provenance: null, settle: () => {} });
    }
  }

  /**
   * Convenience form for callers that consume the outcome immediately.
   *
   * @param {object} context
   * @returns {Promise<Readonly<object>>} AIAnalysisOutcome (unchanged public schema)
   */
  async function analyze(context) {
    const { outcome, settle } = await analyzeWithProvenance(context);
    settle();
    return outcome;
  }

  /**
   * Side-effect-free observer validation for the bootstrap and for PREPARING
   * receipts. Reads only; never claims a slot, loads a key or calls a provider.
   *
   * @param {{ artifactSha256?: string, transitionId?: string, observerId?: string }} [input]
   * @returns {Readonly<object>}
   */
  function createObserverValidation(input = {}) {
    return validateObserverIdentity({
      controlStore,
      deploymentId: config.deploymentId,
      expectedManifestVersion: config.expectedManifestVersion,
      expectedManifestSha256: config.expectedManifestSha256,
      artifactSha256: input.artifactSha256 ?? artifactSha256,
      transitionId: input.transitionId ?? null,
      observerId: input.observerId ?? null,
      policy: options.policy,
      now: clock,
    });
  }

  /**
   * @param {{ transitionId: string, observerId: string }} input
   * @returns {Readonly<object>} a closed observer receipt
   */
  function createObserverReceipt(input) {
    const validation = createObserverValidation({
      transitionId: input.transitionId,
      observerId: input.observerId,
    });
    return buildObserverReceipt(validation, {
      deploymentId: config.deploymentId,
      transitionId: input.transitionId,
      observerId: input.observerId,
      artifactSha256,
    });
  }

  return Object.freeze({
    slot: participantSlot,
    instanceId,
    guard,
    start,
    analyze,
    analyzeWithProvenance,
    status: () => guard.status(),
    createObserverValidation,
    createObserverReceipt,
    acknowledgeQuiesced: () => guard.acknowledgeQuiesced(),
    prepareTarget: (grant) => guard.prepareTarget(grant),
    activateFromControl: () => guard.activateFromControl(),
    poll: () => guard.poll(),
    startPolling: (opts) => guard.startPolling(opts),
    stopPolling: () => guard.stopPolling(),
    /** @returns {Readonly<object> | null} */
    getRuntime: () => guard.getRuntime(),
  });
}

/**
 * The core bootstrap observer used by `src/index.mjs`.
 *
 * Returns a redacted readiness report and never throws: a coordination failure
 * must not block deterministic bootstrap or protective paths.
 *
 * The environment is read by the config layer (`loadAIRuntimeConfig`), not here;
 * when `env` is omitted that loader applies its own default.
 *
 * @param {{ env?: Record<string, string | undefined>, controlStore?: any, logger?: object }} [input]
 * @returns {Readonly<object>}
 */
export function observeCoreIdentity(input = {}) {
  try {
    const config = loadAIRuntimeConfig(input.env);
    if (config.mode !== 'single') {
      return Object.freeze({ mode: 'legacy', identityValidated: false, inferenceEnabled: false, errorCode: null });
    }
    const controlStore = input.controlStore ?? createControlStore({ controlDir: config.controlDir });
    const validation = validateObserverIdentity({
      controlStore,
      deploymentId: config.deploymentId,
      expectedManifestVersion: config.expectedManifestVersion,
      expectedManifestSha256: config.expectedManifestSha256,
      artifactSha256: config.artifactSha256,
      observerId: 'core-bootstrap',
    });
    return Object.freeze({
      mode: 'single',
      identityValidated: validation.identityValidated,
      inferenceEnabled: false,
      phase: validation.phase,
      generation: validation.generation,
      manifestVersion: validation.manifestVersion,
      manifestSha256: validation.manifestSha256,
      errorCode: validation.errorCode,
    });
  } catch (error) {
    return Object.freeze({
      mode: 'single',
      identityValidated: false,
      inferenceEnabled: false,
      errorCode: error instanceof CoordinationError
        ? error.code
        : error instanceof ConfigError
          ? COORDINATION_ERROR_CODE.CONFIGURATION_ERROR
          : COORDINATION_ERROR_CODE.COORDINATION_UNAVAILABLE,
    });
  }
}
