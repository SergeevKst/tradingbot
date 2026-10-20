/**
 * Structured AI output: the JSON schema and its fail-closed validator
 * (MASTER_SPEC §11, §36).
 *
 * AI-generated output is untrusted input. A model answers with a CLOSED JSON
 * object describing a directional bias, and that object is validated before any
 * domain type is built. A missing field, an unknown field, an out-of-range
 * confidence or unparseable text all yield `valid: false` — never a partially
 * populated analysis that a later layer might act on.
 *
 * The model controls only the analysis. It cannot set `symbol`, `modelId`,
 * `generatedAt` or `schemaVersion`: those are stamped by the provider from the
 * request context and the clock, so a model cannot spoof the instrument or the
 * time of its own analysis.
 *
 * @module ai/analysis-schema
 */
import { ANALYSIS_BIASES } from '../types/enums.mjs';
import { createAIAnalysis } from '../domain/ai-analysis.mjs';

/** The exact, closed set of JSON fields a model is allowed to return. */
export const AI_ANALYSIS_OUTPUT_FIELDS = Object.freeze(['bias', 'confidence', 'rationale', 'evidence']);

const MAX_RATIONALE_LENGTH = 2000;
const MAX_EVIDENCE_ITEMS = 20;

/**
 * JSON Schema (draft 2020-12) for the model's response. Kept as data so it can
 * be embedded in the prompt and asserted against in tests; the runtime check
 * below is the authoritative one.
 */
export const AI_ANALYSIS_OUTPUT_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'AIAnalysisOutput',
  type: 'object',
  additionalProperties: false,
  required: ['bias', 'confidence', 'rationale'],
  properties: {
    bias: { type: 'string', enum: Object.freeze([...ANALYSIS_BIASES]) },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', minLength: 1, maxLength: MAX_RATIONALE_LENGTH },
    evidence: {
      type: 'array',
      maxItems: MAX_EVIDENCE_ITEMS,
      items: { type: 'string', minLength: 1 },
    },
  },
});

/**
 * @typedef {object} AIAnalysisOutput
 * @property {'BULLISH' | 'BEARISH' | 'NEUTRAL'} bias
 * @property {number} confidence in [0, 1]
 * @property {string} rationale
 * @property {readonly string[] | undefined} evidence
 */

/**
 * Parse the model's textual answer.
 *
 * Strict on purpose: a response wrapped in Markdown fences, an array or any
 * non-JSON prose is rejected rather than salvaged, because guessing at a
 * model's intent is exactly the failure mode §11 forbids.
 *
 * @param {unknown} raw text returned by the model, or an already-parsed object
 * @returns {{ ok: true, value: object } | { ok: false, issues: string[] }}
 */
export function parseModelResponse(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ok: true, value: /** @type {object} */ (raw) };
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, issues: ['model response is not a non-empty JSON string'] };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, issues: ['model response must be a JSON object'] };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, issues: ['model response is not valid JSON'] };
  }
}

/**
 * Validate a parsed model response against the schema.
 *
 * @param {unknown} raw
 * @returns {{ valid: true, value: AIAnalysisOutput } | { valid: false, issues: string[] }}
 */
export function validateAnalysisOutput(raw) {
  /** @type {string[]} */
  const issues = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, issues: ['AI analysis output must be a JSON object'] };
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  for (const key of Object.keys(input)) {
    if (!AI_ANALYSIS_OUTPUT_FIELDS.includes(key)) {
      issues.push(`unknown field "${key}" is not part of the AI analysis schema and is rejected`);
    }
  }

  const bias = typeof input.bias === 'string' ? input.bias.trim().toUpperCase() : '';
  if (!ANALYSIS_BIASES.includes(bias)) {
    issues.push(`"bias" must be one of: ${ANALYSIS_BIASES.join(', ')} — got ${JSON.stringify(input.bias)}`);
  }

  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)) {
    issues.push(`"confidence" must be a finite number, got ${JSON.stringify(input.confidence)}`);
  } else if (input.confidence < 0 || input.confidence > 1) {
    issues.push(`"confidence" must be within [0, 1], got ${input.confidence}`);
  }

  if (typeof input.rationale !== 'string' || input.rationale.trim() === '') {
    issues.push('"rationale" must be a non-empty string');
  } else if (input.rationale.trim().length > MAX_RATIONALE_LENGTH) {
    issues.push(`"rationale" must be at most ${MAX_RATIONALE_LENGTH} characters`);
  }

  /** @type {readonly string[] | undefined} */
  let evidence;
  if (input.evidence !== undefined && input.evidence !== null) {
    if (!Array.isArray(input.evidence)) {
      issues.push('"evidence" must be an array of strings');
    } else if (input.evidence.length > MAX_EVIDENCE_ITEMS) {
      issues.push(`"evidence" must contain at most ${MAX_EVIDENCE_ITEMS} items`);
    } else if (input.evidence.some((item) => typeof item !== 'string' || item.trim() === '')) {
      issues.push('"evidence" entries must be non-empty strings');
    } else {
      evidence = Object.freeze(input.evidence.map((item) => /** @type {string} */ (item).trim()));
    }
  }

  if (issues.length > 0) return { valid: false, issues };

  return {
    valid: true,
    value: Object.freeze({
      bias: /** @type {'BULLISH' | 'BEARISH' | 'NEUTRAL'} */ (bias),
      confidence: /** @type {number} */ (input.confidence),
      rationale: /** @type {string} */ (input.rationale).trim(),
      evidence,
    }),
  };
}

/**
 * Build the final, frozen `AIAnalysis` domain object.
 *
 * `symbol`, `modelId`, `generatedAt` and `schemaVersion` are supplied by the
 * caller — never by the model — so an analysis is always attributable to the
 * request it answered.
 *
 * @param {AIAnalysisOutput} value validated schema output
 * @param {{ symbol: string, modelId: string, generatedAt: number, schemaVersion: string }} stamp
 * @returns {Readonly<import('../domain/ai-analysis.mjs').AIAnalysis>}
 * @throws {import('../errors/taxonomy.mjs').ValidationError}
 */
export function finalizeAnalysis(value, stamp) {
  return createAIAnalysis({
    schemaVersion: stamp.schemaVersion,
    symbol: stamp.symbol,
    bias: value.bias,
    confidence: value.confidence,
    rationale: value.rationale,
    evidence: value.evidence,
    modelId: stamp.modelId,
    generatedAt: stamp.generatedAt,
  });
}
