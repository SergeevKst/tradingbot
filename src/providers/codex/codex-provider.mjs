/**
 * Codex AI provider — exposes the owner's Codex subscription as an `AIProvider`
 * (MASTER_SPEC §10, §39) without an API key and without a metered billing path.
 *
 * WHY A LOCAL PROCESS: the only officially supported way to reach Codex models
 * with a ChatGPT subscription is the Codex CLI. Its `codex exec` mode is the
 * documented non-interactive entry point; the CLI owns the subscription session
 * and refreshes it itself. This adapter therefore holds no credential, and it
 * must never fall back to `OPENAI_API_KEY` — the transport strips it from the
 * child environment.
 *
 * SAFETY PROPERTIES (asserted by tests):
 *   - the provider implements the same narrow contract as the DeepSeek adapter:
 *     it receives an `AIContext`, returns a validated `AIAnalysis` outcome, and
 *     cannot size, approve or execute;
 *   - structured output is demanded through `--output-schema` AND re-validated
 *     locally, because a model's own claim to have followed a schema is not
 *     evidence;
 *   - an unusable answer is `ok: false` — never a defaulted BULLISH/NEUTRAL;
 *   - Astra (`gpt-6-astra`) is refused unless the operation appears in the
 *     explicitly configured higher-reasoning allowlist; routine operations use
 *     the cheap workhorse model;
 *   - the model allowlist is closed: an identifier outside the reviewed catalog
 *     is a configuration error, not a request to try something unknown.
 *
 * @module providers/codex/codex-provider
 */
import { ConfigError } from '../../config/config-error.mjs';
import { isAppError } from '../../errors/index.mjs';
import { silentLogger } from '../../util/logger.mjs';
import {
  AI_ANALYSIS_SCHEMA_VERSION,
  AI_STATUS,
  createAIAnalysisOutcome,
  defineAIProvider,
} from '../../ai/interface.mjs';
import {
  AI_ANALYSIS_OUTPUT_JSON_SCHEMA,
  finalizeAnalysis,
  parseModelResponse,
  validateAnalysisOutput,
} from '../../ai/analysis-schema.mjs';
import { PROMPT_VERSION, buildAnalysisPrompt } from '../../ai/prompts.mjs';
import { AI_OPERATIONS } from '../../ai/operation-profiles.mjs';
import {
  CODEX_ASTRA_MODEL,
  CODEX_KNOWN_MODELS,
  CODEX_LOCAL_IDENTITY,
  CODEX_PROVIDER_ID,
  CODEX_ROUTINE_MODEL,
  CODEX_REASONING_EFFORTS,
  loadCodexProviderConfig,
} from '../../config/codex.mjs';

export {
  CODEX_ASTRA_MODEL,
  CODEX_KNOWN_MODELS,
  CODEX_LOCAL_IDENTITY,
  CODEX_PROVIDER_ID,
  CODEX_ROUTINE_MODEL,
  loadCodexProviderConfig,
};

/**
 * The JSON Schema handed to `codex exec --output-schema`.
 *
 * It is the reviewed analysis schema with one transport-imposed difference: the
 * Codex structured-output endpoint rejects a schema whose `required` list is not
 * exactly its property set ("'schema.required' is required to include every key
 * in properties"). So `evidence` is required here and may be an empty array.
 * Nothing about the accepted *values* changes — `validateAnalysisOutput` remains
 * the authoritative check either way.
 */
export const CODEX_ANALYSIS_OUTPUT_SCHEMA = Object.freeze({
  ...AI_ANALYSIS_OUTPUT_JSON_SCHEMA,
  // Same property definitions as the reviewed schema: `evidence` has no
  // minItems, so an empty array is acceptable and no value rule is relaxed.
  required: Object.freeze(['bias', 'confidence', 'rationale', 'evidence']),
});

/**
 * Enforce the model policy for one operation.
 *
 * Two independent rules, both fail-closed:
 *   1. the model must be one the reviewed catalog knows;
 *   2. Astra requires an explicit per-operation allowance.
 *
 * @param {{ model: string, operation: string, astraOperations?: readonly string[] }} input
 * @returns {{ model: string, operation: string, astra: boolean }}
 * @throws {ConfigError}
 */
