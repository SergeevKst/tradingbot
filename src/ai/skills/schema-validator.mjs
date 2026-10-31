/**
 * Bounded JSON Schema 2020-12 compilation for Skill Package contracts
 * (architecture v1.1 §4.4).
 *
 * The package format already rejects unsupported keywords structurally
 * (`validateSchemaDocument`). This module adds the second line of defence: a
 * pinned Ajv 8 instance that compiles with coercion, defaulting, property
 * removal, external reference loading and format callbacks disabled. Schemas are
 * compiled once per prepared package, never per request.
 *
 * Validation failures are ordinary per-request failures: invalid *input* is
 * `SKILL_INPUT_INVALID`, invalid *output* is `SKILL_OUTPUT_INVALID`. Neither is
 * structural and neither may be turned into an admission latch.
 *
 * @module ai/skills/schema-validator
 */
import Ajv2020 from 'ajv/dist/2020.js';
import { structuralError } from '../../errors/skill-error.mjs';

/** Ajv options reviewed for the v2 contract. */
export const AJV_OPTIONS = Object.freeze({
  strict: true,
  strictTypes: false,
  logger: false,
  allErrors: false,
  validateFormats: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  allowUnionTypes: false,
  ownProperties: true,
  verbose: false,
});

/**
 * Compile a package schema. The compiled validator has no I/O surface: Ajv with
 * `loadSchema` unset refuses remote `$ref` resolution, and the subset validator
 * already rejected anything but local `$defs`.
 *
 * @param {unknown} schema
 * @param {string} label
 * @returns {(value: unknown) => boolean}
 */
export function compileSkillSchema(schema, label) {
  const ajv = new Ajv2020({ ...AJV_OPTIONS });
  let validator;
  try {
    validator = ajv.compile(/** @type {object} */ (schema));
  } catch (error) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label} cannot be compiled by the bounded validator`, {
      field: label,
    });
  }
  if (typeof validator !== 'function') {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label} did not compile to a validator`, { field: label });
  }
  return validator;
}

/**
 * Validate an instance against a compiled schema.
 *
 * @param {(value: unknown) => boolean} validator
 * @param {unknown} value
 * @returns {boolean}
 */
export function instanceValid(validator, value) {
  try {
    return validator(value) === true;
  } catch {
    // A validator that throws (e.g. hostile getter) is a failure, never a pass.
    return false;
  }
}

/**
 * Verify every example and every declarative acceptance case that only depends
 * on the package's own schemas.
 *
 * @param {import('../../config/skill-package.mjs').VerifiedPackage} pkg
 * @param {{ inputValidator: (value: unknown) => boolean, outputValidator: (value: unknown) => boolean }} validators
 */
export function validatePackageFixtures(pkg, validators) {
  for (const example of pkg.examples) {
    if (!instanceValid(validators.inputValidator, /** @type {any} */ (example.value).input)) {
      throw structuralError('SKILL_SCHEMA_INVALID', `${example.path}: input does not satisfy input.schema.json`, {
        field: example.path,
      });
    }
    if (!instanceValid(validators.outputValidator, /** @type {any} */ (example.value).expectedOutput)) {
      throw structuralError('SKILL_SCHEMA_INVALID', `${example.path}: expectedOutput does not satisfy output.schema.json`, {
        field: example.path,
      });
    }
  }
}
