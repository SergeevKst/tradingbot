/**
 * SKILL-05 — bounded data-only runtime, fail-closed admission and workflow taint
 * (architecture v1.1 §3.1, §6.3; acceptance criteria AC-04, AC-05, AC-14).
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { createSkillRuntime, SkillAdmissionLatch, SkillWorkflowScope } from '../src/ai/skills/runtime.mjs';
import { createDataBroker } from '../src/ai/skills/data-broker.mjs';
import { ADAPTERS } from '../src/ai/skills/adapters/catalogue.mjs';
import { AI_OPERATIONS } from '../src/ai/operation-profiles.mjs';
import {
  SAMPLE_INPUTS,
  SAMPLE_OUTPUTS,
  buildFixture,
  chatEnvelope,
  fakeTransport,
} from './fixtures/skills/factory.mjs';

/**
 * Build a runtime over a real prepared plan with an injected transport.
 *
 * @param {ReturnType<typeof buildFixture>} fx
 * @param {{ transport?: any, broker?: any, latch?: any, audit?: any, identity?: any }} [options]
 */
function runtimeFor(fx, options = {}) {
  const planResult = fx.preparePlan();
  const transport = options.transport ?? fakeTransport(() => ({ status: 200, body: chatEnvelope(SAMPLE_OUTPUTS.ANALYZE) }));
  const broker = options.broker ?? createDataBroker({ adapters: ADAPTERS, grants: planResult.policy.operationGrants });
  return {
    planResult,
    transport,
    runtime: createSkillRuntime({
      planResult,
      transport,
      broker,
      identity: options.identity ?? { deploymentId: 'deployment-1', generation: 4, slot: 'telegram', instanceId: 'i-1' },
      latch: options.latch,
      audit: options.audit,
      clock: () => 1_000,
      uuid: () => 'req-fixed',
    }),
  };
}

const work = () => ({ workToken: 'work-1' });

describe('Runtime happy path (AC-03, AC-14)', () => {
  test('each operation validates, renders, calls once and returns a typed result', async () => {
    const fx = buildFixture();
    try {
      for (const operation of AI_OPERATIONS) {
        const transport = fakeTransport(() => ({ status: 200, body: chatEnvelope(SAMPLE_OUTPUTS[operation]) }));
        const { runtime } = runtimeFor(fx, { transport });
        const result = await runtime.run({ operation, input: SAMPLE_INPUTS[operation] }, work());
        assert.equal(result.ok, true, `${operation} should succeed`);
        assert.equal(result.operation, operation);
        assert.equal(transport.calls.length, 1, `${operation} makes exactly one model call`);
        assert.equal(result.provenance.operation, operation);
        assert.equal(result.provenance.packageId, fx.packages[operation].parsed.packageId);
        assert.equal(result.provenance.packageDigestSha256, fx.packages[operation].digest);
        assert.equal(result.provenance.generation, 4);
        assert.match(result.provenance.inputDigestSha256, /^[0-9a-f]{64}$/);
        assert.match(result.provenance.outputDigestSha256, /^[0-9a-f]{64}$/);
        assert.equal(result.usage.estimatedCostUsd, null, 'unknown cost stays null, never zero');
        assert.equal(result.usage.pricingVersion, null);
        assert.ok(Object.isFrozen(result));
      }
    } finally {
      fx.cleanup();
    }
  });

  test('the transport receives the reviewed model identity and settings, and no tools', async () => {
    const fx = buildFixture();
    try {
      const transport = fakeTransport(() => ({ status: 200, body: chatEnvelope(SAMPLE_OUTPUTS.GUARD) }));
      const { runtime, planResult } = runtimeFor(fx, { transport });
      await runtime.run({ operation: 'GUARD', input: SAMPLE_INPUTS.GUARD }, work());
      const call = transport.calls[0];
      const planEntry = planResult.plan.operations.GUARD;
      assert.equal(call.identity.modelId, planEntry.modelKey ? call.identity.modelId : null);
      assert.equal(call.identity.canonicalBaseUrl, 'https://api.moonshot.ai/v1');
      assert.equal(call.settings.temperature, 0);
      assert.equal(call.settings.stream, false);
      assert.equal(call.settings.responseFormat, 'json_object');
      assert.equal(call.settings.maxOutputTokens, 1024);
      assert.equal(call.system, fx.packages.GUARD.parsed.instructions, 'the package instructions are the whole system message');
      assert.equal('tools' in call, false);
      assert.equal('tool_choice' in call, false);
    } finally {
      fx.cleanup();
    }
  });
});

