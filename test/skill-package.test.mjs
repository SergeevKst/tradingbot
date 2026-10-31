/**
 * SKILL-02 — portable data-only Skill Package format and strict validation
 * (architecture v1.1 §4, acceptance criteria AC-02 and AC-05 input side).
 *
 * Every package used here is a real repository package read from `skills/`, so a
 * format change that breaks the baseline payloads fails here first.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  SKILL_PACKAGE_LIMITS,
  SKILL_API_VERSION,
  parseSkillPackage,
  validatePackageLayout,
  computeSkillPackageDigest,
  validateManifest,
  validatePolicy,
  validatePromptLayout,
  validateSchemaDocument,
  validateAcceptanceTests,
  schemaAdmitsPointer,
} from '../src/config/skill-package.mjs';
import { AI_OPERATIONS } from '../src/ai/operation-profiles.mjs';
import {
  PACKAGE_IDS,
  patchPackageFiles,
  readBaselinePackages,
} from './fixtures/skills/factory.mjs';

const ARTIFACT = Object.freeze({ botVersion: '0.1.0', skillApiVersion: SKILL_API_VERSION });

/** @param {string} code */
function assertCode(code) {
  return (error) => error?.code === code;
}

/**
 * @param {ReadonlyArray<any>} files
 * @param {{ artifact?: any, expectedOperation?: string }} [options]
 */
function parse(files, options = {}) {
  return parseSkillPackage(files, { artifact: ARTIFACT, ...options });
}

describe('Skill package parsing (AC-02)', () => {
  test('all six baseline packages parse, one operation each', () => {
    const baseline = readBaselinePackages();
    for (const operation of AI_OPERATIONS) {
      const parsed = parse(baseline[operation], { expectedOperation: operation });
      assert.equal(parsed.operation, operation);
      assert.equal(parsed.packageId, PACKAGE_IDS[operation]);
      assert.equal(parsed.version, '1.0.0');
      assert.match(parsed.digest, /^[0-9a-f]{64}$/);
      assert.ok(parsed.instructions.length > 0);
      assert.ok(parsed.examples.length > 0, `${operation} ships at least one example`);
      assert.ok(parsed.acceptanceCases.length > 0, `${operation} ships declarative acceptance cases`);
      assert.equal(parsed.manifest.operation, operation);
      assert.deepEqual(parsed.manifest.dependencies, []);
      assert.equal(parsed.policy.allowedTools.length, 0);
      assert.equal(parsed.policy.limits.maxModelCalls, 1);
      assert.equal(parsed.policy.limits.maxToolCalls, 0);
    }
  });

  test('the digest is a pure function of the bytes, independent of file order', () => {
    const files = readBaselinePackages().REFLECT;
    const a = computeSkillPackageDigest(files);
    const b = computeSkillPackageDigest([...files].reverse());
    assert.equal(a.digest, b.digest);
    assert.deepEqual(
      a.index.files.map((entry) => entry.path),
      [...a.index.files.map((entry) => entry.path)].sort(),
      'index entries are sorted by ASCII path',
    );
  });

  test('changing one byte changes the digest', () => {
    const files = readBaselinePackages().REFLECT;
    const before = parse(files);
    const mutated = patchPackageFiles(files, {
      raw: { 'instructions.md': `${before.instructions}\nOne extra sentence.\n` },
    });
    const after = parse(mutated);
    assert.notEqual(after.digest, before.digest);
    assert.equal(after.version, before.version, 'identity is the digest, not the version label');
  });

  test('a test-only change also changes the digest', () => {
    const files = readBaselinePackages().REFLECT;
    const before = parse(files);
    const mutated = patchPackageFiles(files, {
      patchJson: {
        'tests/acceptance.json': (document) => ({
          ...document,
          cases: document.cases.slice(0, -1),
        }),
      },
    });
    assert.notEqual(parse(mutated).digest, before.digest);
  });

  test('the package digest is not stored inside skill.json (no self-reference)', () => {
    for (const files of Object.values(readBaselinePackages())) {
      const manifest = JSON.parse(files.find((file) => file.path === 'skill.json').bytes.toString('utf8'));
      assert.equal('packageDigestSha256' in manifest, false);
      assert.equal('digest' in manifest, false);
    }
  });
});

