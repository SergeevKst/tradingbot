/**
 * Portable data-only Skill Package format, `skill-package-v1`
 * (architecture v1.1 §4).
 *
 * A package is inert reviewable data: a closed JSON manifest, literal UTF-8
 * Markdown instructions, two bounded JSON Schemas, a declarative
 * `policy.json`, a declarative `prompt-layout.json`, plus synthetic examples and
 * declarative acceptance cases. No executable content of any kind is accepted —
 * the extension allowlist, the path grammar and the executable-bit/symlink checks
 * in `readPackageFiles` all enforce that independently.
 *
 * Identity is content-addressed:
 *
 *   index     = { format: 'skill-package-v1',
 *                 files: [{ path, size, sha256 }, ...] }   // sorted by path
 *   digest    = SHA-256(JCS(index))
 *
 * The digest covers every payload file, examples and tests included, so a
 * test-only edit changes the identity and requires a new package version.
 * Nothing in this module performs I/O, reads credentials or calls a model.
 *
 * @module config/skill-package
 */
import { ConfigError } from './config-error.mjs';
import {
  canonicalizeJson,
  digestJson,
  isPlainObject,
  parseStrictJsonBytes,
  sha256Hex,
} from './jcs.mjs';
import { AI_OPERATIONS, MAX_OPERATION_TIMEOUT_MS } from '../ai/operation-profiles.mjs';
import {
  STRUCTURAL_SKILL_CAUSES,
  SkillError,
  structuralError,
} from '../errors/skill-error.mjs';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Format identifier committed to by the index. */
export const SKILL_PACKAGE_FORMAT = 'skill-package-v1';

/** Skill API version an artifact must declare to load v1 packages. */
export const SKILL_API_VERSION = 1;

/** Normative v2 limits (architecture §4.1). */
export const SKILL_PACKAGE_LIMITS = Object.freeze({
  maxFiles: 64,
  maxTotalBytes: 2 * 1024 * 1024,
  maxFileBytes: 256 * 1024,
  maxInstructionsBytes: 64 * 1024,
  maxSchemaBytes: 64 * 1024,
  maxJsonDepth: 32,
  maxPropertiesPerObject: 256,
  maxLayoutParts: 8,
  maxTitleChars: 120,
  maxDescriptionChars: 1000,
  maxLabelChars: 80,
});

/** Files every package must carry, at exactly these paths. */
export const REQUIRED_PACKAGE_FILES = Object.freeze([
  'skill.json',
  'instructions.md',
  'input.schema.json',
  'output.schema.json',
  'policy.json',
  'prompt-layout.json',
]);

/**
 * Host data-capability catalogue v1. A package may only declare a subset of the
 * capabilities its operation is granted; it can never widen this table.
 */
export const DATA_SOURCE_CATALOGUE = Object.freeze({
  ANALYZE: Object.freeze(['market.analysis.v1']),
  SCOUT: Object.freeze(['market.scout.v1', 'news.headlines.v1']),
  GUARD: Object.freeze(['market.guard.v1', 'news.headlines.v1']),
  MONITOR: Object.freeze(['position.monitor.v1', 'news.headlines.v1']),
  STOPCHECK: Object.freeze(['position.stopcheck.v1', 'news.headlines.v1']),
  REFLECT: Object.freeze(['trade.closed.v1', 'rules.pending.v1']),
});

/** Every capability id the host can project. */
export const ALL_DATA_SOURCES = Object.freeze(
  [...new Set(Object.values(DATA_SOURCE_CATALOGUE).flat())].sort(),
);

/** JSON Schema keywords a package schema may use (bounded subset, §4.4). */
export const ALLOWED_SCHEMA_KEYWORDS = Object.freeze([
  '$schema',
  '$defs',
  '$ref',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'anyOf',
]);

/** Closed expected values for a declarative acceptance case. */
export const ACCEPTANCE_EXPECTATIONS = Object.freeze([
  'VALID',
  'SKILL_INPUT_INVALID',
  'SKILL_OUTPUT_INVALID',
]);

const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RANGE_PATTERN = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/;
const CONTRACT_ID_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PATH_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)*$/;
const PROPERTY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const AUTHORIZATION_HEADER_PATTERN = /(authorization|api[-_]?key|secret|password|bearer\s)/i;

// ─── Small assertion helpers ─────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function assertNonEmptyString(value, field, max = 4096) {
  if (typeof value !== 'string' || value === '') {
    throw structuralError('SKILL_SCHEMA_INVALID', `${field} must be a non-empty string`, { field });
  }
  if (Buffer.byteLength(value, 'utf8') > max) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${field} exceeds ${max} bytes`, { field });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string[]} allowed
 * @param {string} field
 * @returns {string}
 */
function assertEnum(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${field} must be one of ${allowed.join(', ')}`, { field });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {string} field
 * @returns {number}
 */
function assertIntegerInRange(value, min, max, field) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < min || /** @type {number} */ (value) > max) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${field} must be an integer in [${min}, ${max}]`, { field });
  }
  return /** @type {number} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function assertFiniteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${field} must be a finite number`, { field });
  }
  return value;
}

/**
 * Reject unknown keys on a closed object.
 *
 * @param {unknown} raw
 * @param {string[]} allowed
 * @param {string[]} required
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function assertClosedObject(raw, allowed, required, label) {
  if (!isPlainObject(raw)) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label} must be a JSON object`, { field: label });
  }
  const input = /** @type {Record<string, unknown>} */ (raw);
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw structuralError('SKILL_SCHEMA_INVALID', `${label} has an unknown field ${JSON.stringify(key)}`, {
        field: `${label}.${key}`,
      });
    }
  }
  for (const key of required) {
    if (!(key in input)) {
      throw structuralError('SKILL_SCHEMA_INVALID', `${label} is missing required field ${JSON.stringify(key)}`, {
        field: `${label}.${key}`,
      });
    }
  }
  return input;
}

/**
 * Strict JSON parse that reports a skill-package schema fault instead of a raw
 * parser error. Duplicate keys, BOMs and non-finite numbers stay rejected.
 *
 * @param {Uint8Array} bytes
 * @param {{ label: string, maxBytes: number }} options
 * @returns {unknown}
 */