export function assertCodexModelPolicy(input) {
  const { model, operation } = input ?? {};
  const astraOperations = Array.isArray(input?.astraOperations) ? input.astraOperations : [];
  if (typeof operation !== 'string' || !AI_OPERATIONS.includes(operation)) {
    throw new ConfigError(`codex operation must be one of ${AI_OPERATIONS.join(', ')}`, {
      field: 'operation',
      value: operation,
    });
  }
  if (typeof model !== 'string' || model.trim() === '') {
    throw new ConfigError('codex provider requires a non-empty model id', { field: 'model', value: model });
  }
  const normalized = model.trim();
  if (!CODEX_KNOWN_MODELS.includes(normalized)) {
    throw new ConfigError(
      `codex model ${JSON.stringify(normalized)} is not in the reviewed catalog (${CODEX_KNOWN_MODELS.join(', ')})`,
      { field: 'model', value: normalized },
    );
  }
  const astra = normalized === CODEX_ASTRA_MODEL;
  if (astra && !astraOperations.includes(operation)) {
    throw new ConfigError(
      `codex model ${CODEX_ASTRA_MODEL} is Astra and requires ${operation} to be an explicitly configured higher-reasoning operation (got ${JSON.stringify(astraOperations)})`,
      { field: 'astraOperations', value: astraOperations },
    );
  }
  return Object.freeze({ model: normalized, operation, astra });
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function issueCode(error) {
  return isAppError(error) ? /** @type {any} */ (error).code : 'AI_PROVIDER_ERROR';
}

/**
 * Build a Codex-backed `AIProvider`.
 *
 * @param {{
 *   model: string,
 *   transport: { complete: (request: object) => Promise<object> },
 *   operation?: string,
 *   astraOperations?: readonly string[],
 *   reasoningEffort?: 'low' | 'medium' | 'high' | null,
 *   timeoutMs?: number,
 *   now?: () => number,
 *   logger?: object,
 *   promptVersion?: string,
 * }} options
 * @returns {Readonly<import('../../ai/interface.mjs').AIProvider>}
 */
export function createCodexProvider(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createCodexProvider requires an options object', { field: 'options' });
  }
  const { transport } = options;
  if (transport === null || typeof transport !== 'object' || typeof transport.complete !== 'function') {
    throw new ConfigError('codex provider requires a transport with a complete(request) function', {
      field: 'transport',
    });
  }
  const operation = options.operation ?? 'ANALYZE';
  const policy = assertCodexModelPolicy({
    model: options.model,
    operation,
    astraOperations: options.astraOperations ?? [],
  });
  const reasoningEffort = options.reasoningEffort ?? null;
  if (reasoningEffort !== null && !CODEX_REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new ConfigError(`codex reasoningEffort must be null or one of ${CODEX_REASONING_EFFORTS.join(', ')}`, {
      field: 'reasoningEffort',
      value: reasoningEffort,
    });
  }
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError('codex timeoutMs must be a positive integer', { field: 'timeoutMs', value: timeoutMs });
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const logger = options.logger ?? silentLogger;
  const promptVersion = options.promptVersion ?? PROMPT_VERSION;

  /**
   * @param {object} context validated `AIContext`
   * @returns {Promise<Readonly<import('../../ai/interface.mjs').AIAnalysisOutcome>>}
   */
  async function analyze(context) {
    // A malformed context is a programming error and must throw, not be
    // reported as a model failure.
    const prompt = buildAnalysisPrompt(context);

    /** @type {any} */
    let result;
    try {
      result = await transport.complete({
        prompt: `${prompt.system}\n\n${prompt.user}`,
        model: policy.model,
        schema: CODEX_ANALYSIS_OUTPUT_SCHEMA,
        reasoningEffort,
        timeoutMs,
      });
    } catch (error) {
      logger.warn('codex provider call failed', { provider: CODEX_PROVIDER_ID, code: issueCode(error) });
      return createAIAnalysisOutcome({
        status: AI_STATUS.PROVIDER_ERROR,
        issues: [issueCode(error)],
        modelId: policy.model,
        promptVersion: prompt.version,
        receivedAt: now(),
      });
    }

    if (result === null || typeof result !== 'object' || result.ok !== true) {
      const reason = typeof result?.reason === 'string' ? result.reason : 'UNKNOWN';
      logger.warn('codex provider returned no usable answer', { provider: CODEX_PROVIDER_ID, reason });
      return createAIAnalysisOutcome({
        status: AI_STATUS.PROVIDER_ERROR,
        issues: [`CODEX_${reason}`],
        modelId: policy.model,
        promptVersion: prompt.version,
        receivedAt: now(),
      });
    }

    const parsed = parseModelResponse(result.content);
    if (!parsed.ok) {
      return createAIAnalysisOutcome({
        status: AI_STATUS.INVALID_OUTPUT,
        issues: parsed.issues,
        modelId: policy.model,
        promptVersion: prompt.version,
        receivedAt: now(),
      });
    }

    const validated = validateAnalysisOutput(parsed.value);
    if (!validated.valid) {
      return createAIAnalysisOutcome({
        status: AI_STATUS.INVALID_OUTPUT,
        issues: validated.issues,
        modelId: policy.model,
        promptVersion: prompt.version,
        receivedAt: now(),
      });
    }

    try {
      const symbol = /** @type {any} */ (context).market?.symbol;
      const analysis = finalizeAnalysis(validated.value, {
        symbol,
        modelId: policy.model,
        generatedAt: now(),
        schemaVersion: AI_ANALYSIS_SCHEMA_VERSION,
      });
      return createAIAnalysisOutcome({
        status: AI_STATUS.OK,
        analysis,
        modelId: policy.model,
        promptVersion: prompt.version,
        receivedAt: analysis.generatedAt,
      });
    } catch (error) {
      return createAIAnalysisOutcome({
        status: AI_STATUS.INVALID_OUTPUT,
        issues: [error instanceof Error ? error.message : 'analysis could not be finalized'],
        modelId: policy.model,
        promptVersion: prompt.version,
        receivedAt: now(),
      });
    }
  }

  return defineAIProvider({
    id: CODEX_PROVIDER_ID,
    modelId: policy.model,
    promptVersion,
    analyze,
  });
}
