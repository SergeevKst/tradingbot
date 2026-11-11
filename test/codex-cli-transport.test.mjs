/**
 * Codex CLI transport — safety and contract tests (hermetic, mock spawn).
 *
 * Every test here is offline: `spawn` is injected, so no real Codex process is
 * started and no subscription quota is consumed. What is asserted is exactly the
 * set of properties the adapter relies on in production: fixed argv, no shell,
 * prompt over stdin, schema file written and passed, sanitized environment, hard
 * timeout, single in-flight call, hourly budget, and no credential in a failure
 * message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';

import { createCodexCliTransport, parseCodexEventStream, sanitizeStderr } from '../src/providers/codex/codex-cli-transport.mjs';

// ─── Mock spawn ──────────────────────────────────────────────────────────────

/**
 * A minimal ChildProcess stand-in: two readable streams, a writable stdin and a
 * controllable close event.
 */
function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    ended: null,
    end(text) {
      this.ended = text;
    },
  };
  child.killed = null;
  child.kill = (signal) => {
    child.killed = signal;
  };
  return child;
}

/**
 * Build a spawn double. `behaviour(argv, options, child)` decides what happens.
 *
 * @param {(argv: string[], options: object, child: any) => void} behaviour
 */
function spawnDouble(behaviour) {
  const calls = [];
  const spawnImpl = (command, argv, options) => {
    const child = makeChild();
    calls.push({ command, argv, options, child });
    // Defer the behaviour so the transport can attach its listeners first, the
    // way a real child process behaves.
    setImmediate(() => behaviour(argv, options, child));
    return child;
  };
  return { spawnImpl, calls };
}

/** Emit an agent message and a usage block, then close with `code=0`. */
function reply(child, text, usage = { input_tokens: 120, output_tokens: 9 }) {
  child.stdout.emit('data', `${JSON.stringify({ type: 'thread.started', thread_id: 't' })}\n`);
  child.stdout.emit('data', `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`);
  child.stdout.emit('data', `${JSON.stringify({ type: 'turn.completed', usage })}\n`);
  child.emit('close', 0);
}

const ENV_SOURCE = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/Users/example',
  CODEX_HOME: '/Users/example/.codex',
  LANG: 'C.UTF-8',
  OPENAI_API_KEY: 'sk-should-never-reach-the-child',
  CODEX_ACCESS_TOKEN: 'token-should-never-reach-the-child',
  BYBIT_API_KEY: 'bybit-secret',
  TELEGRAM_BOT_TOKEN: 'bot-secret',
  DEEPSEEK_API_KEY: 'deepseek-secret',
});

// ─── Tests ───────────────────────────────────────────────────────────────────

test('TRANSPORT: fixed argv, no shell, prompt on stdin, schema file written', async () => {
  let schemaSeen = null;
  const { spawnImpl, calls } = spawnDouble((argv, options, child) => {
    const schemaIndex = argv.indexOf('--output-schema');
    if (schemaIndex !== -1) schemaSeen = JSON.parse(readFileSync(argv[schemaIndex + 1], 'utf8'));
    reply(child, '{"bias":"BULLISH","confidence":0.7,"rationale":"x"}');
  });
  const transport = createCodexCliTransport({ spawnImpl, env: ENV_SOURCE });

  const result = await transport.complete({
    prompt: 'SYSTEM\n\nUSER',
    model: 'gpt-6.1-sol',
    schema: { type: 'object', properties: { bias: { type: 'string' } } },
    reasoningEffort: 'low',
    timeoutMs: 5000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.content, '{"bias":"BULLISH","confidence":0.7,"rationale":"x"}');
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    cachedInputTokens: 0,
    outputTokens: 9,
    reasoningOutputTokens: 0,
  });

  assert.equal(calls.length, 1);
  const { command, argv, options } = calls[0];
  assert.equal(command, 'codex');
  assert.deepEqual(argv.slice(0, 7), [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--sandbox',
    'read-only',
    '--json',
  ]);
  assert.equal(argv[argv.length - 1], '-', 'the prompt must be delivered on stdin');
  assert.ok(argv.includes('-m') && argv.includes('gpt-6.1-sol'));
  assert.ok(argv.includes('-c') && argv.includes('model_reasoning_effort="low"'));
  assert.equal(options.shell, false, 'the child must never be started through a shell');
  assert.equal(calls[0].child.stdin.ended, 'SYSTEM\n\nUSER');
  assert.deepEqual(schemaSeen, { type: 'object', properties: { bias: { type: 'string' } } });
  assert.equal(transport.stats().calls, 1);
});