function parseJsonFile(bytes, options) {
  try {
    return parseStrictJsonBytes(bytes, { label: options.label, maxBytes: options.maxBytes });
  } catch (error) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${options.label} is not strict JSON`, { field: options.label });
  }
}

// ─── Identity helpers ────────────────────────────────────────────────────────

/**
 * @param {string} value
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
export function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * @param {{ major: number, minor: number, patch: number }} a
 * @param {{ major: number, minor: number, patch: number }} b
 * @returns {number}
 */
function compareParsed(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Evaluate the only supported range grammar: `>=x.y.z <x.y.z`.
 *
 * @param {unknown} range
 * @param {string} version
 * @returns {boolean}
 */
export function satisfiesBotVersionRange(range, version) {
  if (typeof range !== 'string') return false;
  const match = RANGE_PATTERN.exec(range);
  if (!match) return false;
  const lower = parseSemver(match[1]);
  const upper = parseSemver(match[2]);
  const actual = parseSemver(version);
  if (!lower || !upper || !actual) return false;
  if (compareParsed(lower, upper) >= 0) return false;
  return compareParsed(actual, lower) >= 0 && compareParsed(actual, upper) < 0;
}

/**
 * @param {unknown} path
 * @param {string} label
 * @returns {string}
 */
function assertPayloadPath(path, label) {
  if (typeof path !== 'string' || path === '') {
    throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `${label} must be a relative POSIX path`, { field: label });
  }
  if (path.includes('\\') || path.startsWith('/') || path.includes('//')) {
    throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `${label} path ${JSON.stringify(path)} is not a relative POSIX path`, {
      field: label,
    });
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (!PATH_SEGMENT_PATTERN.test(segment)) {
      throw structuralError(
        'SKILL_EXECUTABLE_FORBIDDEN',
        `${label} path ${JSON.stringify(path)} has a forbidden segment ${JSON.stringify(segment)}`,
        { field: label },
      );
    }
  }
  const extension = path.slice(path.lastIndexOf('.'));
  if (extension !== '.json' && extension !== '.md') {
    throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `${label} path ${JSON.stringify(path)} has a non-data extension`, {
      field: label,
    });
  }
  return path;
}

/**
 * @param {string} path
 * @param {string} label
 */
function assertAllowedPath(path, label) {
  if (REQUIRED_PACKAGE_FILES.includes(path)) return;
  if (/^examples\/[a-z0-9][a-z0-9._-]*\.json$/.test(path)) return;
  if (/^tests\/[a-z0-9][a-z0-9._-]*\.json$/.test(path)) return;
  throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `${label} contains an unlisted payload file ${JSON.stringify(path)}`, {
    field: label,
  });
}

/**
 * Validate the payload layout and return a normalized, byte-copied file list.
 *
 * @param {ReadonlyArray<{ path: string, bytes: Uint8Array }>} files
 * @returns {ReadonlyArray<{ path: string, bytes: Uint8Array, sha256: string, size: number }>}
 */
export function validatePackageLayout(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw structuralError('SKILL_MISSING', 'a skill package must contain payload files', { field: 'package' });
  }
  if (files.length > SKILL_PACKAGE_LIMITS.maxFiles) {
    throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `a skill package may contain at most ${SKILL_PACKAGE_LIMITS.maxFiles} files`, {
      field: 'package',
    });
  }
  /** @type {Map<string, { path: string, bytes: Uint8Array, sha256: string, size: number }>} */
  const byPath = new Map();
  let total = 0;
  for (const entry of files) {
    if (!entry || typeof entry !== 'object') {
      throw structuralError('SKILL_MISSING', 'package entries must be { path, bytes }', { field: 'package' });
    }
    const path = assertPayloadPath(entry.path, 'package');
    assertAllowedPath(path, 'package');
    if (byPath.has(path)) {
      throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `package contains a duplicate path ${JSON.stringify(path)}`, {
        field: 'package',
      });
    }
    if (!(entry.bytes instanceof Uint8Array)) {
      throw structuralError('SKILL_MISSING', `package file ${JSON.stringify(path)} has no bytes`, { field: path });
    }
    const size = entry.bytes.byteLength;
    if (size === 0) {
      throw structuralError('SKILL_MISSING', `package file ${JSON.stringify(path)} is empty`, { field: path });
    }
    if (size > SKILL_PACKAGE_LIMITS.maxFileBytes) {
      throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `package file ${JSON.stringify(path)} exceeds ${SKILL_PACKAGE_LIMITS.maxFileBytes} bytes`, {
        field: path,
      });
    }
    total += size;
    byPath.set(path, { path, bytes: new Uint8Array(entry.bytes), sha256: sha256Hex(entry.bytes), size });
  }
  if (total > SKILL_PACKAGE_LIMITS.maxTotalBytes) {
    throw structuralError('SKILL_EXECUTABLE_FORBIDDEN', `skill package exceeds ${SKILL_PACKAGE_LIMITS.maxTotalBytes} bytes`, {
      field: 'package',
    });
  }
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!byPath.has(required)) {
      throw structuralError('SKILL_MISSING', `skill package is missing required file ${JSON.stringify(required)}`, {
        field: required,
      });
    }
  }
  return Object.freeze([...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/**
 * Build the canonical file index for a validated payload.
 *
 * @param {ReturnType<typeof validatePackageLayout>} files
 * @returns {Readonly<{ format: string, files: ReadonlyArray<{ path: string, size: number, sha256: string }> }>}
 */
export function computeSkillPackageIndex(files) {
  return Object.freeze({
    format: SKILL_PACKAGE_FORMAT,
    files: Object.freeze(
      files.map((file) => Object.freeze({ path: file.path, size: file.size, sha256: file.sha256 })),
    ),
  });
}

/**
 * Content address of a payload: SHA-256 over the JCS index bytes.
 *
 * @param {ReadonlyArray<{ path: string, bytes: Uint8Array }>} files
 * @returns {{ digest: string, index: Readonly<object> }}
 */
export function computeSkillPackageDigest(files) {
  const validated = validatePackageLayout(files);
  const index = computeSkillPackageIndex(validated);
  return Object.freeze({ digest: digestJson(index, { label: 'skill package index' }), index });
}

// ─── Manifest ────────────────────────────────────────────────────────────────

const MANIFEST_FIELDS = Object.freeze([
  'schemaVersion',
  'packageId',
  'version',
  'operation',
  'title',
  'description',
  'instructions',
  'inputSchema',
  'outputSchema',
  'policy',
  'promptLayout',
  'inputContract',
  'outputContract',
  'compatibility',
  'requiredModelCapabilities',
  'dependencies',
  'provenance',
]);

const FILE_FIELDS = Object.freeze({
  instructions: 'instructions.md',
  inputSchema: 'input.schema.json',
  outputSchema: 'output.schema.json',
  policy: 'policy.json',
  promptLayout: 'prompt-layout.json',
});

const CAPABILITY_VALUES = Object.freeze(['json_object']);
const REASONING_VALUES = Object.freeze(['low', 'medium', 'high']);

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<object>}
 */
export function validateManifest(raw, label = 'skill.json') {
  const input = assertClosedObject(raw, MANIFEST_FIELDS, MANIFEST_FIELDS, label);
  if (input.schemaVersion !== 1) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.schemaVersion must be exactly 1`, {
      field: `${label}.schemaVersion`,
    });
  }
  if (typeof input.packageId !== 'string' || !PACKAGE_ID_PATTERN.test(input.packageId)) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.packageId must match ${PACKAGE_ID_PATTERN}`, {
      field: `${label}.packageId`,
    });
  }
  if (!parseSemver(input.version)) {
    throw structuralError('SKILL_INCOMPATIBLE', `${label}.version must be exact SemVer 2.0.0 without build metadata`, {
      field: `${label}.version`,
    });
  }
  const operation = assertEnum(input.operation, AI_OPERATIONS, `${label}.operation`);
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.title must be non-empty`, { field: `${label}.title` });
  }
  if ([...input.title].length > SKILL_PACKAGE_LIMITS.maxTitleChars) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.title exceeds ${SKILL_PACKAGE_LIMITS.maxTitleChars} characters`, {
      field: `${label}.title`,
    });
  }
  if (typeof input.description !== 'string' || input.description.trim() === '') {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.description must be non-empty`, {
      field: `${label}.description`,
    });
  }
  if ([...input.description].length > SKILL_PACKAGE_LIMITS.maxDescriptionChars) {
    throw structuralError(
      'SKILL_SCHEMA_INVALID',
      `${label}.description exceeds ${SKILL_PACKAGE_LIMITS.maxDescriptionChars} characters`,
      { field: `${label}.description` },
    );
  }
  for (const [field, expected] of Object.entries(FILE_FIELDS)) {
    if (input[field] !== expected) {
      throw structuralError('SKILL_SCHEMA_INVALID', `${label}.${field} must be exactly ${JSON.stringify(expected)}`, {
        field: `${label}.${field}`,
      });
    }
  }
  /** @type {(value: unknown, name: string) => Readonly<object>} */
  const contract = (value, name) => {
    const parsed = assertClosedObject(value, ['id', 'version'], ['id', 'version'], `${label}.${name}`);
    if (typeof parsed.id !== 'string' || !CONTRACT_ID_PATTERN.test(parsed.id)) {
      throw structuralError('SKILL_INCOMPATIBLE', `${label}.${name}.id must match ${CONTRACT_ID_PATTERN}`, {
        field: `${label}.${name}.id`,
      });
    }
    if (!parseSemver(parsed.version)) {
      throw structuralError('SKILL_INCOMPATIBLE', `${label}.${name}.version must be exact SemVer`, {
        field: `${label}.${name}.version`,
      });
    }
    return Object.freeze({ id: /** @type {string} */ (parsed.id), version: /** @type {string} */ (parsed.version) });
  };
  const compatibility = assertClosedObject(
    input.compatibility,
    ['botVersionRange', 'skillApiVersion'],
    ['botVersionRange', 'skillApiVersion'],
    `${label}.compatibility`,
  );
  if (typeof compatibility.botVersionRange !== 'string' || !RANGE_PATTERN.test(compatibility.botVersionRange)) {
    throw structuralError(
      'SKILL_INCOMPATIBLE',
      `${label}.compatibility.botVersionRange must use the ">=x.y.z <x.y.z" grammar`,
      { field: `${label}.compatibility.botVersionRange` },
    );
  }
  const rangeMatch = RANGE_PATTERN.exec(compatibility.botVersionRange);
  if (!rangeMatch || compareParsed(parseSemver(rangeMatch[1]) ?? { major: 0, minor: 0, patch: 0 }, parseSemver(rangeMatch[2]) ?? { major: 0, minor: 0, patch: 0 }) >= 0) {
    throw structuralError('SKILL_INCOMPATIBLE', `${label}.compatibility.botVersionRange is empty`, {
      field: `${label}.compatibility.botVersionRange`,
    });
  }
  if (compatibility.skillApiVersion !== SKILL_API_VERSION) {
    throw structuralError('SKILL_INCOMPATIBLE', `${label}.compatibility.skillApiVersion must be ${SKILL_API_VERSION}`, {
      field: `${label}.compatibility.skillApiVersion`,
    });
  }

  const caps = assertClosedObject(
    input.requiredModelCapabilities,
    ['temperature', 'responseFormats', 'reasoningEfforts', 'minOutputTokens', 'maxOutputTokens', 'stream'],
    ['temperature', 'responseFormats', 'reasoningEfforts', 'minOutputTokens', 'maxOutputTokens', 'stream'],
    `${label}.requiredModelCapabilities`,
  );
  const temperature = assertClosedObject(caps.temperature, ['min', 'max'], ['min', 'max'], `${label}.requiredModelCapabilities.temperature`);
  const tempMin = assertFiniteNumber(temperature.min, `${label}.requiredModelCapabilities.temperature.min`);
  const tempMax = assertFiniteNumber(temperature.max, `${label}.requiredModelCapabilities.temperature.max`);
  if (tempMin < 0 || tempMax > 2 || tempMin > tempMax) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.requiredModelCapabilities.temperature must be a finite range within [0, 2]`, {
      field: `${label}.requiredModelCapabilities.temperature`,
    });
  }
  if (!Array.isArray(caps.responseFormats) || caps.responseFormats.length === 0) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.requiredModelCapabilities.responseFormats must be a non-empty array`, {
      field: `${label}.requiredModelCapabilities.responseFormats`,
    });
  }
  for (const format of caps.responseFormats) {
    if (!CAPABILITY_VALUES.includes(/** @type {string} */ (format))) {
      throw structuralError('SKILL_SCHEMA_INVALID', `${label}.requiredModelCapabilities.responseFormats contains an unsupported format`, {
        field: `${label}.requiredModelCapabilities.responseFormats`,
      });
    }
  }
  if (!Array.isArray(caps.reasoningEfforts) || caps.reasoningEfforts.length === 0) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.requiredModelCapabilities.reasoningEfforts must be a non-empty array`, {
      field: `${label}.requiredModelCapabilities.reasoningEfforts`,
    });
  }
  const efforts = caps.reasoningEfforts.map((effort) => {
    if (effort !== null && !REASONING_VALUES.includes(/** @type {string} */ (effort))) {
      throw structuralError('SKILL_SCHEMA_INVALID', `${label}.requiredModelCapabilities.reasoningEfforts contains an unsupported value`, {
        field: `${label}.requiredModelCapabilities.reasoningEfforts`,
      });
    }
    return /** @type {string | null} */ (effort);
  });
  if (new Set(efforts.map((effort) => String(effort))).size !== efforts.length) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.requiredModelCapabilities.reasoningEfforts must be unique`, {
      field: `${label}.requiredModelCapabilities.reasoningEfforts`,
    });
  }
  const minOutputTokens = assertIntegerInRange(caps.minOutputTokens, 1, 1_000_000, `${label}.requiredModelCapabilities.minOutputTokens`);
  const maxOutputTokens = assertIntegerInRange(caps.maxOutputTokens, 1, 1_000_000, `${label}.requiredModelCapabilities.maxOutputTokens`);
  if (minOutputTokens > maxOutputTokens) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.requiredModelCapabilities.minOutputTokens exceeds maxOutputTokens`, {
      field: `${label}.requiredModelCapabilities`,
    });
  }
  if (caps.stream !== false) {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `${label}.requiredModelCapabilities.stream must be false`, {
      field: `${label}.requiredModelCapabilities.stream`,
    });
  }
  if (!Array.isArray(input.dependencies)) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.dependencies must be an array`, {
      field: `${label}.dependencies`,
    });
  }
  if (input.dependencies.length > 0) {
    throw structuralError('SKILL_DEPENDENCY_UNSUPPORTED', `${label}.dependencies must be empty in v2.0`, {
      field: `${label}.dependencies`,
    });
  }
  const provenance = assertClosedObject(
    input.provenance,
    ['authorId', 'createdAt', 'sourceRevision'],
    ['authorId', 'createdAt', 'sourceRevision'],
    `${label}.provenance`,
  );
  assertNonEmptyString(provenance.authorId, `${label}.provenance.authorId`, 120);
  if (typeof provenance.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(provenance.createdAt)) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.provenance.createdAt must be RFC3339 UTC`, {
      field: `${label}.provenance.createdAt`,
    });
  }
  assertNonEmptyString(provenance.sourceRevision, `${label}.provenance.sourceRevision`, 200);

  return Object.freeze({
    schemaVersion: 1,
    packageId: /** @type {string} */ (input.packageId),
    version: /** @type {string} */ (input.version),
    operation,
    title: /** @type {string} */ (input.title),
    description: /** @type {string} */ (input.description),
    instructions: FILE_FIELDS.instructions,
    inputSchema: FILE_FIELDS.inputSchema,
    outputSchema: FILE_FIELDS.outputSchema,
    policy: FILE_FIELDS.policy,
    promptLayout: FILE_FIELDS.promptLayout,
    inputContract: contract(input.inputContract, 'inputContract'),
    outputContract: contract(input.outputContract, 'outputContract'),
    compatibility: Object.freeze({
      botVersionRange: /** @type {string} */ (compatibility.botVersionRange),
      skillApiVersion: SKILL_API_VERSION,
    }),
    requiredModelCapabilities: Object.freeze({
      temperature: Object.freeze({ min: tempMin, max: tempMax }),
      responseFormats: Object.freeze([...caps.responseFormats]),
      reasoningEfforts: Object.freeze(efforts),
      minOutputTokens,
      maxOutputTokens,
      stream: /** @type {false} */ (false),
    }),
    dependencies: Object.freeze([]),
    provenance: Object.freeze({
      authorId: /** @type {string} */ (provenance.authorId),
      createdAt: /** @type {string} */ (provenance.createdAt),
      sourceRevision: /** @type {string} */ (provenance.sourceRevision),
    }),
  });
}

// ─── Policy ──────────────────────────────────────────────────────────────────

const POLICY_FIELDS = Object.freeze([
  'schemaVersion',
  'allowedTools',
  'dataSources',
  'limits',
  'network',
  'filesystem',
  'effects',
]);

const LIMIT_FIELDS = Object.freeze([
  'maxInputBytes',
  'maxOutputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'maxModelCalls',
  'maxToolCalls',
]);

/** Host ceilings no package may exceed (architecture §4.3). */
export const PACKAGE_POLICY_CEILINGS = Object.freeze({
  maxInputBytes: 256 * 1024,
  maxOutputBytes: 64 * 1024,
  maxOutputTokens: 1_000_000,
  timeoutMs: MAX_OPERATION_TIMEOUT_MS,
});

/**
 * @param {unknown} raw
 * @param {string} operation
 * @param {{ manifest?: Readonly<object> | null, label?: string }} [options]
 * @returns {Readonly<object>}
 */
export function validatePolicy(raw, operation, options = {}) {
  const label = options.label ?? 'policy.json';
  if (!AI_OPERATIONS.includes(operation)) {
    throw structuralError('SKILL_INCOMPATIBLE', `policy validation needs a known operation`, { field: 'operation' });
  }
  const input = assertClosedObject(raw, POLICY_FIELDS, POLICY_FIELDS, label);
  if (input.schemaVersion !== 1) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.schemaVersion must be exactly 1`, {
      field: `${label}.schemaVersion`,
    });
  }
  if (!Array.isArray(input.allowedTools)) {
    throw structuralError('SKILL_POLICY_DENIED', `${label}.allowedTools must be an array`, {
      field: `${label}.allowedTools`,
    });
  }
  if (input.allowedTools.length !== 0) {
    throw structuralError('SKILL_POLICY_DENIED', `${label}.allowedTools must be empty in v2.0`, {
      field: `${label}.allowedTools`,
    });
  }
  if (!Array.isArray(input.dataSources)) {
    throw structuralError('SKILL_POLICY_DENIED', `${label}.dataSources must be an array`, {
      field: `${label}.dataSources`,
    });
  }
  const granted = DATA_SOURCE_CATALOGUE[operation];
  const dataSources = input.dataSources.map((source, index) => {
    if (typeof source !== 'string') {
      throw structuralError('SKILL_POLICY_DENIED', `${label}.dataSources[${index}] must be a string`, {
        field: `${label}.dataSources[${index}]`,
      });
    }
    if (!granted.includes(source)) {
      throw structuralError('SKILL_POLICY_DENIED', `${label}.dataSources contains ${JSON.stringify(source)}, which the ${operation} allowlist does not grant`, {
        field: `${label}.dataSources[${index}]`,
      });
    }
    return source;
  });
  if (new Set(dataSources).size !== dataSources.length) {
    throw structuralError('SKILL_POLICY_DENIED', `${label}.dataSources must be unique`, {
      field: `${label}.dataSources`,
    });
  }
  const limits = assertClosedObject(input.limits, LIMIT_FIELDS, LIMIT_FIELDS, `${label}.limits`);
  const validatedLimits = {
    maxInputBytes: assertIntegerInRange(limits.maxInputBytes, 1, PACKAGE_POLICY_CEILINGS.maxInputBytes, `${label}.limits.maxInputBytes`),
    maxOutputBytes: assertIntegerInRange(limits.maxOutputBytes, 1, PACKAGE_POLICY_CEILINGS.maxOutputBytes, `${label}.limits.maxOutputBytes`),
    maxOutputTokens: assertIntegerInRange(limits.maxOutputTokens, 1, PACKAGE_POLICY_CEILINGS.maxOutputTokens, `${label}.limits.maxOutputTokens`),
    timeoutMs: assertIntegerInRange(limits.timeoutMs, 1, PACKAGE_POLICY_CEILINGS.timeoutMs, `${label}.limits.timeoutMs`),
    maxModelCalls: assertIntegerInRange(limits.maxModelCalls, 1, 1, `${label}.limits.maxModelCalls`),
    maxToolCalls: assertIntegerInRange(limits.maxToolCalls, 0, 0, `${label}.limits.maxToolCalls`),
  };
  if (input.network !== 'provider-only') {
    throw structuralError('SKILL_POLICY_DENIED', `${label}.network must be "provider-only"`, { field: `${label}.network` });
  }
  if (input.filesystem !== 'none') {
    throw structuralError('SKILL_POLICY_DENIED', `${label}.filesystem must be "none"`, { field: `${label}.filesystem` });
  }
  if (input.effects !== 'none') {
    throw structuralError('SKILL_POLICY_DENIED', `${label}.effects must be "none"`, { field: `${label}.effects` });
  }
  const manifest = options.manifest ?? null;
  if (manifest !== null) {
    const declared = /** @type {any} */ (manifest).requiredModelCapabilities;
    if (validatedLimits.maxOutputTokens > declared.maxOutputTokens) {
      throw structuralError('SKILL_POLICY_DENIED', `${label}.limits.maxOutputTokens exceeds the declared model capability`, {
        field: `${label}.limits.maxOutputTokens`,
      });
    }
    if (validatedLimits.timeoutMs > 0 && declared.stream !== false) {
      throw structuralError('SKILL_CAPABILITY_MISMATCH', `${label} requires a streaming model capability`, {
        field: `${label}.limits`,
      });
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    allowedTools: Object.freeze([]),
    dataSources: Object.freeze(dataSources),
    limits: Object.freeze(validatedLimits),
    network: 'provider-only',
    filesystem: 'none',
    effects: 'none',
  });
}

