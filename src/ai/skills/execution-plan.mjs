/**
 * Execution plan builder (architecture v1.1 §6, §7.1).
 *
 * Pairs each of the six resolved Skills with its Model Registry identity, the
 * verified profile bytes and the reviewed capability evidence, then hashes the
 * complete plan. Every pair is required: a candidate whose six pairs are not all
 * verified cannot be prepared, so it can never reach ARMED.
 *
 * The planner is the only place where Skill identity meets Model identity. It
 * performs no inference and never consults the network.
 *
 * @module ai/skills/execution-plan
 */
import { digestJson } from '../../config/jcs.mjs';
import {
  computeExecutionPlanDigest,
  computeModelIdentitySha256,
  validateCapabilityEvidence,
  validateExecutionPlan,
} from '../../config/skill-release-contracts.mjs';
import { AI_OPERATIONS, getOperationSettings } from '../operation-profiles.mjs';
import { resolveOperationModel } from '../model-resolver.mjs';
import { structuralError } from '../../errors/skill-error.mjs';
import { ADAPTERS } from './adapters/catalogue.mjs';
import { resolvePreparedSkill } from './resolver.mjs';

/**
 * @param {string} operation
 * @param {{ canonicalBaseUrl: string }} identity
 * @param {Readonly<object>} evidence
 */
function assertEndpointEvidence(operation, identity, evidence) {
  let host;
  try {
    const url = new URL(identity.canonicalBaseUrl);
    host = url.hostname;
    if (url.protocol !== 'https:' || !/\/v1$/.test(url.pathname)) {
      throw new Error('unsupported endpoint');
    }
  } catch {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `the ${operation} endpoint is not an approved https /v1 URL`, {
      operation,
      field: 'canonicalBaseUrl',
    });
  }
  const supported = /** @type {any} */ (evidence).endpointSupport.some(
    (entry) => entry.host === host && entry.path === '/v1/chat/completions',
  );
  if (!supported) {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `no reviewed capability evidence covers the ${operation} endpoint`, {
      operation,
      field: 'capabilityEvidence',
    });
  }
}

/**
 * @param {{
 *   operation: string,
 *   settings: Readonly<object>,
 *   skillCaps: Readonly<object>,
 *   evidence: Readonly<object>,
 *   policyLimits: Readonly<object>,
 *   effectiveLimits: Readonly<object>,
 * }} input
 */
function assertSettingsCompatible(input) {
  const { operation, settings, skillCaps, evidence, policyLimits, effectiveLimits } = /** @type {any} */ (input);
  const fail = (reason) => {
    // Must throw: an earlier version merely *constructed* the error, so every
    // capability check silently passed.
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `the ${operation} profile setting ${reason}`, {
      operation,
      field: 'profile.operations',
    });
  };
  if (settings.temperature < skillCaps.temperature.min || settings.temperature > skillCaps.temperature.max) {
    fail('temperature is outside the skill range');
  }
  if (settings.temperature < evidence.temperature.min || settings.temperature > evidence.temperature.max) {
    fail('temperature is outside the reviewed evidence range');
  }
  if (!skillCaps.responseFormats.includes(settings.responseFormat)) fail('responseFormat is not accepted by the skill');
  if (!evidence.responseFormats.includes(settings.responseFormat)) fail('responseFormat is not covered by evidence');
  if (!skillCaps.reasoningEfforts.includes(settings.reasoningEffort)) fail('reasoningEffort is not accepted by the skill');
  if (!evidence.reasoningEfforts.includes(settings.reasoningEffort)) fail('reasoningEffort is not covered by evidence');
  if (settings.stream !== false) fail('streaming is not an approved capability');
  if (settings.maxOutputTokens === null) {
    fail('maxOutputTokens must be a reviewed finite cap before activation');
  }
  if (settings.maxOutputTokens > skillCaps.maxOutputTokens) fail('maxOutputTokens exceeds the skill maximum');
  if (settings.maxOutputTokens < skillCaps.minOutputTokens) fail('maxOutputTokens is below the skill minimum');
  if (settings.maxOutputTokens > evidence.maxOutputTokens) fail('maxOutputTokens exceeds the reviewed evidence');
  if (settings.maxOutputTokens > policyLimits.maxOutputTokens) fail('maxOutputTokens exceeds the host limit');
  if (settings.timeoutMs > effectiveLimits.timeoutMs) fail('timeoutMs exceeds the host limit');
}