test('TRANSPORT: the child environment is rebuilt from an allowlist', async () => {
  const { spawnImpl, calls } = spawnDouble((_argv, _options, child) => reply(child, '{"ok":true}'));
  const transport = createCodexCliTransport({ spawnImpl, env: ENV_SOURCE });
  await transport.complete({ prompt: 'p', model: 'gpt-6.1-sol' });

  const env = calls[0].options.env;
  assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'PATH']);
  for (const forbidden of ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'BYBIT_API_KEY', 'TELEGRAM_BOT_TOKEN', 'DEEPSEEK_API_KEY']) {
    assert.equal(env[forbidden], undefined, `${forbidden} must never reach the child`);
  }
});

test('TRANSPORT: a last-message file wins over the event stream', async () => {
  const { spawnImpl } = spawnDouble((argv, _options, child) => {
    const outIndex = argv.indexOf('-o');
    assert.notEqual(outIndex, -1, 'the transport must ask the CLI for a last-message file');
    // The CLI writes the final message to the -o path.
    writeFileSync(argv[outIndex + 1], '{"bias":"NEUTRAL","confidence":0.1,"rationale":"file"}', 'utf8');
    reply(child, '{"bias":"BULLISH","confidence":0.9,"rationale":"stream"}');
  });
  const transport = createCodexCliTransport({ spawnImpl, env: {} });
  const result = await transport.complete({ prompt: 'p', model: 'gpt-6.1-sol' });
  assert.equal(result.ok, true);
  assert.match(result.content, /NEUTRAL/);
});

