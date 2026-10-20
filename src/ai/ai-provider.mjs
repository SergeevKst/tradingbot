/**
 * Compatibility shim.
 *
 * The AIProvider contract now lives in `./interface.mjs`. This module is kept so
 * existing imports (`mock-provider.mjs`, `providers/deepseek/*`) keep working;
 * new code should import the contract from `./interface.mjs` directly.
 *
 * @module ai/ai-provider
 */
export * from './interface.mjs';
