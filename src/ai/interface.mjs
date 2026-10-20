/**
 * AIProvider — the model-independent analysis contract (MASTER_SPEC §10, §39).
 *
 * An AI provider turns a controlled `AIContext` (§37) into a validated
 * `AIAnalysis` (§11). It is an OPTIONAL analytical component: it never places
 * an order, never sizes a position and never sees credentials. The deterministic
 * Risk Engine remains the only gate before execution.
 *
 * Fail-closed by construction: `analyze()` resolves to an outcome, and a bad
 * model response, a schema violation or a provider failure is reported as
 * `ok: false` (MASTER_SPEC §11 "invalid AI output = NO TRADE"). Only programmer
 * errors — a malformed context or a malformed provider definition — throw.
 *
 * @module ai/interface
 */
import { ConfigError } from '../config/config-error.mjs';

/** Version of the `AIAnalysis` shape this layer produces. */
export const AI_ANALYSIS_SCHEMA_VERSION = '1';

/** Terminal status of one analysis attempt. */
export const AI_STATUS = Object.freeze({
  /** A schema-valid analysis was produced. */
  OK: 'OK',
  /** The model answered, but the answer was unusable — treat as NO TRADE. */
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  /** The provider never produced an answer (network/auth/rate-limit). */
  PROVIDER_ERROR: 'PROVIDER_ERROR',
});

/**
 * @typedef {object} AIAnalysisOutcome
 * @property {boolean} ok true only when a validated analysis is present
 * @property {string} status one of AI_STATUS
 * @property {Readonly<import('./types.mjs').AIAnalysis> | null} analysis
 * @property {readonly string[]} issues machine-readable failure reasons
 * @property {string | null} modelId model that answered, when known
 * @property {string} promptVersion prompt version used for this decision (§38)
 * @property {number} receivedAt epoch milliseconds the attempt finished
 */

/**
 * Freeze a well-formed outcome. Callers can never mutate it, so an audit trail
 * built from outcomes cannot be altered after the fact.
 *
 * @param {{
 *   status: string,
 *   analysis?: object | null,
 *   issues?: readonly string[],
 *   modelId?: string | null,
 *   promptVersion: string,
 *   receivedAt: number,
 * }} fields
 * @returns {Readonly<AIAnalysisOutcome>}
 */
export function createAIAnalysisOutcome(fields) {
  if (fields === null || typeof fields !== 'object') {
    throw new ConfigError('createAIAnalysisOutcome requires an object');
  }
  const analysis = fields.analysis ?? null;
  const issues = Array.isArray(fields.issues) ? fields.issues.map(String) : [];
  const status = typeof fields.status === 'string' ? fields.status : AI_STATUS.PROVIDER_ERROR;
  return Object.freeze({
    ok: status === AI_STATUS.OK && analysis !== null,
    status,
    analysis,
    issues: Object.freeze(issues),
    modelId: fields.modelId ?? null,
    promptVersion: typeof fields.promptVersion === 'string' ? fields.promptVersion : 'unknown',
    receivedAt: Number.isFinite(fields.receivedAt) ? fields.receivedAt : 0,
  });
}

/**
 * The AIProvider contract: a stable `id`, the concrete `modelId`, the
 * `promptVersion` an answer must be attributed to, and an `analyze(context)`
 * function that resolves to an `AIAnalysisOutcome`.
 *
 * The contract is deliberately narrow: a provider cannot receive an account,
 * an order or a credential through it, and cannot return anything but a
 * validated `AIAnalysis` inside an outcome.
 *
 * @typedef {object} AIProvider
 * @property {string} id stable provider identifier, e.g. "deepseek"
 * @property {string} modelId concrete model that will answer
 * @property {string} promptVersion version of the prompt this provider sends
 * @property {(context: Readonly<import('./types.mjs').AIContext>) => Promise<Readonly<AIAnalysisOutcome>>} analyze
 */

/**
 * Validate and freeze a provider definition. Throws `ConfigError` on a
 * malformed definition — a broken provider must fail at wiring time, not on the
 * first analysis.
 *
 * @param {object} definition
 * @returns {Readonly<AIProvider>}
 * @throws {ConfigError}
 */
export function defineAIProvider(definition) {
  if (definition === null || typeof definition !== 'object') {
    throw new ConfigError('defineAIProvider requires a definition object');
  }
  if (typeof definition.id !== 'string' || definition.id.trim() === '') {
    throw new ConfigError('AI provider id must be a non-empty string');
  }
  if (typeof definition.analyze !== 'function') {
    throw new ConfigError(`AI provider "${definition.id}" must provide an analyze(context) function`);
  }
  if (typeof definition.modelId !== 'string' || definition.modelId.trim() === '') {
    throw new ConfigError(`AI provider "${definition.id}" must declare a non-empty modelId`);
  }
  if (typeof definition.promptVersion !== 'string' || definition.promptVersion.trim() === '') {
    throw new ConfigError(`AI provider "${definition.id}" must declare a non-empty promptVersion`);
  }

  return Object.freeze({
    id: definition.id.trim(),
    modelId: definition.modelId.trim(),
    promptVersion: definition.promptVersion.trim(),
    analyze: definition.analyze,
  });
}

/**
 * @param {unknown} provider
 * @returns {AIProvider}
 * @throws {ConfigError} unless the value is a usable provider
 */
export function assertAIProvider(provider) {
  if (
    provider === null ||
    typeof provider !== 'object' ||
    typeof provider.id !== 'string' ||
    typeof provider.analyze !== 'function' ||
    typeof provider.modelId !== 'string' ||
    typeof provider.promptVersion !== 'string'
  ) {
    throw new ConfigError(
      'expected an AIProvider with an id, a modelId, a promptVersion and an analyze(context) function',
    );
  }
  return /** @type {AIProvider} */ (provider);
}
