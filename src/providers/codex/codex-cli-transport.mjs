/**
 * Codex CLI transport — the only place in the bot that starts a model process.
 *
 * BACKGROUND (verified 2026-11-11 on codex-cli 0.163.0):
 *   - `codex exec` is the documented non-interactive mode of the official Codex
 *     CLI. `codex login status` reports "Logged in using ChatGPT", i.e. the
 *     owner's subscription, and `codex doctor` reports `stored API key: false`
 *     plus a `wss://chatgpt.com/backend-api/...` inference endpoint. There is no
 *     OpenAI Platform API key anywhere in this path.
 *   - `codex exec` accepts `--output-schema <file>` and `-o <file>`, so a
 *     structured answer can be demanded and collected without parsing the
 *     agent's chatter.
 *
 * SAFETY PROPERTIES (each one is asserted by a test):
 *   - no shell: the child is spawned with an argv array, never a command string;
 *   - argv is fixed by this module; a caller can only influence the model id,
 *     the reasoning effort and the contents of a prompt sent over stdin;
 *   - the child runs with `--sandbox read-only`, `--ephemeral`,
 *     `--skip-git-repo-check` and `--ignore-user-config`, in an empty throwaway
 *     working directory, so no repository, hook, MCP server or user config is
 *     loaded (`codex exec --help`: "auth still uses CODEX_HOME");
 *   - the environment is rebuilt from an allowlist. `OPENAI_API_KEY`,
 *     `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` are always dropped, so a stray
 *     key in the bot's environment can never turn subscription inference into
 *     metered API billing, and exchange/bot secrets never reach the child;
 *   - one in-flight call at a time and a sliding-window call budget, so a bug in
 *     a loop cannot spin up parallel subscription usage;
 *   - a hard timeout kills the child with SIGKILL;
 *   - nothing here can place an order: this module imports no exchange, account
 *     or execution code.
 *
 * @module providers/codex/codex-cli-transport
 */
import { spawn as defaultSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../../config/config-error.mjs';
import { buildCodexChildEnv, CODEX_PROVIDER_ID, CODEX_REASONING_EFFORTS } from '../../config/codex.mjs';
import { silentLogger } from '../../util/logger.mjs';

export { CODEX_PROVIDER_ID, CODEX_REASONING_EFFORTS };

/**
 * The fixed `codex exec` argument prefix. Nothing in this list is derived from
 * untrusted input.
 *
 * `--json` makes the CLI emit a JSONL event stream, which is what lets the
 * transport pick the final agent message deterministically instead of scraping
 * a terminal UI.
 */
export const CODEX_EXEC_BASE_ARGV = Object.freeze([
  'exec',
  '--ephemeral',
  '--skip-git-repo-check',
  '--ignore-user-config',
  '--sandbox',
  'read-only',
  '--json',
]);

/** Model identifiers must be plainer than plain identifiers: no shell-ish text. */
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0;
}

/**
 * Trim a stderr tail so a crash report stays useful without dumping a whole
 * transcript. Secrets are stripped defensively; the child never receives one.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeStderr(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text
    .replace(/eyJ[A-Za-z0-9._-]{10,}/g, '<redacted-jwt>')
    .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, '$1<redacted>')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '<redacted-key>')
    .slice(-400);
}

/**
 * Parse the CLI's JSONL event stream. Only two event kinds carry information we
 * need: the completed agent message and the turn usage block. Unknown events are
 * ignored, and malformed lines are skipped rather than trusted.
 *
 * @param {string} stdout
 * @returns {{ content: string | null, usage: object | null, errors: string[] }}
 */
export function parseCodexEventStream(stdout) {
  /** @type {string | null} */
  let content = null;
  /** @type {object | null} */
  let usage = null;
  const errors = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.startsWith('{')) continue;
    /** @type {any} */
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      content = event.item.text;
      continue;
    }
    if (event?.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
      usage = Object.freeze({
        inputTokens: Number(event.usage.input_tokens) || 0,
        cachedInputTokens: Number(event.usage.cached_input_tokens) || 0,
        outputTokens: Number(event.usage.output_tokens) || 0,
        reasoningOutputTokens: Number(event.usage.reasoning_output_tokens) || 0,
      });
      continue;
    }
    if (event?.type === 'error' || event?.type === 'turn.failed') {
      errors.push(String(event.message ?? event.error?.message ?? 'codex error event'));
    }
  }
  return { content, usage, errors };
}

