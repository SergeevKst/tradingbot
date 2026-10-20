/**
 * MockAIProvider — a deterministic, offline provider (MASTER_SPEC §10, §39).
 *
 * It exists so the AI layer can be exercised end-to-end without a network, a
 * model or a credential. It returns exactly the same validated `AIAnalysis`
 * shape a real provider does, and can be told to answer invalidly so tests can
 * pin the fail-closed path.
 *
 * @module ai/mock-provider
 */
import { ValidationError } from '../errors/taxonomy.mjs';
import { AI_ANALYSIS_SCHEMA_VERSION, AI_STATUS, createAIAnalysisOutcome, defineAIProvider } from './ai-provider.mjs';
import { finalizeAnalysis } from './analysis-schema.mjs';
import { PROMPT_VERSION } from './prompts.mjs';

export const MOCK_PROVIDER_ID = 'mock';

/**
 * @param {{
 *   bias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
 *   confidence?: number,
 *   rationale?: string,
 *   evidence?: string[],
 *   modelId?: string,
 *   now?: () => number,
 *   invalid?: boolean,
 * }} [options]
 * @returns {Readonly<import('./ai-provider.mjs').AIProvider>}
 */
export function createMockProvider(options = {}) {
  const bias = options.bias ?? 'NEUTRAL';
  const confidence = options.confidence ?? 0.5;
  const rationale = options.rationale ?? 'mock analysis';
  const evidence = options.evidence ?? ['mock'];
  const modelId = options.modelId ?? 'mock-model';
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const invalid = options.invalid === true;

  async function analyze(context) {
    const receivedAt = now();
    if (invalid || context === null || typeof context !== 'object') {
      return createAIAnalysisOutcome({
        status: AI_STATUS.INVALID_OUTPUT,
        issues: ['mock provider was configured to return invalid output'],
        modelId,
        promptVersion: PROMPT_VERSION,
        receivedAt,
      });
    }
    try {
      const analysis = finalizeAnalysis(
        { bias, confidence, rationale, evidence },
        { symbol: /** @type {any} */ (context).market.symbol, modelId, generatedAt: receivedAt, schemaVersion: AI_ANALYSIS_SCHEMA_VERSION },
      );
      return createAIAnalysisOutcome({
        status: AI_STATUS.OK,
        analysis,
        modelId,
        promptVersion: PROMPT_VERSION,
        receivedAt,
      });
    } catch (error) {
      return createAIAnalysisOutcome({
        status: AI_STATUS.INVALID_OUTPUT,
        issues: [error instanceof ValidationError ? error.message : 'mock provider could not build an analysis'],
        modelId,
        promptVersion: PROMPT_VERSION,
        receivedAt,
      });
    }
  }

  return defineAIProvider({ id: MOCK_PROVIDER_ID, modelId, promptVersion: PROMPT_VERSION, analyze });
}