/**
 * Build and hash the complete six-operation plan.
 *
 * @param {{
 *   store: any,
 *   skillRegistrySha256: string,
 *   modelRegistrySha256: string,
 *   runtimePolicySha256: string,
 *   artifact: Readonly<object>,
 *   profileReader: { read: (profileSha256: string) => Readonly<object> },
 *   adapters?: Record<string, any>,
 * }} input
 * @returns {{ plan: Readonly<object>, planSha256: string, prepared: ReadonlyMap<string, Readonly<object>>, registry: Readonly<object>, modelRegistry: Readonly<object>, policy: Readonly<object>, trustRoots: Readonly<object>, artifact: Readonly<object> }}
 */
export function prepareExecutionPlan(input) {
  const registry = input.store.readRegistry(input.skillRegistrySha256);
  const modelRegistry = input.store.readModelRegistry(input.modelRegistrySha256);
  const policy = input.store.readRuntimePolicy(input.runtimePolicySha256);
  const trustRoots = input.store.readTrustRoots(/** @type {any} */ (policy).trustRootsSha256);
  if (trustRoots === null) {
    throw structuralError('SKILL_NOT_APPROVED', 'the runtime policy references trust roots that are not published', {
      field: 'runtimePolicy.trustRootsSha256',
    });
  }
  const adapters = input.adapters ?? ADAPTERS;
  /** @type {Map<string, Readonly<object>>} */
  const prepared = new Map();
  /** @type {Record<string, unknown>} */
  const operations = {};

  for (const operation of AI_OPERATIONS) {
    const adapter = adapters[operation];
    if (!adapter) {
      throw structuralError('SKILL_INCOMPATIBLE', `this artifact has no adapter for ${operation}`, { operation });
    }
    const skill = resolvePreparedSkill({
      operation,
      registry,
      store: input.store,
      policy,
      artifact: input.artifact,
      adapter,
      trustRoots,
    });

    // v2.0 has no automatic fallback: a non-null fallback entry would be a
    // silent second model identity outside the joint binding.
    const fallback = /** @type {any} */ (modelRegistry).fallbacks?.[operation] ?? null;
    if (fallback !== null) {
      throw structuralError('SKILL_CAPABILITY_MISMATCH', `the ${operation} route declares a fallback model, which v2.0 forbids`, {
        operation,
        field: 'modelRegistry.fallbacks',
      });
    }

    let identity;
    try {
      identity = resolveOperationModel(operation, modelRegistry);
    } catch (error) {
      throw structuralError('SKILL_REGISTRY_INVALID', `the ${operation} model route cannot be resolved`, { operation });
    }

    let profile;
    try {
      profile = input.profileReader.read(identity.profileDigestSha256);
    } catch {
      throw structuralError('SKILL_MISSING', `the ${operation} capability profile is not available`, {
        operation,
        field: 'profileSha256',
      });
    }
    let settings;
    try {
      settings = getOperationSettings(profile, operation);
    } catch {
      throw structuralError('SKILL_INCOMPATIBLE', `the ${operation} profile has no reviewed settings`, {
        operation,
        field: 'profileSha256',
      });
    }
    if (digestJson(/** @type {any} */ (profile), { label: 'capability profile' }) !== identity.profileDigestSha256) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', `the ${operation} profile bytes do not match their digest`, {
        operation,
        field: 'profileSha256',
      });
    }

    const modelIdentitySha256 = computeModelIdentitySha256({
      providerId: identity.providerId,
      modelId: identity.modelId,
      canonicalBaseUrl: identity.canonicalBaseUrl,
      trustTier: identity.trustTier,
      capabilityProfileSha256: identity.profileDigestSha256,
    });
    const evidenceRef = /** @type {any} */ (policy).capabilityEvidence[modelIdentitySha256];
    if (!evidenceRef) {
      throw structuralError(
        'SKILL_CAPABILITY_MISMATCH',
        `no reviewed capability evidence is pinned to the ${operation} model identity`,
        { operation, field: 'capabilityEvidence' },
      );
    }
    const evidenceDocument = input.store.readCapabilityEvidence(evidenceRef.evidenceSha256);
    if (evidenceDocument === null) {
      throw structuralError('SKILL_CAPABILITY_MISMATCH', `the ${operation} capability evidence bytes are not published`, {
        operation,
        field: 'capabilityEvidence',
      });
    }
    const evidence = validateCapabilityEvidence(evidenceDocument);
    if (digestJson(evidence, { label: 'capability evidence' }) !== evidenceRef.evidenceSha256) {
      throw structuralError('SKILL_INTEGRITY_MISMATCH', `the ${operation} capability evidence does not match its digest`, {
        operation,
        field: 'capabilityEvidence',
      });
    }
    if (evidence.modelIdentitySha256 !== modelIdentitySha256) {
      throw structuralError('SKILL_CAPABILITY_MISMATCH', `the ${operation} capability evidence covers a different model`, {
        operation,
        field: 'capabilityEvidence',
      });
    }
    if (evidence.adapterId !== adapter.adapterId || evidence.adapterContractVersion !== adapter.adapterContractVersion) {
      throw structuralError('SKILL_CAPABILITY_MISMATCH', `the ${operation} capability evidence covers a different adapter`, {
        operation,
        field: 'capabilityEvidence',
      });
    }
    assertEndpointEvidence(operation, identity, evidence);
    const effectiveLimits = /** @type {any} */ (/** @type {any} */ (skill).policy).limits;
    assertSettingsCompatible({
      operation,
      settings,
      skillCaps: /** @type {any} */ (/** @type {any} */ (skill).package).manifest.requiredModelCapabilities,
      evidence,
      policyLimits: /** @type {any} */ (policy).limits,
      effectiveLimits,
    });

    const manifest = /** @type {any} */ (/** @type {any} */ (skill).package).manifest;
    operations[operation] = Object.freeze({
      operation,
      skill: /** @type {any} */ (skill).skill,
      modelKey: /** @type {any} */ (modelRegistry).routingTable[operation],
      modelIdentitySha256,
      profileSha256: identity.profileDigestSha256,
      adapterId: adapter.adapterId,
      adapterContractVersion: 1,
      settingsSha256: digestJson(settings, { label: 'operation settings' }),
      capabilityEvidenceSha256: evidenceRef.evidenceSha256,
      effectivePolicySha256: digestJson(
        { dataSources: /** @type {any} */ (skill).policy.dataSources, limits: effectiveLimits },
        { label: 'effective policy' },
      ),
      inputContract: manifest.inputContract,
      outputContract: manifest.outputContract,
    });
    prepared.set(operation, Object.freeze({ ...skill, identity, settings, evidence, modelIdentitySha256 }));
  }

  const plan = validateExecutionPlan({
    schemaVersion: 1,
    skillRegistrySha256: input.skillRegistrySha256,
    modelRegistrySha256: input.modelRegistrySha256,
    runtimePolicySha256: input.runtimePolicySha256,
    operations,
  });

  return Object.freeze({
    plan,
    planSha256: computeExecutionPlanDigest(plan),
    prepared,
    registry,
    modelRegistry,
    policy,
    trustRoots,
    artifact: input.artifact,
  });
}
