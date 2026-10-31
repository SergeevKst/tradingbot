/**
 * Shared strict field helpers for the trusted host operation adapters
 * (architecture v1.1 §6.2).
 *
 * Adapters own the *domain* half of validation: instrument association,
 * ordering, geometry, non-whitespace prose and refusal to accept model-authored
 * order fields. They never compute PnL, sizing or risk decisions — those stay in
 * the deterministic engine.
 *
 * @module ai/skills/adapters/shared
 */
import { isPlainObject } from '../../../config/jcs.mjs';
import { ordinaryError } from '../../../errors/skill-error.mjs';

/**
 * @param {string} message
 * @param {string} field
 * @returns {never}
 */
export function inputInvalid(message, field) {
  throw ordinaryError('SKILL_INPUT_INVALID', message, { field });
}

/**
 * @param {string} message
 * @param {string} field
 * @returns {never}
 */
export function outputInvalid(message, field) {
  throw ordinaryError('SKILL_OUTPUT_INVALID', message, { field });
}

/**
 * Closed object: every key must be declared.
 *
 * @param {unknown} value
 * @param {string[]} keys
 * @param {string} label
 * @param {(message: string, field: string) => never} fail
 * @returns {Record<string, unknown>}
 */
export function closed(value, keys, label, fail) {
  if (!isPlainObject(value)) fail(`${label} must be an object`, label);
  const input = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) fail(`${label} has an unknown field ${JSON.stringify(key)}`, `${label}.${key}`);
  }
  return input;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{ nullable?: boolean, min?: number, max?: number }} [options]
 * @param {(message: string, field: string) => never} [fail]
 * @returns {number | null}
 */
export function finiteNumber(value, label, options = {}, fail = inputInvalid) {
  if (value === null && options.nullable === true) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`, label);
  const number = /** @type {number} */ (value);
  if (options.min !== undefined && number < options.min) fail(`${label} must be >= ${options.min}`, label);
  if (options.max !== undefined && number > options.max) fail(`${label} must be <= ${options.max}`, label);
  return number;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{ nullable?: boolean, minLength?: number, maxLength?: number, values?: readonly string[] }} [options]
 * @param {(message: string, field: string) => never} [fail]
 * @returns {string | null}
 */
export function stringField(value, label, options = {}, fail = inputInvalid) {
  if (value === null && options.nullable === true) return null;
  if (typeof value !== 'string') fail(`${label} must be a string`, label);
  const text = /** @type {string} */ (value);
  if (options.minLength !== undefined && text.trim().length < options.minLength) {
    fail(`${label} must have at least ${options.minLength} non-whitespace characters`, label);
  }
  if (options.maxLength !== undefined && [...text].length > options.maxLength) {
    fail(`${label} exceeds ${options.maxLength} characters`, label);
  }
  if (options.values && !options.values.includes(text)) {
    fail(`${label} must be one of ${options.values.join(', ')}`, label);
  }
  return text;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{ max?: number }} [options]
 * @param {(message: string, field: string) => never} [fail]
 * @returns {unknown[]}
 */
export function arrayField(value, label, options = {}, fail = inputInvalid) {
  if (!Array.isArray(value)) fail(`${label} must be an array`, label);
  const list = /** @type {unknown[]} */ (value);
  if (options.max !== undefined && list.length > options.max) fail(`${label} exceeds ${options.max} items`, label);
  return list;
}

/**
 * Deep-freeze a shaped DTO so the broker projection cannot be mutated by the
 * renderer, a validator or a transport.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(/** @type {any} */ (value))) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Reject secret-looking field names anywhere in a host snapshot. This is a
 * second line of defence behind the projection itself.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {(message: string, field: string) => never} [fail]
 */
export function refuseSecretFields(value, label, fail = inputInvalid) {
  const forbidden = ['secret', 'apikey', 'api_key', 'password', 'passwd', 'token', 'authorization', 'signature', 'privatekey', 'private_key', 'credential'];
  /** @param {unknown} node @param {string} at */
  const walk = (node, at) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(/** @type {Record<string, unknown>} */ (node))) {
      const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
      if (forbidden.some((pattern) => normalized.includes(pattern.replace(/[-_\s]/g, '')))) {
        fail(`${at}.${key} names a credential-like field`, `${at}.${key}`);
      }
      walk(child, `${at}.${key}`);
    }
  };
  walk(value, label);
}

/**
 * @param {string} operation
 * @param {string} adapterId
 * @param {{ id: string, version: string }} inputContract
 * @param {{ id: string, version: string }} outputContract
 * @param {readonly string[]} dataSources
 * @param {(hostInput: unknown) => unknown} shape
 * @param {(value: unknown) => unknown} validateOutput
 */
export function defineAdapter(operation, adapterId, inputContract, outputContract, dataSources, shape, validateOutput) {
  return Object.freeze({
    operation,
    adapterId,
    adapterContractVersion: /** @type {1} */ (1),
    inputContract: Object.freeze({ ...inputContract }),
    outputContract: Object.freeze({ ...outputContract }),
    dataSources: Object.freeze([...dataSources]),
    /** @param {unknown} hostInput */
    shape: (hostInput) => deepFreeze(shape(hostInput)),
    /** @param {unknown} value */
    validateOutput: (value) => validateOutput(value),
  });
}
