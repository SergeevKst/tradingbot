/**
 * SKILL-07 — offline integration and regression harness (architecture v1.1
 * §3.1, §9.2; acceptance criteria AC-10, AC-13, AC-14).
 *
 * The whole six-operation flow runs through the real composition, the real CAS
 * and the real execution plan. Only the provider transport is injected: no
 * network, no exchange client, no credentials.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { AI_OPERATIONS } from '../src/ai/operation-profiles.mjs';
import { SkillWorkflowScope } from '../src/ai/skills/runtime.mjs';
import {
  SAMPLE_INPUTS,
  SAMPLE_OUTPUTS,
  buildFixture,
  chatEnvelope,
  readBaselinePackages,
} from './fixtures/skills/factory.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * A transport that answers with the sample output whose package instructions
 * match the request.
 *
 * @param {ReturnType<typeof buildFixture>} fx
 * @param {any[]} calls
 */
function scriptedTransport(fx, calls) {
  return {
    id: 'offline-scripted',
    calls,
    async complete(request) {
      calls.push(request);
      const operation = AI_OPERATIONS.find((candidate) => fx.packages[candidate].parsed.instructions === request.system);
      assert.ok(operation, 'every request must carry a verified package instruction set');
      return { status: 200, body: chatEnvelope(SAMPLE_OUTPUTS[operation]), usage: null, latencyMs: 1 };
    },
  };
}

describe('Offline six-operation integration (AC-10)', () => {
  test('one joined workflow runs every operation with its own skill and model', async () => {
    const fx = buildFixture();
    try {
      const calls = [];
      const composition = fx.createComposition({ transport: scriptedTransport(fx, calls) });
      assert.equal(composition.refusing, false);
      const scope = new SkillWorkflowScope({ workToken: 'work-integration' });

      const scout = await composition.execute({ operation: 'SCOUT', input: SAMPLE_INPUTS.SCOUT }, scope);
      const guard = await composition.execute({ operation: 'GUARD', input: SAMPLE_INPUTS.GUARD }, scope);
      const monitor = await composition.execute({ operation: 'MONITOR', input: SAMPLE_INPUTS.MONITOR }, scope);
      const stopcheck = await composition.execute({ operation: 'STOPCHECK', input: SAMPLE_INPUTS.STOPCHECK }, scope);
      const reflect = await composition.execute({ operation: 'REFLECT', input: SAMPLE_INPUTS.REFLECT }, scope);

      for (const result of [scout, guard, monitor, stopcheck, reflect]) {
        assert.equal(result.ok, true, `${result.operation} should succeed offline`);
        assert.equal(result.provenance.generation, 7);
        assert.equal(result.provenance.executionPlanSha256, composition.planSha256);
        assert.equal(result.provenance.slot, 'telegram');
        assert.equal(result.provenance.instanceId, 'instance-1');
      }

      // Five operations, five model calls, five distinct model identities.
      assert.equal(calls.length, 5);
      const models = calls.map((call) => call.identity.modelId);
      assert.equal(new Set(models).size, 5, 'every operation dispatches its own model identity');
      assert.equal(models.includes('kimi-k2-monitor'), true);
      assert.equal(models.includes('kimi-k2-guard'), true);

      // The workflow is not tainted by a successful run.
      assert.equal(scope.taintState, null);
    } finally {
      fx.cleanup();
    }
  });

  test('the result is deterministic for identical input and response', async () => {
    const fx = buildFixture();
    try {
      const callsA = [];
      const callsB = [];
      const a = fx.createComposition({ transport: scriptedTransport(fx, callsA) });
      const b = fx.createComposition({ transport: scriptedTransport(fx, callsB) });
      const first = await a.REFLECT(SAMPLE_INPUTS.REFLECT, { workToken: 'w1' });
      const second = await b.REFLECT(SAMPLE_INPUTS.REFLECT, { workToken: 'w2' });
      assert.equal(first.provenance.outputDigestSha256, second.provenance.outputDigestSha256);
      assert.equal(first.provenance.inputDigestSha256, second.provenance.inputDigestSha256);
      assert.equal(first.provenance.packageDigestSha256, second.provenance.packageDigestSha256);
      assert.deepEqual(first.value, second.value);
    } finally {
      fx.cleanup();
    }
  });

  test('local validation and rendering stay within the reviewed overhead budget', async () => {
    const fx = buildFixture();
    try {
      const composition = fx.createComposition({
        transport: { id: 'instant', calls: [], async complete() { return { status: 200, body: chatEnvelope(SAMPLE_OUTPUTS.REFLECT), usage: null, latencyMs: 0 }; } },
      });
      const samples = [];
      for (let index = 0; index < 60; index += 1) {
        const started = process.hrtime.bigint();
        const result = await composition.REFLECT(SAMPLE_INPUTS.REFLECT, { workToken: `w-${index}` });
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        assert.equal(result.ok, true);
        samples.push(elapsedMs);
      }
      samples.sort((left, right) => left - right);
      const p95 = samples[Math.floor(samples.length * 0.95)];
      // The architecture's target is <=10 ms p95 of added local work on the CI
      // host; the bound here is deliberately loose so a slow machine does not
      // produce a false failure while still catching a pathological regression.
      assert.ok(p95 < 50, `p95 local validation+render ${p95.toFixed(2)}ms exceeds the reviewed budget`);
    } finally {
      fx.cleanup();
    }
  });
});

describe('Skill layer boundary (AC-05, AC-10)', () => {
  const skillsRoot = path.join(REPO_ROOT, 'src', 'ai', 'skills');
  const files = fs
    .readdirSync(skillsRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));

  test('no skill runtime module imports an exchange, credential or process module', () => {
    const banned = ['exchange', 'credential', 'child_process', 'node:vm', 'node:net', 'http', 'undici', 'axios'];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
      for (const specifier of specifiers) {
        for (const token of banned) {
          assert.equal(
            specifier.includes(token),
            false,
            `${path.relative(REPO_ROOT, file)} must not import ${specifier} (matched ${token})`,
          );
        }
      }
    }
  });

  test('only the administrative store touches the filesystem', () => {
    for (const file of files) {
      const relative = path.relative(skillsRoot, file).replaceAll(path.sep, '/');
      const text = fs.readFileSync(file, 'utf8');
      if (relative === 'package-store.mjs') continue;
      assert.equal(/from 'node:fs'/.test(text), false, `${relative} must not import node:fs`);
    }
  });

  test('no skill module reads the environment or executes code', () => {
    for (const file of files) {
      const relative = path.relative(skillsRoot, file).replaceAll(path.sep, '/');
      const code = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
        })
        .join('\n');
      for (const banned of ['process.env', 'eval(', 'new Function(', 'import(']) {
        assert.equal(code.includes(banned), false, `${relative} must not use ${banned}`);
      }
    }
  });

  test('skills never carry executable content', () => {
    for (const [operation, packageFiles] of Object.entries(readBaselinePackages())) {
      for (const file of packageFiles) {
        assert.equal(/\.(mjs|cjs|js|py|sh|wasm|node)$/.test(file.path), false, `${operation} ships executable ${file.path}`);
      }
    }
  });
});
