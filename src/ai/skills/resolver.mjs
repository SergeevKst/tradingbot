/**
 * Skill Resolver (architecture v1.1 §6).
 *
 * Given one operation, an immutable registry snapshot, the package CAS and the
 * reviewed runtime policy, the resolver produces an unforgeable prepared object
 * or a structural `SkillError`. It never selects a model (that is the execution
 * planner's job) and never falls back to a "latest" version, a default package
 * or an unapproved one.
 *
 * @module ai/skills/resolver
 */
import { structuralError } from '../../errors/skill-error.mjs';
import { validatePackageFixtures, compileSkillSchema } from './schema-validator.mjs';
import {
  verifyPublicationAttestation,
  verifyRevocation,
} from '../../config/skill-release-contracts.mjs';

/** Prepared objects are registered here; only this module can mint them. */
const PREPARED = new WeakSet();

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPreparedSkill(value) {
  return typeof value === 'object' && value !== null && PREPARED.has(value);
}

/**
 * Merge package limits with the host ceiling. A package can never raise the
 * host ceiling: every effective value is the minimum of the two.
 *
 * @param {Readonly<object>} packagePolicy
 * @param {Readonly<object>} hostLimits
 */
function mergeLimits(packagePolicy, hostLimits) {
  const limits = /** @type {any} */ (packagePolicy).limits;
  return Object.freeze({
    maxInputBytes: Math.min(limits.maxInputBytes, hostLimits.maxInputBytes),
    maxOutputBytes: Math.min(limits.maxOutputBytes, hostLimits.maxOutputBytes),
    maxOutputTokens: Math.min(limits.maxOutputTokens, hostLimits.maxOutputTokens),
    timeoutMs: Math.min(limits.timeoutMs, hostLimits.timeoutMs),
    maxModelCalls: Math.min(limits.maxModelCalls, hostLimits.maxModelCalls),
    maxToolCalls: Math.min(limits.maxToolCalls, hostLimits.maxToolCalls),
  });
}

/**
 * @param {{
 *   operation: string,
 *   registry: Readonly<object>,
 *   store: any,
 *   policy: Readonly<object>,
 *   artifact: Readonly<object>,
 *   adapter: Readonly<object>,
 *   trustRoots: Readonly<object>,
 * }} input
 * @returns {Readonly<object>}
 */
export function resolvePreparedSkill(input) {
  const { operation, registry, store, policy, artifact, adapter, trustRoots } = input;
  const ref = /** @type {any} */ (registry).operations[operation];
  if (!ref) {
    throw structuralError('SKILL_MISSING', `the skill registry has no package for ${operation}`, { operation });
  }

  // Revocation is checked before approval: a revoked package is never admitted
  // even if its approval attestation is still present.
  const revocationEnvelope = store.readRevocation(ref.packageDigestSha256);
  if (revocationEnvelope !== null) {
    verifyRevocation(revocationEnvelope, { trustRoots, packageRef: ref });
    throw structuralError('SKILL_REVOKED', `the ${operation} package is revoked`, { operation });
  }

  const attestationEnvelope = store.readAttestation(ref.packageDigestSha256);
  if (attestationEnvelope === null) {
    throw structuralError('SKILL_NOT_APPROVED', `the ${operation} package has no authorized publication approval`, {
      operation,
    });
  }
  const attestation = verifyPublicationAttestation(attestationEnvelope, {
    trustRoots,
    packageRef: ref,
  });

  const pkg = store.readPackage(ref, { artifact, expectedOperation: operation });

  const grant = /** @type {any} */ (policy).operationGrants[operation];
  for (const capability of /** @type {any} */ (pkg).policy.dataSources) {
    if (!grant.dataSources.includes(capability)) {
      throw structuralError('SKILL_POLICY_DENIED', `the ${operation} package requests ${capability}, which the host does not grant`, {
        operation,
      });
    }
  }

  const effectiveLimits = mergeLimits(/** @type {any} */ (pkg).policy, /** @type {any} */ (policy).limits);

  if (
    /** @type {any} */ (adapter).inputContract.id !== /** @type {any} */ (pkg).manifest.inputContract.id ||
    /** @type {any} */ (adapter).inputContract.version !== /** @type {any} */ (pkg).manifest.inputContract.version ||
    /** @type {any} */ (adapter).outputContract.id !== /** @type {any} */ (pkg).manifest.outputContract.id ||
    /** @type {any} */ (adapter).outputContract.version !== /** @type {any} */ (pkg).manifest.outputContract.version
  ) {
    throw structuralError('SKILL_INCOMPATIBLE', `the ${operation} package declares a contract this artifact does not implement`, {
      operation,
    });
  }

  const inputValidator = compileSkillSchema(/** @type {any} */ (pkg).inputSchema, `${operation} input.schema.json`);
  const outputValidator = compileSkillSchema(/** @type {any} */ (pkg).outputSchema, `${operation} output.schema.json`);
  validatePackageFixtures(/** @type {any} */ (pkg), { inputValidator, outputValidator });

  const prepared = Object.freeze({
    operation,
    skill: ref,
    package: pkg,
    attestation,
    inputValidator,
    outputValidator,
    layout: /** @type {any} */ (pkg).layout,
    instructions: /** @type {any} */ (pkg).instructions,
    policy: Object.freeze({
      dataSources: /** @type {any} */ (pkg).policy.dataSources,
      limits: effectiveLimits,
    }),
    adapter,
  });
  PREPARED.add(prepared);
  return prepared;
}
