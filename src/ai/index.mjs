/**
 * AI analysis layer (MASTER_SPEC §10, §11, §36–§39).
 *
 * Optional, model-independent, read-only. Nothing in this module can reach the
 * exchange or the execution path.
 * @module ai
 */
export * from './types.mjs';
export * from './interface.mjs';
export * from './analysis-schema.mjs';
export * from './context-builder.mjs';
export * from './prompts.mjs';
export * from './mock-provider.mjs';