// ─── Prompt layout ───────────────────────────────────────────────────────────

const LAYOUT_FIELDS = Object.freeze(['schemaVersion', 'userParts']);
const PART_FIELDS = Object.freeze(['label', 'valuePointer']);

/**
 * @param {unknown} pointer
 * @param {string} field
 * @returns {string}
 */
function assertJsonPointer(pointer, field) {
  if (typeof pointer !== 'string' || !JSON_POINTER_PATTERN.test(pointer)) {
    throw structuralError('SKILL_RENDER_INVALID', `${field} must be an RFC6901 JSON Pointer`, { field });
  }
  return pointer;
}

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Readonly<object>}
 */
export function validatePromptLayout(raw, label = 'prompt-layout.json') {
  const input = assertClosedObject(raw, LAYOUT_FIELDS, LAYOUT_FIELDS, label);
  if (input.schemaVersion !== 1) {
    throw structuralError('SKILL_RENDER_INVALID', `${label}.schemaVersion must be exactly 1`, {
      field: `${label}.schemaVersion`,
    });
  }
  if (!Array.isArray(input.userParts) || input.userParts.length === 0) {
    throw structuralError('SKILL_RENDER_INVALID', `${label}.userParts must be a non-empty array`, {
      field: `${label}.userParts`,
    });
  }
  if (input.userParts.length > SKILL_PACKAGE_LIMITS.maxLayoutParts) {
    throw structuralError('SKILL_RENDER_INVALID', `${label}.userParts may contain at most ${SKILL_PACKAGE_LIMITS.maxLayoutParts} entries`, {
      field: `${label}.userParts`,
    });
  }
  const parts = input.userParts.map((part, index) => {
    const at = `${label}.userParts[${index}]`;
    const entry = assertClosedObject(part, PART_FIELDS, PART_FIELDS, at);
    if (typeof entry.label !== 'string' || entry.label.trim() === '') {
      throw structuralError('SKILL_RENDER_INVALID', `${at}.label must be a non-empty literal string`, { field: `${at}.label` });
    }
    if ([...entry.label].length > SKILL_PACKAGE_LIMITS.maxLabelChars) {
      throw structuralError('SKILL_RENDER_INVALID', `${at}.label exceeds ${SKILL_PACKAGE_LIMITS.maxLabelChars} characters`, {
        field: `${at}.label`,
      });
    }
    if (/[\u0000-\u001f\u007f]/.test(entry.label)) {
      throw structuralError('SKILL_RENDER_INVALID', `${at}.label must not contain control characters`, {
        field: `${at}.label`,
      });
    }
    const pointer = assertJsonPointer(entry.valuePointer, `${at}.valuePointer`);
    return Object.freeze({ label: /** @type {string} */ (entry.label), valuePointer: pointer });
  });
  return Object.freeze({ schemaVersion: 1, userParts: Object.freeze(parts) });
}