test('TRANSPORT: a hung child is killed and reported as TIMEOUT', async () => {
  const { spawnImpl, calls } = spawnDouble(() => {
    // Never emits and never closes.
  });
  const transport = createCodexCliTransport({ spawnImpl, env: {}, timeoutMs: 25 });
  const result = await transport.complete({ prompt: 'p', model: 'gpt-6.1-sol', timeoutMs: 25 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TIMEOUT');
  assert.equal(calls[0].child.killed, 'SIGKILL');
  assert.equal(transport.stats().inFlight, false, 'a timed-out call must release the in-flight slot');
});

test('TRANSPORT: only one call may be in flight, and the next is refused', async () => {
  /** @type {any} */
  let pending = null;
  const { spawnImpl, calls } = spawnDouble((_argv, _options, child) => {
    pending = child;
  });
  const transport = createCodexCliTransport({ spawnImpl, env: {} });
  const first = transport.complete({ prompt: 'p', model: 'gpt-6.1-sol' });
  // The transport creates its throwaway workspace before spawning.
  for (let i = 0; i < 200 && pending === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.notEqual(pending, null, 'the first call must have spawned');

  const second = await transport.complete({ prompt: 'p2', model: 'gpt-6.1-sol' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'BUSY');

  reply(pending, '{"ok":true}');
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
});

test('TRANSPORT: the hourly call budget is enforced before spawning', async () => {
  const { spawnImpl, calls } = spawnDouble((_argv, _options, child) => reply(child, '{"ok":true}'));
  let nowMs = 1_700_000_000_000;
  const transport = createCodexCliTransport({ spawnImpl, env: {}, maxCallsPerHour: 2, clock: () => nowMs });

  assert.equal((await transport.complete({ prompt: 'p', model: 'gpt-6.1-sol' })).ok, true);
  nowMs += 1000;
  assert.equal((await transport.complete({ prompt: 'p', model: 'gpt-6.1-sol' })).ok, true);
  nowMs += 1000;
  const third = await transport.complete({ prompt: 'p', model: 'gpt-6.1-sol' });
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'BUDGET_EXHAUSTED');
  assert.equal(calls.length, 2, 'a refused call must not spawn a process');

  // The sliding window releases the budget an hour later.
  nowMs += 3_600_000;
  assert.equal((await transport.complete({ prompt: 'p', model: 'gpt-6.1-sol' })).ok, true);
});

test('TRANSPORT: malformed requests fail closed without spawning', async () => {
  const { spawnImpl, calls } = spawnDouble((_argv, _options, child) => reply(child, '{"ok":true}'));
  const transport = createCodexCliTransport({ spawnImpl, env: {}, allowedModels: ['gpt-6.1-sol'], maxPromptBytes: 16 });

  assert.equal((await transport.complete({ prompt: '', model: 'gpt-6.1-sol' })).reason, 'INVALID_REQUEST');
  assert.equal((await transport.complete({ prompt: 'p', model: 'gpt-6-astra' })).reason, 'MODEL_NOT_ALLOWED');
  assert.equal((await transport.complete({ prompt: 'p', model: 'GPT-6' })).reason, 'INVALID_MODEL');
  assert.equal((await transport.complete({ prompt: 'p', model: 'gpt-6.1-sol', reasoningEffort: 'max' })).reason, 'INVALID_REASONING_EFFORT');
  assert.equal(
    (await transport.complete({ prompt: 'x'.repeat(32), model: 'gpt-6.1-sol' })).reason,
    'PROMPT_TOO_LARGE',
  );
  assert.equal(calls.length, 0);
});

test('TRANSPORT: a failing run reports a sanitized reason, never a credential', async () => {
  const { spawnImpl } = spawnDouble((_argv, _options, child) => {
    child.stderr.emit('data', 'authorization: Bearer sk-abcdef1234567890 eyJhbGciOiJIUzI1NiJ9.payload.sig');
    child.emit('close', 1);
  });
  const transport = createCodexCliTransport({ spawnImpl, env: {} });
  const result = await transport.complete({ prompt: 'p', model: 'gpt-6.1-sol' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EXIT_NONZERO');
  assert.equal(result.exitCode, 1);
  assert.ok(!result.detail.includes('sk-abcdef1234567890'), 'an API-key-shaped string must be redacted');
  assert.ok(!result.detail.includes('eyJhbGciOiJIUzI1NiJ9'), 'a JWT must be redacted');
});

test('TRANSPORT: a non-zero exit fails closed even when the output looks complete', async () => {
  // S2-1 regression: `codex exec` can write a fully valid `-o` artifact and a
  // completed agent_message event before dying. That is a failed process, not a
  // successful call, and the transport must not consume the content.
  const { spawnImpl } = spawnDouble((argv, _options, child) => {
    const outIndex = argv.indexOf('-o');
    writeFileSync(argv[outIndex + 1], '{"bias":"BULLISH","confidence":0.9,"rationale":"file"}', 'utf8');
    child.stdout.emit(
      'data',
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"bias":"BULLISH","confidence":0.9,"rationale":"stream"}' } })}\n`,
    );
    child.stderr.emit('data', 'codex exec aborted after writing output');
    child.emit('close', 3);
  });
  const transport = createCodexCliTransport({ spawnImpl, env: {} });
  const result = await transport.complete({ prompt: 'p', model: 'gpt-6.1-sol' });

  assert.equal(result.ok, false, 'a non-zero CLI exit must never be reported as success');
  assert.equal(result.reason, 'EXIT_NONZERO');
  assert.equal(result.exitCode, 3);
  assert.equal(result.content, undefined, 'no partially written answer may be returned');
  assert.equal(transport.stats().calls, 1);
});

test('TRANSPORT: a structured error event is reported as CLI_ERROR with its message', async () => {
  const { spawnImpl } = spawnDouble((_argv, _options, child) => {
    child.stdout.emit(
      'data',
      `${JSON.stringify({ type: 'error', message: 'Invalid schema for response_format: missing evidence' })}\n`,
    );
    child.stderr.emit('data', 'unrelated MCP transport noise');
    child.emit('close', 1);
  });
  const transport = createCodexCliTransport({ spawnImpl, env: {} });
  const result = await transport.complete({ prompt: 'p', model: 'gpt-6.1-sol' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CLI_ERROR');
  assert.match(result.detail, /Invalid schema/);
});

test('TRANSPORT: an empty stream is NO_MESSAGE, not an empty object', async () => {
  const { spawnImpl } = spawnDouble((_argv, _options, child) => {
    child.stdout.emit('data', '');
    child.emit('close', 0);
  });
  const transport = createCodexCliTransport({ spawnImpl, env: {} });
  const result = await transport.complete({ prompt: 'p', model: 'gpt-6.1-sol' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_MESSAGE');
});

test('TRANSPORT: parseCodexEventStream ignores noise and keeps the last message', () => {
  const stdout = [
    'not json at all',
    '{"type":"thread.started"}',
    '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"a\\":1}"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"b\\":2}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}',
    '{"truncated":',
  ].join('\n');
  const parsed = parseCodexEventStream(stdout);
  assert.equal(parsed.content, '{"b":2}');
  assert.equal(parsed.usage.inputTokens, 5);
  assert.equal(parsed.usage.outputTokens, 2);
});

test('TRANSPORT: sanitizeStderr keeps only a short tail', () => {
  const long = 'x'.repeat(2000);
  const sanitized = sanitizeStderr(`${long} done`);
  assert.ok(sanitized.length <= 400);
  assert.ok(sanitized.endsWith('done'));
});
