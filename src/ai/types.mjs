/**
 * AI data contracts: `AIContext` and `AIAnalysis` (MASTER_SPEC §7, §10, §11, §37).
 *
 * This module is pure TYPES and VALIDATORs — no provider, prompt, network call
 * or model dependency. The `AIAnalysis` shape itself lives in
 * `domain/ai-analysis.mjs` (one closed schema, reused here); `AIContext` is the
 * whitelisted view a provider is allowed to see.
 *
 * Safety rule enforced here: neither contract may carry `quantity`, `leverage`
 * or any other sizing field. A model must never be handed — or return — a
 * number it could mistake for a position size; the deterministic Risk Engine
 * stays the only component that sizes (MASTER_SPEC §10).
 *
 * @module ai/types
 */
import { AI_ANALYSIS_FIELDS, createAIAnalysis } from '../domain/ai-analysis.mjs';
import { assertClosedFields, assertEpochMillis, assertPlainObject, assertRequiredString } from '../types/primitives.mjs';
import { ValidationError } from '../errors/taxonomy.mjs';

/**
 * The exact, closed set of top-level `AIContext` fields.
 *
 * Kept as data so the context builder and its tests cannot drift: a field added
 * to a context must be added here on purpose.
 */
export const AI_CONTEXT_FIELDS = Object.freeze([
  'schemaVersion',
  'generatedAt',
  'market',
  'position',
  'portfolio',
  'strategy',
  'risk',
]);

/** Normalized field names that must never appear in an AI contract. */
export const AI_SIZING_FIELDS = Object.freeze(['quantity', 'qty', 'leverage', 'positionsize', 'ordersize', 'size']);

/**
 * @typedef {object} AIContext
 * @property {string} schemaVersion version of the context shape
 * @property {number} generatedAt epoch milliseconds the context was built
 * @property {Readonly<{ symbol: string }>} market market snapshot, symbol required
 * @property {object | null} [position] open position WITHOUT quantity/leverage
 * @property {object | null} [portfolio]
 * @property {object | null} [strategy]
 * @property {object | null} [risk] risk LIMITS only (no leverage)
 */

/**
 * @typedef {import('../domain/ai-analysis.mjs').AIAnalysis} AIAnalysis
 */

/**
 * Reject any sizing field anywhere in a value.
 *
 * Fail closed and recursive: a sizing number hidden inside a nested position or
 * an array is still a sizing number, so the whole value is refused rather than
 * copied.
 *
 * @param {unknown} value
 * @param {string} [path]
 * @throws {ValidationError}
 */
export function assertNoSizingFields(value, path = 'AIContext') {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSizingFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
    if (AI_SIZING_FIELDS.includes(normalized)) {
      throw new ValidationError(`${path}.${key} is a sizing field and is forbidden in an AI contract`, {
        details: { field: `${path}.${key}` },
      });
    }
    assertNoSizingFields(item, `${path}.${key}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @throws {ValidationError}
 */
function assertNullableObject(value, label) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object or null`, { details: { field: label } });
  }
}

/**
 * Validate an `AIContext`.
 *
 * @param {unknown} raw
 * @returns {Readonly<AIContext>}
 * @throws {ValidationError}
 */
export function assertAIContext(raw) {
  const input = assertPlainObject(raw, 'AIContext');
  assertClosedFields(input, AI_CONTEXT_FIELDS, 'AIContext');
  assertRequiredString(input.schemaVersion, 'AIContext.schemaVersion', { maxLength: 16 });
  assertEpochMillis(input.generatedAt, 'AIContext.generatedAt');

  const market = assertPlainObject(input.market, 'AIContext.market');
  assertRequiredString(market.symbol, 'AIContext.market.symbol');

  assertNullableObject(input.position, 'AIContext.position');
  assertNullableObject(input.portfolio, 'AIContext.portfolio');
  assertNullableObject(input.strategy, 'AIContext.strategy');
  assertNullableObject(input.risk, 'AIContext.risk');

  assertNoSizingFields(input, 'AIContext');
  return /** @type {Readonly<AIContext>} */ (raw);
}

export { AI_ANALYSIS_FIELDS };

/**
 * Validate and freeze an `AIAnalysis`. Alias of the domain constructor so the AI
 * layer has one import path for its output contract.
 *
 * @param {unknown} raw
 * @returns {Readonly<AIAnalysis>}
 * @throws {ValidationError}
 */
export const assertAIAnalysis = createAIAnalysis;