describe('Payload layout and path rules (AC-02)', () => {
  const files = () => readBaselinePackages().REFLECT;

  test('traversal, absolute, hidden and non-ASCII paths are refused', () => {
    for (const bad of ['../escape.json', '/absolute.json', 'examples/.hidden.json', 'examples/Ünïcode.json', 'examples\\win.json', 'examples/Extra.JSON']) {
      assert.throws(
        () => validatePackageLayout([...files(), { path: bad, bytes: Buffer.from('{"a":1}') }]),
        (error) => ['SKILL_EXECUTABLE_FORBIDDEN', 'SKILL_MISSING', 'SKILL_SCHEMA_INVALID'].includes(error.code),
        `${bad} must be refused`,
      );
    }
  });

  test('an executable payload is refused even with an innocuous name', () => {
    assert.throws(
      () => validatePackageLayout([...files(), { path: 'examples/helper.mjs', bytes: Buffer.from('export {}') }]),
      assertCode('SKILL_EXECUTABLE_FORBIDDEN'),
    );
  });

  test('duplicate paths are refused', () => {
    const payload = files();
    assert.throws(
      () => validatePackageLayout([...payload, payload[0]]),
      assertCode('SKILL_EXECUTABLE_FORBIDDEN'),
    );
  });

  test('empty files and oversized files are refused', () => {
    assert.throws(() => validatePackageLayout([...files(), { path: 'examples/empty.json', bytes: Buffer.alloc(0) }]), assertCode('SKILL_MISSING'));
    const huge = Buffer.alloc(SKILL_PACKAGE_LIMITS.maxFileBytes + 1, 0x20);
    assert.throws(() => validatePackageLayout([...files(), { path: 'examples/huge.json', bytes: huge }]), assertCode('SKILL_EXECUTABLE_FORBIDDEN'));
  });

  test('missing required files are refused', () => {
    const trimmed = files().filter((file) => file.path !== 'policy.json');
    assert.throws(() => parse(trimmed), assertCode('SKILL_MISSING'));
  });

  test('duplicate JSON keys and a BOM are refused', () => {
    const duplicated = patchPackageFiles(files(), {
      raw: { 'policy.json': '{"schemaVersion":1,"schemaVersion":2}' },
    });
    assert.throws(() => parse(duplicated), (error) => typeof error.code === 'string');
    const bom = patchPackageFiles(files(), {
      raw: { 'instructions.md': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('text\n')]) },
    });
    assert.throws(() => parse(bom), assertCode('SKILL_SCHEMA_INVALID'));
  });

  test('CRLF instructions are refused', () => {
    const crlf = patchPackageFiles(files(), { raw: { 'instructions.md': 'line one\r\nline two\n' } });
    assert.throws(() => parse(crlf), assertCode('SKILL_SCHEMA_INVALID'));
  });
});

describe('Manifest compatibility and identity (AC-02, AC-05)', () => {
  const manifestOf = () => JSON.parse(readBaselinePackages().REFLECT.find((file) => file.path === 'skill.json').bytes.toString('utf8'));

  test('a package id that is not a stable lowercase identifier is refused', () => {
    for (const packageId of ['Reflect', 'reflect v1', '1reflect', 'reflect/1']) {
      assert.throws(() => validateManifest({ ...manifestOf(), packageId }), assertCode('SKILL_SCHEMA_INVALID'));
    }
  });

  test('prerelease and build-metadata versions are refused', () => {
    for (const version of ['1.0.0-rc.1', '1.0.0+build', '01.0.0']) {
      assert.throws(
        () => validateManifest({ ...manifestOf(), version }),
        (error) => ['SKILL_SCHEMA_INVALID', 'SKILL_INCOMPATIBLE'].includes(error.code),
      );
    }
  });

  test('an unknown operation is refused', () => {
    assert.throws(() => validateManifest({ ...manifestOf(), operation: 'EXECUTE' }), assertCode('SKILL_SCHEMA_INVALID'));
  });

  test('unknown manifest fields are refused', () => {
    assert.throws(() => validateManifest({ ...manifestOf(), entrypoint: './index.mjs' }), assertCode('SKILL_SCHEMA_INVALID'));
  });

  test('nonempty dependencies are refused as unsupported', () => {
    assert.throws(
      () => validateManifest({ ...manifestOf(), dependencies: ['trading.analyze'] }),
      assertCode('SKILL_DEPENDENCY_UNSUPPORTED'),
    );
  });

  test('the artifact bot range and skill API version gate loading', () => {
    const files = readBaselinePackages().REFLECT;
    assert.throws(
      () => parseSkillPackage(files, { artifact: { botVersion: '0.1.0', skillApiVersion: 2 } }),
      assertCode('SKILL_INCOMPATIBLE'),
    );
    assert.throws(
      () => parseSkillPackage(files, { artifact: { botVersion: '9.9.9', skillApiVersion: 1 } }),
      assertCode('SKILL_INCOMPATIBLE'),
    );
  });

  test('a package cannot declare another operation than the caller expects', () => {
    assert.throws(
      () => parse(readBaselinePackages().REFLECT, { expectedOperation: 'GUARD' }),
      assertCode('SKILL_INCOMPATIBLE'),
    );
  });
});