// ─── Bounded JSON Schema subset ──────────────────────────────────────────────

const TYPE_VALUES = Object.freeze(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * @param {string} pointer
 * @param {Map<string, any>} defs
 * @returns {string}
 */
function resolveLocalRef(pointer, defs) {
  const match = /^#\/\$defs\/([A-Za-z0-9_.-]{1,64})$/.exec(pointer);
  if (!match) {
    throw structuralError('SKILL_SCHEMA_INVALID', `only local $defs references are allowed (got ${JSON.stringify(pointer)})`, {
      field: 'schema.$ref',
    });
  }
  if (!defs.has(match[1])) {
    throw structuralError('SKILL_SCHEMA_INVALID', `$ref points at missing $defs entry ${JSON.stringify(match[1])}`, {
      field: 'schema.$ref',
    });
  }
  return match[1];
}

/**
 * Validate a package schema against the bounded, reviewed subset and return the
 * normalized schema. Regex `pattern`, remote references, recursion, custom
 * keywords and defaulting constructs are rejected outright — they are either
 * unbounded work or a silent semantic change.
 *
 * @param {unknown} raw
 * @param {{ label?: string, maxBytes?: number }} [options]
 * @returns {Readonly<object>}
 */
export function validateSchemaDocument(raw, options = {}) {
  const label = options.label ?? 'schema';
  if (!isPlainObject(raw)) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label} must be a JSON object`, { field: label });
  }
  const root = /** @type {Record<string, unknown>} */ (raw);
  if (root.$schema !== JSON_SCHEMA_2020_12) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.$schema must be ${JSON_SCHEMA_2020_12}`, {
      field: `${label}.$schema`,
    });
  }
  /** @type {Map<string, any>} */
  const defs = new Map();
  if ('$defs' in root) {
    if (!isPlainObject(root.$defs)) {
      throw structuralError('SKILL_SCHEMA_INVALID', `${label}.$defs must be an object`, { field: `${label}.$defs` });
    }
    for (const [name, value] of Object.entries(/** @type {Record<string, unknown>} */ (root.$defs))) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${label}.$defs name ${JSON.stringify(name)} is not allowed`, {
          field: `${label}.$defs`,
        });
      }
      defs.set(name, value);
    }
  }

  /** @type {Set<string>} */
  const refEdges = new Set();
  /** @type {string[]} */
  const refStack = [];

  /**
   * @param {unknown} node
   * @param {string} at
   * @param {number} depth
   * @param {{ root?: boolean }} [flags]
   * @returns {Readonly<object>}
   */
  function walk(node, at, depth, flags = {}) {
    if (depth > SKILL_PACKAGE_LIMITS.maxJsonDepth) {
      throw structuralError('SKILL_SCHEMA_INVALID', `${at} exceeds the ${SKILL_PACKAGE_LIMITS.maxJsonDepth}-level nesting limit`, {
        field: at,
      });
    }
    if (!isPlainObject(node)) {
      throw structuralError('SKILL_SCHEMA_INVALID', `${at} must be a JSON Schema object`, { field: at });
    }
    const schema = /** @type {Record<string, unknown>} */ (node);
    for (const key of Object.keys(schema)) {
      if (flags.root !== true && key === '$schema') {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at} may only declare $schema at the document root`, { field: `${at}.$schema` });
      }
      if (!ALLOWED_SCHEMA_KEYWORDS.includes(key)) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at} uses unsupported keyword ${JSON.stringify(key)}`, {
          field: `${at}.${key}`,
        });
      }
    }

    /** @type {Record<string, unknown>} */
    const out = {};

    if ('type' in schema) {
      out.type = assertEnum(schema.type, TYPE_VALUES, `${at}.type`);
    }
    if ('$ref' in schema) {
      const target = resolveLocalRef(/** @type {string} */ (schema.$ref), defs);
      if (refStack.includes(target)) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at} creates a recursive $ref cycle through ${target}`, {
          field: `${at}.$ref`,
        });
      }
      refEdges.add(`${refStack.join('>')}>${target}`);
      out.$ref = schema.$ref;
    }
    if ('const' in schema) {
      const value = schema.const;
      if (!(value === null || ['string', 'number', 'boolean'].includes(typeof value))) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at}.const must be a primitive`, { field: `${at}.const` });
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at}.const must be finite`, { field: `${at}.const` });
      }
      out.const = value;
    }
    if ('enum' in schema) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 256) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at}.enum must be a non-empty array of at most 256 primitives`, {
          field: `${at}.enum`,
        });
      }
      const seen = new Set();
      for (const value of schema.enum) {
        if (!(value === null || ['string', 'number', 'boolean'].includes(typeof value))) {
          throw structuralError('SKILL_SCHEMA_INVALID', `${at}.enum values must be primitives`, { field: `${at}.enum` });
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw structuralError('SKILL_SCHEMA_INVALID', `${at}.enum values must be finite`, { field: `${at}.enum` });
        }
        const key = `${typeof value}:${String(value)}`;
        if (seen.has(key)) {
          throw structuralError('SKILL_SCHEMA_INVALID', `${at}.enum values must be unique`, { field: `${at}.enum` });
        }
        seen.add(key);
      }
      out.enum = Object.freeze([...schema.enum]);
    }
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
      if (key in schema) out[key] = assertFiniteNumber(schema[key], `${at}.${key}`);
    }
    for (const key of ['minLength', 'maxLength']) {
      if (key in schema) out[key] = assertIntegerInRange(schema[key], 0, 65536, `${at}.${key}`);
    }
    for (const key of ['minItems', 'maxItems']) {
      if (key in schema) out[key] = assertIntegerInRange(schema[key], 0, 256, `${at}.${key}`);
    }
    if ('properties' in schema) {
      if (!isPlainObject(schema.properties)) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at}.properties must be an object`, { field: `${at}.properties` });
      }
      const entries = Object.entries(/** @type {Record<string, unknown>} */ (schema.properties));
      if (entries.length > SKILL_PACKAGE_LIMITS.maxPropertiesPerObject) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at}.properties exceeds ${SKILL_PACKAGE_LIMITS.maxPropertiesPerObject} entries`, {
          field: `${at}.properties`,
        });
      }
      /** @type {Record<string, unknown>} */
      const properties = {};
      for (const [name, value] of entries) {
        if (!PROPERTY_NAME_PATTERN.test(name)) {
          throw structuralError('SKILL_SCHEMA_INVALID', `${at}.properties has an invalid name ${JSON.stringify(name)}`, {
            field: `${at}.properties`,
          });
        }
        properties[name] = walk(value, `${at}.properties.${name}`, depth + 1);
      }
      out.properties = Object.freeze(properties);
    }
    if ('required' in schema) {
      if (!Array.isArray(schema.required) || schema.required.length === 0) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at}.required must be a non-empty array`, { field: `${at}.required` });
      }
      const seen = new Set();
      for (const name of schema.required) {
        if (typeof name !== 'string' || !isPlainObject(schema.properties) || !(name in /** @type {any} */ (schema.properties))) {
          throw structuralError('SKILL_SCHEMA_INVALID', `${at}.required lists an unknown property`, { field: `${at}.required` });
        }
        if (seen.has(name)) {
          throw structuralError('SKILL_SCHEMA_INVALID', `${at}.required lists a duplicate property`, { field: `${at}.required` });
        }
        seen.add(name);
      }
      out.required = Object.freeze([...schema.required]);
    }
    if ('additionalProperties' in schema) {
      if (schema.additionalProperties !== false) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at}.additionalProperties must be false (schemas are closed)`, {
          field: `${at}.additionalProperties`,
        });
      }
      out.additionalProperties = false;
    }
    if (schema.type === 'object' && schema.additionalProperties !== false) {
      throw structuralError('SKILL_SCHEMA_INVALID', `${at} is an object branch without additionalProperties:false`, {
        field: `${at}.additionalProperties`,
      });
    }
    if ('items' in schema) {
      if (Array.isArray(schema.items)) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at}.items must be a single schema`, { field: `${at}.items` });
      }
      out.items = walk(schema.items, `${at}.items`, depth + 1);
    }
    if (schema.type === 'array' && !('items' in schema)) {
      throw structuralError('SKILL_SCHEMA_INVALID', `${at} is an array branch without items`, { field: `${at}.items` });
    }
    if ('anyOf' in schema) {
      if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0 || schema.anyOf.length > 8) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at}.anyOf must contain 1..8 schemas`, { field: `${at}.anyOf` });
      }
      out.anyOf = Object.freeze(schema.anyOf.map((entry, index) => walk(entry, `${at}.anyOf[${index}]`, depth + 1)));
    }
    return Object.freeze(out);
  }

  const normalized = walk(root, label, 0, { root: true });

  // `$defs` bodies still have to satisfy the subset, and each referenced name
  // must be reachable without a cycle.
  /** @type {Record<string, unknown>} */
  const normalizedDefs = {};
  for (const [name, value] of defs) {
    refStack.push(name);
    normalizedDefs[name] = walk(value, `${label}.$defs.${name}`, 1);
    refStack.pop();
  }
  return Object.freeze({
    ...normalized,
    $schema: JSON_SCHEMA_2020_12,
    ...(defs.size > 0 ? { $defs: Object.freeze(normalizedDefs) } : {}),
  });
}

// ─── Examples and declarative acceptance cases ───────────────────────────────

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {Readonly<{ input: unknown, expectedOutput: unknown }>}
 */
export function validateExample(raw, label) {
  const input = assertClosedObject(raw, ['input', 'expectedOutput'], ['input', 'expectedOutput'], label);
  return Object.freeze({ input: input.input, expectedOutput: input.expectedOutput });
}

/**
 * Declarative acceptance cases. The DSL is closed and non-executable: one
 * RFC6901 pointer/value replacement or one mocked response per case.
 *
 * @param {unknown} raw
 * @param {{ examples: readonly string[], label?: string }} options
 * @returns {ReadonlyArray<Readonly<object>>}
 */
export function validateAcceptanceTests(raw, options) {
  const label = options.label ?? 'tests';
  const input = assertClosedObject(raw, ['schemaVersion', 'cases'], ['schemaVersion', 'cases'], label);
  if (input.schemaVersion !== 1) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.schemaVersion must be exactly 1`, {
      field: `${label}.schemaVersion`,
    });
  }
  if (!Array.isArray(input.cases) || input.cases.length === 0 || input.cases.length > 64) {
    throw structuralError('SKILL_SCHEMA_INVALID', `${label}.cases must contain 1..64 cases`, { field: `${label}.cases` });
  }
  const ids = new Set();
  return Object.freeze(
    input.cases.map((rawCase, index) => {
      const at = `${label}.cases[${index}]`;
      const allowed = ['id', 'fixture', 'stage', 'expected', 'response', 'replace'];
      const entry = assertClosedObject(rawCase, allowed, ['id', 'fixture', 'stage', 'expected'], at);
      if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id)) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at}.id must be a lowercase slug`, { field: `${at}.id` });
      }
      if (ids.has(entry.id)) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${label} contains duplicate case id ${JSON.stringify(entry.id)}`, {
          field: `${at}.id`,
        });
      }
      ids.add(entry.id);
      if (typeof entry.fixture !== 'string' || !options.examples.includes(entry.fixture)) {
        throw structuralError('SKILL_SCHEMA_INVALID', `${at}.fixture must reference a verified local example`, {
          field: `${at}.fixture`,
        });
      }
      const stage = assertEnum(entry.stage, ['input', 'output'], `${at}.stage`);
      const expected = assertEnum(entry.expected, ACCEPTANCE_EXPECTATIONS, `${at}.expected`);
      /** @type {Record<string, unknown>} */
      const out = {
        id: entry.id,
        fixture: entry.fixture,
        stage,
        expected,
      };
      if (stage === 'output') {
        if (!('response' in entry) || 'replace' in entry) {
          throw structuralError('SKILL_SCHEMA_INVALID', `${at} stage=output requires response and forbids replace`, {
            field: at,
          });
        }
        out.response = entry.response;
      } else {
        if (!('replace' in entry) || 'response' in entry) {
          throw structuralError('SKILL_SCHEMA_INVALID', `${at} stage=input requires replace and forbids response`, {
            field: at,
          });
        }
        const replace = assertClosedObject(entry.replace, ['pointer', 'value'], ['pointer', 'value'], `${at}.replace`);
        if (typeof replace.pointer !== 'string' || replace.pointer === '') {
          throw structuralError('SKILL_SCHEMA_INVALID', `${at}.replace.pointer must be a non-empty RFC6901 pointer`, {
            field: `${at}.replace.pointer`,
          });
        }
        out.replace = Object.freeze({
          pointer: assertJsonPointer(replace.pointer, `${at}.replace.pointer`),
          value: replace.value,
        });
      }
      return Object.freeze(out);
    }),
  );
}