describe('Ordinary per-request failures never latch (AC-04 contrast cases)', () => {
  test('malformed model output is SKILL_OUTPUT_INVALID with no latch and no provenance', async () => {
    const fx = buildFixture();
    try {
      for (const body of ['not json', '{"bias":"BULLISH"}', '[]', '{"bias":"BULLISH","confidence":2,"rationale":"x","extra":1}']) {
        const transport = fakeTransport(() => ({ status: 200, body }));
        const { runtime } = runtimeFor(fx, { transport });
        const result = await runtime.run({ operation: 'ANALYZE', input: SAMPLE_INPUTS.ANALYZE }, work());
        assert.equal(result.ok, false);
        assert.equal(result.code, 'SKILL_OUTPUT_INVALID');
        assert.equal(result.retryable, false);
        assert.equal(result.provenance, undefined);
        assert.equal(runtime.admissionState(), 'OPEN', 'ordinary output failure never latches admission');
      }
    } finally {
      fx.cleanup();
    }
  });

  test('a tool request is discarded as SKILL_TOOL_DENIED', async () => {
    const fx = buildFixture();
    try {
      const transport = fakeTransport(() => ({
        status: 200,
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: '1' }] } }] }),
      }));
      const { runtime } = runtimeFor(fx, { transport });
      const result = await runtime.run({ operation: 'GUARD', input: SAMPLE_INPUTS.GUARD }, work());
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SKILL_TOOL_DENIED');
      assert.equal(runtime.admissionState(), 'OPEN');
    } finally {
      fx.cleanup();
    }
  });

  test('an oversized response is SKILL_RESOURCE_EXCEEDED', async () => {
    const fx = buildFixture();
    try {
      const transport = fakeTransport(() => ({ status: 200, body: 'x'.repeat(70 * 1024) }));
      const { runtime } = runtimeFor(fx, { transport });
      const result = await runtime.run({ operation: 'REFLECT', input: SAMPLE_INPUTS.REFLECT }, work());
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SKILL_RESOURCE_EXCEEDED');
    } finally {
      fx.cleanup();
    }
  });

  test('a provider failure is SKILL_PROVIDER_ERROR with no retry', async () => {
    const fx = buildFixture();
    try {
      const transport = fakeTransport(() => {
        throw new Error('socket closed');
      });
      const { runtime } = runtimeFor(fx, { transport });
      const result = await runtime.run({ operation: 'SCOUT', input: SAMPLE_INPUTS.SCOUT }, work());
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SKILL_PROVIDER_ERROR');
      assert.equal(result.retryable, false);
      assert.equal(transport.calls.length, 1, 'v2.0 never retries');
    } finally {
      fx.cleanup();
    }
  });

  test('a timeout aborts the call and is never retried', async () => {
    const fx = buildFixture();
    try {
      let aborted = false;
      const transport = {
        id: 'slow',
        calls: [],
        complete(request) {
          this.calls.push(request);
          return new Promise((resolve, reject) => {
            request.signal.addEventListener('abort', () => {
              aborted = true;
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          });
        },
      };
      const planResult = fx.preparePlan();
      const runtime = createSkillRuntime({
        planResult: {
          ...planResult,
          prepared: new Map([...planResult.prepared].map(([operation, prepared]) => [
            operation,
            Object.freeze({ ...prepared, policy: Object.freeze({ ...prepared.policy, limits: Object.freeze({ ...prepared.policy.limits, timeoutMs: 5 }) }) }),
          ])),
        },
        transport,
        broker: createDataBroker({ adapters: ADAPTERS, grants: planResult.policy.operationGrants }),
        identity: {},
        clock: () => Date.now(),
      });
      const result = await runtime.run({ operation: 'MONITOR', input: SAMPLE_INPUTS.MONITOR }, work());
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SKILL_TIMEOUT');
      assert.equal(aborted, true);
      assert.equal(transport.calls.length, 1);
    } finally {
      fx.cleanup();
    }
  });

  test('invalid host input fails before any model call', async () => {
    const fx = buildFixture();
    try {
      const transport = fakeTransport(() => ({ status: 200, body: chatEnvelope(SAMPLE_OUTPUTS.MONITOR) }));
      const { runtime } = runtimeFor(fx, { transport });
      const result = await runtime.run({ operation: 'MONITOR', input: { news: null } }, work());
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SKILL_INPUT_INVALID');
      assert.equal(transport.calls.length, 0, 'zero model calls for invalid input');
      assert.equal(runtime.admissionState(), 'OPEN');
    } finally {
      fx.cleanup();
    }
  });

  test('a stale snapshot is SKILL_DATA_STALE and taints only its workflow', async () => {
    const fx = buildFixture();
    try {
      const transport = fakeTransport(() => ({ status: 200, body: chatEnvelope(SAMPLE_OUTPUTS.REFLECT) }));
      const { planResult } = runtimeFor(fx, { transport });
      const runtime = createSkillRuntime({
        planResult,
        transport,
        broker: createDataBroker({
          adapters: ADAPTERS,
          grants: planResult.policy.operationGrants,
          freshnessMs: 1000,
          clock: () => 10_000_000,
        }),
        identity: {},
      });
      const scope = new SkillWorkflowScope(work());
      const stale = await runtime.execute({ operation: 'REFLECT', input: { asOf: 1, data: SAMPLE_INPUTS.REFLECT } }, scope);
      assert.equal(stale.code, 'SKILL_DATA_STALE');
      assert.equal(transport.calls.length, 0);
      assert.equal(scope.taintState.structural, false);
      assert.equal(runtime.admissionState(), 'OPEN', 'a stale snapshot is an ordinary failure');
    } finally {
      fx.cleanup();
    }
  });

  test('SCOUT ideas are checked against market geometry, not only the schema', async () => {
    const fx = buildFixture();
    try {
      const cases = [
        // entry far away from the observed lastPrice
        { ideas: [{ symbol: 'BTCUSDT', side: 'LONG', entry: 500, stopLoss: 450, takeProfit: 700, rationale: 'breakout' }] },
        // stop/target do not bracket the entry for a LONG
        { ideas: [{ symbol: 'BTCUSDT', side: 'LONG', entry: 102, stopLoss: 105, takeProfit: 100, rationale: 'reversed levels' }] },
        // symbol absent from the market snapshot
        { ideas: [{ symbol: 'ETHUSDT', side: 'LONG', entry: 102, stopLoss: 99, takeProfit: 107, rationale: 'unknown symbol' }] },
      ];
      for (const output of cases) {
        const transport = fakeTransport(() => ({ status: 200, body: chatEnvelope(output) }));
        const { runtime } = runtimeFor(fx, { transport });
        const result = await runtime.run({ operation: 'SCOUT', input: SAMPLE_INPUTS.SCOUT }, work());
        assert.equal(result.ok, false, `${JSON.stringify(output)} must be refused`);
        assert.equal(result.code, 'SKILL_OUTPUT_INVALID', 'a schema-valid but unsound idea is an ordinary output failure');
        assert.equal(result.value, undefined);
      }
    } finally {
      fx.cleanup();
    }
  });

  test('a per-operation concurrency ceiling refuses rather than queues', async () => {
    const fx = buildFixture();
    try {
      /** @type {any[]} */
      const pending = [];
      const transport = {
        id: 'blocking',
        calls: [],
        complete(request) {
          this.calls.push(request);
          return new Promise((resolve) => pending.push(() => resolve({ status: 200, body: chatEnvelope(SAMPLE_OUTPUTS.GUARD) })));
        },
      };
      const planResult = fx.preparePlan();
      const runtime = createSkillRuntime({
        planResult: {
          ...planResult,
          policy: Object.freeze({
            ...planResult.policy,
            limits: Object.freeze({
              ...planResult.policy.limits,
              maxConcurrentByOperation: Object.freeze({ ...planResult.policy.limits.maxConcurrentByOperation, GUARD: 1 }),
            }),
          }),
        },
        transport,
        broker: createDataBroker({ adapters: ADAPTERS, grants: planResult.policy.operationGrants }),
        identity: {},
      });
      const first = runtime.run({ operation: 'GUARD', input: SAMPLE_INPUTS.GUARD }, { workToken: 'w1' });
      const second = await runtime.run({ operation: 'GUARD', input: SAMPLE_INPUTS.GUARD }, { workToken: 'w2' });
      assert.equal(second.ok, false);
      assert.equal(second.code, 'SKILL_RESOURCE_EXCEEDED');
      pending.forEach((resolve) => resolve());
      assert.equal((await first).ok, true);
    } finally {
      fx.cleanup();
    }
  });
});

