/**
 * Versioned AI prompts (MASTER_SPEC §36, §38).
 *
 * Every prompt carries a stable version string, and every recorded decision
 * stores it, so model behaviour can be analysed against the exact instruction
 * that produced it.
 *
 * A prompt is built only from a context produced by `context-builder.mjs`.
 * As defence in depth, the rendered prompt is scanned for secret-looking field
 * names and refused if one appears — the builder whitelists fields, and this
 * check makes a future regression fail closed instead of leaking.
 *
 * @module ai/prompts
 */
import { ConfigError } from '../config/config-error.mjs';
import { AI_ANALYSIS_OUTPUT_JSON_SCHEMA } from './analysis-schema.mjs';

/** Prompt version recorded with every analysis (§38). */
export const PROMPT_VERSION = 'market-analysis-v1';

/** Field-name fragments that must never appear in a prompt. */
const FORBIDDEN_KEY_PATTERNS = Object.freeze([
  'secret',
  'apikey',
  'api_key',
  'password',
  'passwd',
  'token',
  'authorization',
  'signature',
  'privatekey',
  'private_key',
  'credential',
]);

/**
 * The system instruction. It fixes the output shape, restates that the model
 * only advises, and forbids sizing language.
 */
export const AI_SYSTEM_PROMPT = Object.freeze(
  [
    'You are a market analysis component inside a deterministic trading system.',
    'You advise only. You never place orders, never size positions and never set leverage.',
    'Respond with a single JSON object and nothing else — no prose, no Markdown fences.',
    'The object has exactly these fields:',
    `- bias: one of ${AI_ANALYSIS_OUTPUT_JSON_SCHEMA.properties.bias.enum.join(', ')}`,
    '- confidence: a number in [0, 1]',
    '- rationale: a short, concrete explanation',
    '- evidence: an optional array of short strings',
    'Do not include quantity, leverage, position size or order instructions of any kind.',
    'If the context is insufficient, answer with bias NEUTRAL and a low confidence.',
  ].join('\n'),
);

/**
 * @param {unknown} value
 * @param {string} path
 */
function assertNoSecretFields(value, path = '$') {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
    if (FORBIDDEN_KEY_PATTERNS.some((pattern) => normalized.includes(pattern.replace(/[-_\s]/g, '')))) {
      throw new ConfigError(`AI prompt refuses context field "${path}.${key}": secret-looking names are forbidden`, {
        field: `${path}.${key}`,
      });
    }
    assertNoSecretFields(item, `${path}.${key}`);
  }
}

/**
 * @typedef {object} AnalysisPrompt
 * @property {string} version prompt version (§38)
 * @property {string} system system instruction
 * @property {string} user serialized, validated context
 */

/**
 * Build the versioned prompt for one context.
 *
 * @param {object} context output of `buildAIContext`
 * @returns {Readonly<AnalysisPrompt>}
 * @throws {ConfigError} when the context is not an object or carries secret-looking fields
 */
export function buildAnalysisPrompt(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    throw new ConfigError('buildAnalysisPrompt requires a context object', { field: 'context' });
  }
  assertNoSecretFields(context);
  return Object.freeze({
    version: PROMPT_VERSION,
    system: AI_SYSTEM_PROMPT,
    user: JSON.stringify(context),
  });
}
