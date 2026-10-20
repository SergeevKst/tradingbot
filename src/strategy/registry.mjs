/**
 * StrategyRegistry — pluggable strategies, looked up by id.
 *
 * Registration is fail-closed: a malformed strategy or duplicate id throws
 * rather than silently shadowing one. An unknown id throws too, so a typo can
 * never fall through to "no strategy".
 *
 * @module strategy/registry
 */
import { ConfigError } from '../config/config-error.mjs';
import { assertStrategy } from './strategy-interface.mjs';
import { createMaCrossoverStrategy } from './deterministic-ma-crossover.mjs';

/**
 * Create a registry, optionally pre-populated.
 * @param {object[]} [strategies]
 */
export function createStrategyRegistry(strategies = []) {
  /** @type {Map<string, object>} */
  const byId = new Map();

  function register(strategy) {
    const valid = assertStrategy(strategy);
    if (byId.has(valid.id)) throw new ConfigError(`strategy "${valid.id}" is already registered`);
    byId.set(valid.id, valid);
    return valid;
  }

  for (const strategy of strategies) register(strategy);

  return Object.freeze({
    register,
    /** @returns {object} @throws {ConfigError} when the id is unknown */
    get(id) {
      const strategy = byId.get(id);
      if (!strategy) throw new ConfigError(`unknown strategy "${id}" — registered: ${[...byId.keys()].join(', ') || '(none)'}`);
      return strategy;
    },
    /** @returns {object | null} */
    tryGet: (id) => byId.get(id) ?? null,
    has: (id) => byId.has(id),
    /** @returns {readonly string[]} */
    list: () => Object.freeze([...byId.keys()]),
    size: () => byId.size,
  });
}

/** Registry holding the project's built-in strategies. */
export function createDefaultStrategyRegistry() {
  return createStrategyRegistry([createMaCrossoverStrategy()]);
}