// ─── Package assembly ────────────────────────────────────────────────────────

/**
 * @typedef {object} VerifiedPackage
 * @property {1} schemaVersion
 * @property {string} packageId
 * @property {string} version
 * @property {string} operation
 * @property {string} digest
 * @property {Readonly<object>} index
 * @property {Readonly<object>} manifest
 * @property {Readonly<object>} policy
 * @property {Readonly<object>} layout
 * @property {Readonly<object>} inputSchema
 * @property {Readonly<object>} outputSchema
 * @property {string} instructions
 * @property {ReadonlyArray<Readonly<object>>} examples
 * @property {ReadonlyArray<Readonly<object>>} acceptanceCases
 * @property {ReadonlyArray<{path: string, sha256: string, size: number}>} files
 * @property {(path: string) => Uint8Array | null} readFile
 */

/**
 * Validate one payload completely and return an immutable verified package.
 * Execution never reopens files afterwards: the returned snapshot owns bytes.
 *
 * @param {ReadonlyArray<{ path: string, bytes: Uint8Array }>} files
 * @param {{ artifact?: { botVersion: string, skillApiVersion: number }, expectedOperation?: string | null }} [options]
 * @returns {VerifiedPackage}
 */
export function parseSkillPackage(files, options = {}) {
  const layout = validatePackageLayout(files);
  const index = computeSkillPackageIndex(layout);
  const digest = digestJson(index, { label: 'skill package index' });
  /** @type {Map<string, { path: string, bytes: Uint8Array }>} */
  const byPath = new Map(layout.map((file) => [file.path, file]));

  /** @param {string} path */
  const bytesOf = (path) => {
    const entry = byPath.get(path);
    if (!entry) throw structuralError('SKILL_MISSING', `verified package lost file ${JSON.stringify(path)}`, { field: path });
    return entry.bytes;
  };

  const manifest = validateManifest(parseJsonFile(bytesOf('skill.json'), { label: 'skill.json', maxBytes: SKILL_PACKAGE_LIMITS.maxFileBytes }));

  const operation = manifest.operation;
  if (options.expectedOperation && options.expectedOperation !== operation) {
    throw structuralError('SKILL_INCOMPATIBLE', `package declares operation ${operation}, expected ${options.expectedOperation}`, {
      field: 'skill.json.operation',
    });
  }

  // Markdown: literal UTF-8, no BOM, no CR, bounded.
  const instructionsBytes = bytesOf('instructions.md');
  if (instructionsBytes.byteLength > SKILL_PACKAGE_LIMITS.maxInstructionsBytes) {
    throw structuralError('SKILL_SCHEMA_INVALID', `instructions.md exceeds ${SKILL_PACKAGE_LIMITS.maxInstructionsBytes} bytes`, {
      field: 'instructions.md',
    });
  }
  if (instructionsBytes[0] === 0xef && instructionsBytes[1] === 0xbb && instructionsBytes[2] === 0xbf) {
    throw structuralError('SKILL_SCHEMA_INVALID', 'instructions.md must not carry a BOM', { field: 'instructions.md' });
  }
  let instructions;
  try {
    instructions = new TextDecoder('utf-8', { fatal: true }).decode(instructionsBytes);
  } catch {
    throw structuralError('SKILL_SCHEMA_INVALID', 'instructions.md is not valid UTF-8', { field: 'instructions.md' });
  }
  if (instructions.includes('\r')) {
    throw structuralError('SKILL_SCHEMA_INVALID', 'instructions.md must use LF line endings', { field: 'instructions.md' });
  }
  if (instructions.trim() === '') {
    throw structuralError('SKILL_SCHEMA_INVALID', 'instructions.md must not be blank', { field: 'instructions.md' });
  }
  if (AUTHORIZATION_HEADER_PATTERN.test(instructions)) {
    throw structuralError('SKILL_POLICY_DENIED', 'instructions.md must not reference credentials', { field: 'instructions.md' });
  }

  const inputSchema = validateSchemaDocument(
    parseJsonFile(bytesOf('input.schema.json'), { label: 'input.schema.json', maxBytes: SKILL_PACKAGE_LIMITS.maxSchemaBytes }),
    { label: 'input.schema.json' },
  );
  const outputSchema = validateSchemaDocument(
    parseJsonFile(bytesOf('output.schema.json'), { label: 'output.schema.json', maxBytes: SKILL_PACKAGE_LIMITS.maxSchemaBytes }),
    { label: 'output.schema.json' },
  );
  const policy = validatePolicy(
    parseJsonFile(bytesOf('policy.json'), { label: 'policy.json', maxBytes: SKILL_PACKAGE_LIMITS.maxFileBytes }),
    operation,
    { manifest },
  );
  const promptLayout = validatePromptLayout(
    parseJsonFile(bytesOf('prompt-layout.json'), { label: 'prompt-layout.json', maxBytes: SKILL_PACKAGE_LIMITS.maxFileBytes }),
  );

  const examplePaths = layout.map((file) => file.path).filter((path) => path.startsWith('examples/'));
  const examples = Object.freeze(
    examplePaths.map((path) =>
      Object.freeze({
        path,
        value: validateExample(
          parseJsonFile(bytesOf(path), { label: path, maxBytes: SKILL_PACKAGE_LIMITS.maxFileBytes }),
          path,
        ),
      }),
    ),
  );
  const testPaths = layout.map((file) => file.path).filter((path) => path.startsWith('tests/'));
  const acceptanceCases = Object.freeze(
    testPaths.flatMap((path) =>
      validateAcceptanceTests(
        parseJsonFile(bytesOf(path), { label: path, maxBytes: SKILL_PACKAGE_LIMITS.maxFileBytes }),
        { examples: examplePaths, label: path },
      ),
    ),
  );

  const artifact = options.artifact ?? null;
  if (artifact !== null) {
    if (artifact.skillApiVersion !== SKILL_API_VERSION) {
      throw structuralError('SKILL_INCOMPATIBLE', `artifact declares skillApiVersion ${artifact.skillApiVersion}, package requires ${SKILL_API_VERSION}`, {
        field: 'artifact.skillApiVersion',
      });
    }
    if (!satisfiesBotVersionRange(manifest.compatibility.botVersionRange, artifact.botVersion)) {
      throw structuralError(
        'SKILL_INCOMPATIBLE',
        `package range ${manifest.compatibility.botVersionRange} does not admit artifact version ${artifact.botVersion}`,
        { field: 'skill.json.compatibility.botVersionRange' },
      );
    }
  }

  // A render pointer must be resolvable in the schema-shaped input: verify that
  // every pointer names an existing property path in the *input schema*, so an
  // authoring fault is caught at validation rather than at the first call.
  for (const part of /** @type {any} */ (promptLayout).userParts) {
    if (!schemaAdmitsPointer(inputSchema, part.valuePointer)) {
      throw structuralError('SKILL_RENDER_INVALID', `prompt-layout pointer ${JSON.stringify(part.valuePointer)} is not present in input.schema.json`, {
        field: 'prompt-layout.json',
      });
    }
  }

  const resolvedBytes = new Map(layout.map((file) => [file.path, file.bytes]));
  return Object.freeze({
    schemaVersion: 1,
    packageId: manifest.packageId,
    version: manifest.version,
    operation,
    digest,
    index,
    manifest,
    policy,
    layout: promptLayout,
    inputSchema,
    outputSchema,
    instructions,
    examples,
    acceptanceCases,
    files: Object.freeze(layout.map((file) => Object.freeze({ path: file.path, sha256: file.sha256, size: file.size }))),
    readFile: (path) => resolvedBytes.get(path) ?? null,
  });
}

