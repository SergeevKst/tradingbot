/**
 * AIAnalysis — the domain schema for a model's market analysis (MASTER_SPEC §7, §11).
 *
 * This is a DATA CONTRACT ONLY. There is no AI provider, prompt, network call
 * or model dependency anywhere in this phase; the type exists so that when a
 * provider is added (Phase 6) its output has a closed, validated shape from the
 * start.
 *
 * Safety rule baked into the shape: an analysis carries a directional bias and
 * a confidence, but NO quantity, leverage or order. It is an input to a
 * decision layer at most, and the deterministic Risk Engine remains the only
 * gate before execution (§10). Invalid or unparseable output must be treated as
 * NO TRADE by callers, never coerced into a proposal.
 *
 * @module domain/ai-analysis
 */
import { ANALYSIS_BIAS } from '../types/enums.mjs';
import {
  assertClosedFields,
  assertEnumValue,
  assertEpochMillis,
  assertPlainObject,
  assertRequiredString,
  assertSymbol,
  assertUnitInterval,
} from '../types/primitives.mjs';
import { ValidationError } from '../errors/taxonomy.mjs';

export const AI_ANALYSIS_FIELDS = Object.freeze([
  'schemaVersion',
  'symbol',
  'bias',
  'confidence',
  'rationale',
  'evidence',
  'modelId',
  'generatedAt',
]);

/**
 * @typedef {object} AIAnalysis
 * @property {string} schemaVersion version of the analysis schema
 * @property {string} symbol
 * @property {'BULLISH' | 'BEARISH' | 'NEUTRAL'} bias never an order side
 * @property {number} confidence [0, 1]
 * @property {string} [rationale]
 * @property {readonly string[]} [evidence]
 * @property {string} modelId which model produced this
 * @property {number} generatedAt epoch milliseconds
 */

/**
 * Validate and freeze an AIAnalysis.
 *
 * @param {unknown} raw
 * @returns {Readonly<AIAnalysis>}
 * @throws {ValidationError}
 */
export function createAIAnalysis(raw) {
  const input = assertPlainObject(raw, 'AIAnalysis');
  assertClosedFields(input, AI_ANALYSIS_FIELDS, 'AIAnalysis');

  /** @type {readonly string[] | undefined} */
  let evidence;
  if (input.evidence !== undefined && input.evidence !== null) {
    if (!Array.isArray(input.evidence)) {
      throw new ValidationError('AIAnalysis.evidence must be an array of strings', {
        details: { field: 'evidence' },
      });
    }
    evidence = Object.freeze(
      input.evidence.map((entry, index) => assertRequiredString(entry, `AIAnalysis.evidence[${index}]`)),
    );
  }

  return Object.freeze({
    schemaVersion: assertRequiredString(input.schemaVersion, 'AIAnalysis.schemaVersion', { maxLength: 16 }),
    symbol: assertSymbol(input.symbol, 'AIAnalysis.symbol'),
    bias: assertEnumValue(input.bias, ANALYSIS_BIAS, 'AIAnalysis.bias', { uppercase: true }),
    confidence: assertUnitInterval(input.confidence, 'AIAnalysis.confidence'),
    rationale:
      input.rationale === undefined || input.rationale === null
        ? undefined
        : assertRequiredString(input.rationale, 'AIAnalysis.rationale', { maxLength: 2000 }),
    evidence,
    modelId: assertRequiredString(input.modelId, 'AIAnalysis.modelId'),
    generatedAt: assertEpochMillis(input.generatedAt, 'AIAnalysis.generatedAt'),
  });
}