/**
 * @typedef {object} CodexCliTransportOptions
 * @property {string} [command] executable name or absolute path (default `codex`)
 * @property {number} [timeoutMs] hard per-call timeout (default 120000)
 * @property {number} [maxCallsPerHour] sliding-window call budget (default 30)
 * @property {number} [maxPromptBytes] prompt size ceiling (default 65536)
 * @property {Record<string, string | undefined>} [env] parent environment source
 * @property {string} [baseDir] directory for the throwaway per-call workspace
 * @property {Function} [spawnImpl] injectable `child_process.spawn`
 * @property {() => number} [clock]
 * @property {object} [logger] structured logger (never receives prompt text)
 * @property {string[]} [allowedModels] model slugs this deployment may call
 */

/**
 * Create the transport. Every dependency that would make a test non-hermetic
 * (spawn, clock, temp dir) is injectable.
 *
 * @param {CodexCliTransportOptions} [options]
 */
export function createCodexCliTransport(options = {}) {
  const command = typeof options.command === 'string' && options.command.trim() !== ''
    ? options.command.trim()
    : 'codex';
  const timeoutMs = options.timeoutMs ?? 120000;
  const maxCallsPerHour = options.maxCallsPerHour ?? 30;
  const maxPromptBytes = options.maxPromptBytes ?? 65536;
  const envSource = options.env ?? {};
  const baseDir = options.baseDir ?? tmpdir();
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const logger = options.logger ?? silentLogger;
  const allowedModels = Array.isArray(options.allowedModels) ? Object.freeze([...options.allowedModels]) : null;

  if (typeof spawnImpl !== 'function') {
    throw new ConfigError('codex transport requires a spawn implementation', { field: 'spawnImpl' });
  }
  if (!isPositiveInteger(timeoutMs)) {
    throw new ConfigError('codex transport timeoutMs must be a positive integer', { field: 'timeoutMs' });
  }
  if (!isPositiveInteger(maxCallsPerHour)) {
    throw new ConfigError('codex transport maxCallsPerHour must be a positive integer', { field: 'maxCallsPerHour' });
  }
  if (!isPositiveInteger(maxPromptBytes)) {
    throw new ConfigError('codex transport maxPromptBytes must be a positive integer', { field: 'maxPromptBytes' });
  }

  /** @type {number[]} */
  const callTimestamps = [];
  let inFlight = false;
  let calls = 0;

  /** @returns {number} calls still allowed inside the current window */
  function remainingBudget() {
    const nowMs = clock();
    const windowStart = nowMs - 3600000;
    while (callTimestamps.length > 0 && callTimestamps[0] <= windowStart) callTimestamps.shift();
    return Math.max(0, maxCallsPerHour - callTimestamps.length);
  }

  /**
   * Run one non-interactive Codex turn.
   *
   * @param {{
   *   prompt: string,
   *   model: string,
   *   schema?: object | null,
   *   reasoningEffort?: 'low' | 'medium' | 'high' | null,
   *   timeoutMs?: number,
   * }} request
   * @returns {Promise<
   *   | { ok: true, content: string, usage: object | null, durationMs: number }
   *   | { ok: false, reason: string, detail?: string, exitCode?: number | null }
   * >}
   */
  async function complete(request) {
    if (request === null || typeof request !== 'object') {
      return { ok: false, reason: 'INVALID_REQUEST', detail: 'request must be an object' };
    }
    const { prompt, model } = request;
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return { ok: false, reason: 'INVALID_REQUEST', detail: 'prompt must be a non-empty string' };
    }
    if (Buffer.byteLength(prompt, 'utf8') > maxPromptBytes) {
      return { ok: false, reason: 'PROMPT_TOO_LARGE', detail: `prompt exceeds ${maxPromptBytes} bytes` };
    }
    if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
      return { ok: false, reason: 'INVALID_MODEL', detail: 'model must match /^[a-z0-9][a-z0-9._-]{0,63}$/' };
    }
    if (allowedModels !== null && !allowedModels.includes(model)) {
      return { ok: false, reason: 'MODEL_NOT_ALLOWED', detail: `model ${JSON.stringify(model)} is not in the deployment allowlist` };
    }
    const reasoningEffort = request.reasoningEffort ?? null;
    if (reasoningEffort !== null && !CODEX_REASONING_EFFORTS.includes(reasoningEffort)) {
      return { ok: false, reason: 'INVALID_REASONING_EFFORT' };
    }
    if (inFlight) {
      // Fail closed instead of queueing: parallel subscription calls are never
      // an approved capability.
      return { ok: false, reason: 'BUSY', detail: 'another codex call is already in flight' };
    }
    if (remainingBudget() <= 0) {
      return { ok: false, reason: 'BUDGET_EXHAUSTED', detail: `hourly call budget ${maxCallsPerHour} exhausted` };
    }
    const callTimeout = request.timeoutMs ?? timeoutMs;
    if (!isPositiveInteger(callTimeout)) {
      return { ok: false, reason: 'INVALID_REQUEST', detail: 'timeoutMs must be a positive integer' };
    }

    inFlight = true;
    const startedAt = clock();
    let workDir = '';
    try {
      workDir = await mkdtemp(join(baseDir, 'codex-exec-'));
      const argv = [...CODEX_EXEC_BASE_ARGV];
      if (request.schema) {
        const schemaPath = join(workDir, 'schema.json');
        await writeFile(schemaPath, JSON.stringify(request.schema), 'utf8');
        argv.push('--output-schema', schemaPath);
      }
      const lastMessagePath = join(workDir, 'last-message.json');
      argv.push('-o', lastMessagePath);
      argv.push('-m', model);
      if (reasoningEffort !== null) {
        argv.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
      }
      // The prompt is delivered on stdin (`-`), never on the command line.
      argv.push('-');

      callTimestamps.push(clock());
      calls += 1;

      const result = await new Promise((resolve) => {
        /** @type {any} */
        let child;
        let settled = false;
        /** @type {NodeJS.Timeout | undefined} */
        let timer;
        let stdout = '';
        let stderr = '';

        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(value);
        };

        try {
          child = spawnImpl(command, argv, {
            cwd: workDir,
            env: buildCodexChildEnv(envSource),
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (error) {
          finish({ ok: false, reason: 'SPAWN_FAILED', detail: error instanceof Error ? error.message : 'spawn failed' });
          return;
        }

        timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // The child is already gone; the timeout verdict stands either way.
          }
          finish({ ok: false, reason: 'TIMEOUT', detail: `codex exec exceeded ${callTimeout} ms` });
        }, callTimeout);

        child.stdout?.on('data', (chunk) => {
          stdout += String(chunk);
          if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
        });
        child.stderr?.on('data', (chunk) => {
          stderr += String(chunk);
          if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
        });
        child.on('error', (error) => {
          finish({ ok: false, reason: 'SPAWN_FAILED', detail: error instanceof Error ? error.message : 'spawn failed' });
        });
        child.on('close', (code) => {
          finish({ ok: true, code, stdout, stderr });
        });

        try {
          child.stdin?.end(prompt, 'utf8');
        } catch {
          // A closed stdin surfaces through the close/error handlers below.
        }
      });

      if (!result.ok) {
        logger.warn('codex exec failed', { provider: CODEX_PROVIDER_ID, reason: result.reason });
        return { ok: false, reason: result.reason, detail: result.detail };
      }

      const parsed = parseCodexEventStream(result.stdout);
      const durationMs = clock() - startedAt;

      // `-o` writes exactly the final agent message. Prefer it when present: it
      // is the structured answer the CLI itself considers final.
      /** @type {string | null} */
      let content = parsed.content;
      try {
        const fileText = await readFile(lastMessagePath, 'utf8');
        if (fileText.trim() !== '') content = fileText.trim();
      } catch {
        // No last-message file: fall back to the event stream.
      }

      if (parsed.errors.length > 0 && content === null) {
        // A structured error event is far more useful than a stderr tail (which
        // can be dominated by unrelated MCP noise), so it wins when present.
        return {
          ok: false,
          reason: 'CLI_ERROR',
          detail: String(parsed.errors[0]).slice(-400),
          exitCode: typeof result.code === 'number' ? result.code : null,
        };
      }
      if (result.code !== 0 && content === null) {
        return {
          ok: false,
          reason: 'EXIT_NONZERO',
          detail: sanitizeStderr(result.stderr),
          exitCode: typeof result.code === 'number' ? result.code : null,
        };
      }
      if (content === null || content.trim() === '') {
        return {
          ok: false,
          reason: 'NO_MESSAGE',
          detail: parsed.errors[0] ?? sanitizeStderr(result.stderr),
          exitCode: typeof result.code === 'number' ? result.code : null,
        };
      }

      logger.debug('codex exec completed', {
        provider: CODEX_PROVIDER_ID,
        durationMs,
        inputTokens: parsed.usage?.inputTokens ?? null,
        outputTokens: parsed.usage?.outputTokens ?? null,
      });
      return { ok: true, content, usage: parsed.usage, durationMs };
    } finally {
      inFlight = false;
      if (workDir !== '') {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  return Object.freeze({
    complete,
    /** Introspection for tests, health checks and audit records. */
    stats: () =>
      Object.freeze({
        calls,
        inFlight,
        remainingBudget: remainingBudget(),
        maxCallsPerHour,
      }),
  });
}
