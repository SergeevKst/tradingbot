/**
 * Phase 2 retry-policy tests (MASTER_SPEC §23).
 *
 * The policy must be explicit and bounded, and only retryable error classes may
 * be replayed. `sleep` is injected so the tests are instant and deterministic.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ConfigurationError, DataError, NetworkError, RateLimitError, isRetryable } from '../src/errors/taxonomy.mjs';
import { backoffDelay, createRetryPolicy, DEFAULT_RETRY_POLICY, retry } from '../src/market-data/retry.mjs';

test('RETRY: the default policy is bounded and explicit', () => {
  assert.deepEqual(DEFAULT_RETRY_POLICY, { attempts: 3, baseDelayMs: 250, maxDelayMs: 4000, jitter: 0.2 });
  assert.ok(Object.isFrozen(DEFAULT_RETRY_POLICY));
});

test('RETRY: a partial policy merges onto the default and is validated', () => {
  const policy = createRetryPolicy({ attempts: 5 });
  assert.equal(policy.attempts, 5);
  assert.equal(policy.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs);
  assert.ok(Object.isFrozen(policy));

  assert.throws(() => createRetryPolicy({ attempts: 0 }), ConfigurationError);
  assert.throws(() => createRetryPolicy({ attempts: 1.5 }), ConfigurationError);
  assert.throws(() => createRetryPolicy({ baseDelayMs: -1 }), ConfigurationError);
  assert.throws(() => createRetryPolicy({ maxDelayMs: 1, baseDelayMs: 100 }), ConfigurationError);
  assert.throws(() => createRetryPolicy({ jitter: 2 }), ConfigurationError);
  assert.throws(() => createRetryPolicy(null), ConfigurationError);
});

test('RETRY: backoff grows exponentially and is capped', () => {
  const policy = createRetryPolicy({ baseDelayMs: 100, maxDelayMs: 500, jitter: 0 });
  assert.equal(backoffDelay(policy, 1, () => 0.5), 100);
  assert.equal(backoffDelay(policy, 2, () => 0.5), 200);
  assert.equal(backoffDelay(policy, 3, () => 0.5), 400);
  assert.equal(backoffDelay(policy, 4, () => 0.5), 500, 'the cap must hold');
});

test('RETRY: jitter stays within the configured fraction', () => {
  const policy = createRetryPolicy({ baseDelayMs: 1000, maxDelayMs: 1000, jitter: 0.2 });
  assert.equal(backoffDelay(policy, 1, () => 0), 800);
  assert.equal(backoffDelay(policy, 1, () => 1), 1200);
});

test('RETRY: a retryable error is retried and can succeed', async () => {
  let calls = 0;
  const delays = [];
  const value = await retry(
    async () => {
      calls += 1;
      if (calls < 3) throw new NetworkError('flaky');
      return 'ok';
    },
    { policy: { attempts: 3, baseDelayMs: 10 }, sleep: async (ms) => delays.push(ms), random: () => 0.5 },
  );

  assert.equal(value, 'ok');
  assert.equal(calls, 3);
  assert.equal(delays.length, 2, 'two backoff sleeps before the third attempt');
});

test('RETRY: a non-retryable error is never replayed', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retry(
        async () => {
          calls += 1;
          throw new DataError('unusable market data');
        },
        { policy: { attempts: 5 }, sleep: async () => {} },
      ),
    DataError,
  );
  assert.equal(calls, 1, 'DataError must not be retried');
  assert.equal(isRetryable(new DataError('x')), false);
});

test('RETRY: retries stop at the attempt cap and report each retry', async () => {
  let calls = 0;
  const retries = [];
  await assert.rejects(
    () =>
      retry(
        async () => {
          calls += 1;
          throw new RateLimitError('slow down');
        },
        {
          policy: { attempts: 3, baseDelayMs: 1, jitter: 0 },
          sleep: async () => {},
          random: () => 0.5,
          onRetry: (info) => retries.push(info),
        },
      ),
    RateLimitError,
  );
  assert.equal(calls, 3);
  assert.equal(retries.length, 2);
  assert.deepEqual(retries.map((entry) => entry.attempt), [1, 2]);
});

test('RETRY: an unknown error is not retryable', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retry(
        async () => {
          calls += 1;
          throw new Error('plain');
        },
        { sleep: async () => {} },
      ),
    /plain/,
  );
  assert.equal(calls, 1);
});