describe('Policy, layout and schema subset (AC-05)', () => {
  test('allowedTools must be empty and maxModelCalls exactly 1', () => {
    const base = { schemaVersion: 1, allowedTools: [], dataSources: ['trade.closed.v1', 'rules.pending.v1'], limits: { maxInputBytes: 1024, maxOutputBytes: 1024, maxOutputTokens: 256, timeoutMs: 1000, maxModelCalls: 1, maxToolCalls: 0 }, network: 'provider-only', filesystem: 'none', effects: 'none' };
    assert.throws(() => validatePolicy({ ...base, allowedTools: ['exchange.order'] }, 'REFLECT'), (error) => error.code === 'SKILL_POLICY_DENIED' || error.code === 'SKILL_SCHEMA_INVALID');
    assert.throws(() => validatePolicy({ ...base, limits: { ...base.limits, maxModelCalls: 2 } }, 'REFLECT'), assertCode('SKILL_SCHEMA_INVALID'));
    assert.throws(() => validatePolicy({ ...base, limits: { ...base.limits, maxToolCalls: 1 } }, 'REFLECT'), assertCode('SKILL_SCHEMA_INVALID'));
  });

  test('a package may not request a capability outside its operation allowlist', () => {
    const base = { schemaVersion: 1, allowedTools: [], dataSources: ['market.guard.v1'], limits: { maxInputBytes: 1024, maxOutputBytes: 1024, maxOutputTokens: 256, timeoutMs: 1000, maxModelCalls: 1, maxToolCalls: 0 }, network: 'provider-only', filesystem: 'none', effects: 'none' };
    assert.throws(() => validatePolicy({ ...base, dataSources: ['trade.closed.v1'] }, 'GUARD'), assertCode('SKILL_POLICY_DENIED'));
    assert.throws(() => validatePolicy({ ...base, dataSources: ['unknown.capability.v1'] }, 'GUARD'), assertCode('SKILL_POLICY_DENIED'));
    assert.throws(() => validatePolicy({ ...base, network: 'any' }, 'GUARD'), (error) => ['SKILL_SCHEMA_INVALID', 'SKILL_POLICY_DENIED'].includes(error.code));
    assert.throws(() => validatePolicy({ ...base, effects: 'exchange' }, 'GUARD'), (error) => ['SKILL_SCHEMA_INVALID', 'SKILL_POLICY_DENIED'].includes(error.code));
  });

  test('a package cannot raise the host ceilings', () => {
    const files = readBaselinePackages().REFLECT;
    const raised = patchPackageFiles(files, {
      patchJson: {
        'policy.json': (policy) => ({
          ...policy,
          limits: { ...policy.limits, maxInputBytes: 10 * 1024 * 1024, timeoutMs: 24 * 60 * 60 * 1000 },
        }),
      },
    });
    assert.throws(() => parse(raised), assertCode('SKILL_SCHEMA_INVALID'));
  });

  test('layout parts are literal: no interpolation, conditionals or includes', () => {
    for (const bad of [
      { schemaVersion: 1, userParts: [{ label: 'DATA', valuePointer: 'trade/side' }] },
      { schemaVersion: 1, userParts: [{ label: 'DATA', valuePointer: '', template: '${x}' }] },
      { schemaVersion: 1, userParts: [{ label: 'D'.repeat(81), valuePointer: '' }] },
      { schemaVersion: 1, userParts: [{ label: 'BAD\u0000LABEL', valuePointer: '' }] },
      { schemaVersion: 1, userParts: [] },
      { schemaVersion: 1, userParts: Array.from({ length: 9 }, () => ({ label: 'X', valuePointer: '' })) },
    ]) {
      assert.throws(() => validatePromptLayout(bad), (error) => error.code === 'SKILL_SCHEMA_INVALID' || error.code === 'SKILL_RENDER_INVALID');
    }
    // A pointer that is syntactically valid but names no schema property is
    // caught when the package is parsed, not when the layout alone is validated.
    assert.throws(
      () => parse(patchPackageFiles(readBaselinePackages().REFLECT, {
        patchJson: { 'prompt-layout.json': () => ({ schemaVersion: 1, userParts: [{ label: 'DATA', valuePointer: '/trade/{{side}}' }] }) },
      })),
      assertCode('SKILL_RENDER_INVALID'),
    );
  });

  test('a layout pointer that names no schema property is a render fault', () => {
    const files = readBaselinePackages().REFLECT;
    const broken = patchPackageFiles(files, {
      patchJson: { 'prompt-layout.json': () => ({ schemaVersion: 1, userParts: [{ label: 'DATA', valuePointer: '/trade/leverage' }] }) },
    });
    assert.throws(() => parse(broken), assertCode('SKILL_RENDER_INVALID'));
  });

  test('schema pointers resolve through properties and anyOf branches', () => {
    const schema = { type: 'object', additionalProperties: false, properties: { trade: { type: 'object', additionalProperties: false, properties: { symbol: { type: 'string' } } }, maybe: { anyOf: [{ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { type: 'null' }] } } };
    assert.equal(schemaAdmitsPointer(schema, ''), true);
    assert.equal(schemaAdmitsPointer(schema, '/trade/symbol'), true);
    assert.equal(schemaAdmitsPointer(schema, '/maybe/a'), true);
    assert.equal(schemaAdmitsPointer(schema, '/trade/leverage'), false);
  });

  test('the schema subset rejects pattern, recursion, remote $ref and open objects', () => {
    const base = { $schema: 'https://json-schema.org/draft/2020-12/schema' };
    assert.throws(() => validateSchemaDocument({ ...base, type: 'object', additionalProperties: false, properties: { a: { type: 'string', pattern: '^x' } } }), assertCode('SKILL_SCHEMA_INVALID'));
    assert.throws(() => validateSchemaDocument({ ...base, type: 'object', additionalProperties: false, properties: { a: { $ref: 'https://example.com/schema.json' } } }), assertCode('SKILL_SCHEMA_INVALID'));
    assert.throws(() => validateSchemaDocument({ ...base, type: 'object', properties: { a: { type: 'string' } } }), assertCode('SKILL_SCHEMA_INVALID'));
    assert.throws(() => validateSchemaDocument({ ...base, type: 'object', additionalProperties: false, $defs: { node: { type: 'object', additionalProperties: false, properties: { child: { $ref: '#/$defs/node' } } } }, properties: { root: { $ref: '#/$defs/node' } } }), assertCode('SKILL_SCHEMA_INVALID'));
    assert.throws(() => validateSchemaDocument({ ...base, type: 'object', additionalProperties: false, properties: { a: { type: 'string', format: 'date-time' } } }), assertCode('SKILL_SCHEMA_INVALID'));
  });

  test('the acceptance DSL is closed', () => {
    const cases = { schemaVersion: 1, cases: [{ id: 'ok', fixture: 'examples/ordinary-stop.json', stage: 'output', response: { lesson: 'x', proposedRule: '', severity: 'low', matchedExistingRule: false }, expected: 'VALID' }] };
    assert.equal(validateAcceptanceTests(cases, { examples: ['examples/ordinary-stop.json'] }).length, 1);
    assert.throws(
      () => validateAcceptanceTests({ schemaVersion: 1, cases: [{ ...cases.cases[0], script: 'process.exit(0)' }] }, { examples: ['examples/ordinary-stop.json'] }),
      (error) => typeof error.code === 'string',
    );
    assert.throws(
      () => validateAcceptanceTests({ schemaVersion: 1, cases: [{ ...cases.cases[0], fixture: 'examples/other.json' }] }, { examples: ['examples/ordinary-stop.json'] }),
      (error) => typeof error.code === 'string',
    );
    assert.throws(
      () => validateAcceptanceTests({ schemaVersion: 1, cases: [{ ...cases.cases[0], stage: 'input' }] }, { examples: ['examples/ordinary-stop.json'] }),
      (error) => typeof error.code === 'string',
    );
  });
});