/**
 * Structural check that a JSON pointer names a property path that exists in the
 * input schema (through `properties`; `anyOf` branches must all agree).
 *
 * @param {any} schema
 * @param {string} pointer
 * @returns {boolean}
 */
export function schemaAdmitsPointer(schema, pointer) {
  if (pointer === '') return true;
  const segments = pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  /** @param {any} node @param {number} index @returns {boolean} */
  const descend = (node, index) => {
    if (index === segments.length) return true;
    if (node === null || typeof node !== 'object') return false;
    if (node.$ref) return true; // local $defs target: admit rather than follow
    if (Array.isArray(node.anyOf)) {
      // A nullable/union branch: admit if any branch can carry the pointer.
      return node.anyOf.some((branch) => descend(branch, index));
    }
    const properties = node.properties;
    if (!properties || typeof properties !== 'object') return false;
    const child = properties[segments[index]];
    if (!child) return false;
    return descend(child, index + 1);
  };
  return descend(schema, 0);
}

/**
 * Validate a package-shaped object graph without bytes (used by admin tooling
 * and tests that already hold parsed JSON). Returns the verified package.
 *
 * @param {Record<string, unknown>} documents keyed by payload path
 * @param {Parameters<typeof parseSkillPackage>[1]} [options]
 * @returns {VerifiedPackage}
 */
export function parseSkillPackageDocuments(documents, options = {}) {
  if (!isPlainObject(documents)) {
    throw structuralError('SKILL_MISSING', 'package documents must be an object keyed by path', { field: 'package' });
  }
  const files = Object.entries(/** @type {Record<string, unknown>} */ (documents)).map(([path, value]) => {
    if (typeof value === 'string') {
      return { path, bytes: Buffer.from(value, 'utf8') };
    }
    return { path, bytes: Buffer.from(canonicalizeJson(value, { label: path }), 'utf8') };
  });
  return parseSkillPackage(files, options);
}