describe('Structural refusal, latch and workflow taint (AC-04)', () => {
  /**
   * A prepared entry whose render pointer is missing from a schema-valid input
   * models the "layout is valid at publication but broken at run time" case.
   */
  function brokenLayoutPlan(planResult, operation) {
    const prepared = planResult.prepared.get(operation);
    const broken = Object.freeze({
      ...prepared,
      layout: Object.freeze({ schemaVersion: 1, userParts: Object.freeze([{ label: 'DATA', valuePointer: '/missing/field' }]) }),
    });
    return { ...planResult, prepared: new Map([...planResult.prepared, [operation, broken]]) };
  }

  test('a render fault returns ACTIVATION_PAUSED, latches admission and makes zero model calls', async () => {
    const fx = buildFixture();
    try {
      const transport = fakeTransport(() => ({ status: 200, body: chatEnvelope(SAMPLE_OUTPUTS.REFLECT) }));
      const planResult = fx.preparePlan();
      const runtime = createSkillRuntime({
        planResult: brokenLayoutPlan(planResult, 'REFLECT'),
        transport,
        broker: createDataBroker({ adapters: ADAPTERS, grants: planResult.policy.operationGrants }),
        identity: {},
      });
      const result = await runtime.run({ operation: 'REFLECT', input: SAMPLE_INPUTS.REFLECT }, work());
      assert.equal(result.ok, false);
      assert.equal(result.code, 'ACTIVATION_PAUSED');
      assert.equal(result.cause, 'SKILL_RENDER_INVALID');
      assert.equal(result.retryable, false);
      assert.match(result.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(transport.calls.length, 0);
      assert.equal(runtime.admissionState(), 'LATCHED_CLOSED');
      assert.equal(runtime.admissionCause(), 'SKILL_RENDER_INVALID');

      // Every other operation now refuses with the original cause, without
      // touching the provider, and a retry cannot clear the latch.
      for (const operation of AI_OPERATIONS) {
        const other = await runtime.run({ operation, input: SAMPLE_INPUTS[operation] }, { workToken: `w-${operation}` });
        assert.equal(other.code, 'ACTIVATION_PAUSED');
        assert.equal(other.cause, 'SKILL_RENDER_INVALID');
      }
      const retry = await runtime.run({ operation: 'REFLECT', input: SAMPLE_INPUTS.REFLECT }, work());
      assert.equal(retry.code, 'ACTIVATION_PAUSED');
      assert.equal(runtime.admissionState(), 'LATCHED_CLOSED');
      assert.equal(transport.calls.length, 0);
    } finally {
      fx.cleanup();
    }
  });

  test('a structural fault taints the joined workflow and invalidates effect handles', async () => {
    const fx = buildFixture();
    try {
      const transport = fakeTransport((request) => {
        const isScout = request.system === fx.packages.SCOUT.parsed.instructions;
        return { status: 200, body: chatEnvelope(isScout ? SAMPLE_OUTPUTS.SCOUT : SAMPLE_OUTPUTS.GUARD) };
      });
      const planResult = fx.preparePlan();
      const runtime = createSkillRuntime({
        planResult: brokenLayoutPlan(planResult, 'GUARD'),
        transport,
        broker: createDataBroker({ adapters: ADAPTERS, grants: planResult.policy.operationGrants }),
        identity: {},
      });
      const scope = new SkillWorkflowScope(work());
      const handle = scope.registerEffectHandle('exit-proposal');
      assert.equal(handle.isUsable(), true);

      await runtime.execute({ operation: 'SCOUT', input: SAMPLE_INPUTS.SCOUT }, scope);
      const guard = await runtime.execute({ operation: 'GUARD', input: SAMPLE_INPUTS.GUARD }, scope);
      assert.equal(guard.code, 'ACTIVATION_PAUSED');
      assert.equal(handle.isUsable(), false, 'an unconsumed effect handle is invalidated');
      assert.equal(scope.taintState.structural, true);

      // A sibling operation in the same workflow cannot dispatch after the fault.
      const sibling = await runtime.execute({ operation: 'SCOUT', input: SAMPLE_INPUTS.SCOUT }, scope);
      assert.equal(sibling.code, 'ACTIVATION_PAUSED');
      assert.equal(transport.calls.length, 1, 'only the pre-fault call reached the provider');
      assert.throws(() => handle.consume());
    } finally {
      fx.cleanup();
    }
  });

  test('an ordinary failure taints its workflow but does not latch the participant', async () => {
    const fx = buildFixture();
    try {
      const transport = fakeTransport(() => ({ status: 200, body: 'not json' }));
      const { runtime } = runtimeFor(fx, { transport });
      const scope = new SkillWorkflowScope(work());
      const failed = await runtime.execute({ operation: 'SCOUT', input: SAMPLE_INPUTS.SCOUT }, scope);
      assert.equal(failed.code, 'SKILL_OUTPUT_INVALID');
      assert.equal(scope.taintState.structural, false);
      assert.equal(runtime.admissionState(), 'OPEN');

      // The same workflow cannot proceed, but a fresh workflow can.
      const sibling = await runtime.execute({ operation: 'GUARD', input: SAMPLE_INPUTS.GUARD }, scope);
      assert.equal(sibling.ok, false);
      assert.equal(sibling.code, 'SKILL_OUTPUT_INVALID');
    } finally {
      fx.cleanup();
    }
  });

  test('telemetry failure never delays or changes a refusal', async () => {
    const fx = buildFixture();
    try {
      const transport = fakeTransport(() => ({ status: 200, body: chatEnvelope(SAMPLE_OUTPUTS.REFLECT) }));
      const planResult = fx.preparePlan();
      const runtime = createSkillRuntime({
        planResult: brokenLayoutPlan(planResult, 'REFLECT'),
        transport,
        broker: createDataBroker({ adapters: ADAPTERS, grants: planResult.policy.operationGrants }),
        identity: {},
        audit: () => {
          throw new Error('audit store unavailable');
        },
      });
      const result = await runtime.run({ operation: 'REFLECT', input: SAMPLE_INPUTS.REFLECT }, work());
      assert.equal(result.code, 'ACTIVATION_PAUSED');
      assert.equal(result.cause, 'SKILL_RENDER_INVALID');
      assert.equal(runtime.admissionState(), 'LATCHED_CLOSED');
    } finally {
      fx.cleanup();
    }
  });

  test('the shared latch closes for every operation of the participant', async () => {
    const fx = buildFixture();
    try {
      const transport = fakeTransport(() => ({ status: 200, body: chatEnvelope(SAMPLE_OUTPUTS.ANALYZE) }));
      const latch = new SkillAdmissionLatch();
      const { runtime } = runtimeFor(fx, { transport, latch });
      latch.close('SKILL_INTEGRITY_MISMATCH');
      for (const operation of AI_OPERATIONS) {
        const result = await runtime.run({ operation, input: SAMPLE_INPUTS[operation] }, work());
        assert.equal(result.code, 'ACTIVATION_PAUSED');
        assert.equal(result.cause, 'SKILL_INTEGRITY_MISMATCH');
      }
      assert.equal(transport.calls.length, 0);
    } finally {
      fx.cleanup();
    }
  });

  test('a missing prepared package is a structural refusal, not a fallback', async () => {
    const fx = buildFixture();
    try {
      const planResult = fx.preparePlan();
      const partial = { ...planResult, prepared: new Map([...planResult.prepared].filter(([operation]) => operation !== 'STOPCHECK')) };
      const transport = fakeTransport(() => ({ status: 200, body: chatEnvelope(SAMPLE_OUTPUTS.STOPCHECK) }));
      const runtime = createSkillRuntime({
        planResult: partial,
        transport,
        broker: createDataBroker({ adapters: ADAPTERS, grants: planResult.policy.operationGrants }),
        identity: {},
      });
      const result = await runtime.run({ operation: 'STOPCHECK', input: SAMPLE_INPUTS.STOPCHECK }, work());
      assert.equal(result.code, 'ACTIVATION_PAUSED');
      assert.equal(result.cause, 'SKILL_MISSING');
      assert.equal(transport.calls.length, 0);
    } finally {
      fx.cleanup();
    }
  });
});
