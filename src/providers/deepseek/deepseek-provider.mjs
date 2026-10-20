/**
 * DeepSeek AI provider (MASTER_SPEC §10, §39).
 *
 * An OpenAI-compatible chat-completions client that asks the model for a
 * structured JSON analysis and validates the answer before it becomes a domain
 * `AIAnalysis`. Model and endpoint come from configuration — nothing about
 * DeepSeek leaks into the rest of the application.
 *
 * Safety properties:
 *   - read-only: the only network call is a chat completion. No execution,
 *     account or order module is imported here, so an AI answer cannot reach an
 *     order path;
 *   - the API key is sent only as an Authorization header and never logged or
 *     placed in a prompt;
 *   - transport/auth/rate-limit failures use the §22 taxonomy, so only the
 *     retryable classes are replayed (bounded, with backoff);
 *   - any unusable answer resolves to `ok: false` — NO TRADE (§11).
 *
 * @module providers/deepseek/deepseek-provider
 */
import { ConfigError } from '../../config/config-error.mjs';
import {
  AIProviderError,
  AuthenticationError,
  DataError,
  NetworkError,
  RateLimitError,
  isAppError,
} from '../../errors/index.mjs';
import { retry } from '../../market-data/retry.mjs';
import { silentLogger } from '../../util/logger.mjs';
import { AI_ANALYSIS_SCHEMA_VERSION, AI_STATUS, createAIAnalysisOutcome, defineAIProvider } from '../../ai/ai-provider.mjs';
import { finalizeAnalysis, parseModelResponse, validateAnalysisOutput } from '../../ai/analysis-schema.mjs';
import { PROMPT_VERSION, buildAnalysisPrompt } from '../../ai/prompts.mjs';

export const DEEPSEEK_PROVIDER_ID = 'deepseek';
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';

/**
 * A provider must never send its API key over plaintext. A non-HTTPS base URL
 * is accepted only for a loopback host, which is how local test doubles work.
 *
 * @param {unknown} raw
 * @returns {string} normalized base URL without a trailing slash
 * @throws {ConfigError}
 */
function assertProviderBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError('DeepSeek baseUrl must be a non-empty string', { field: 'baseUrl', value: raw });
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`DeepSeek baseUrl is not a valid URL: ${JSON.stringify(raw)}`, { field: 'baseUrl', value: raw });
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError('DeepSeek baseUrl must use HTTPS (HTTP is allowed only for loopback hosts)', {
      field: 'baseUrl',
      value: raw,
    });
  }
  return raw.replace(/\/+$/, '');
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeTransport(error) {
  if (error && typeof error === 'object' && /** @type {any} */ (error).name === 'AbortError') return 'timeout';
  if (error instanceof Error && error.message !== '') return error.message;
  return 'network failure';
}

/**
 * @param {{
 *   apiKey: string,
 *   model: string,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   retry?: object,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   now?: () => number,
 *   logger?: { info: Function, warn: Function, error: Function, debug: Function },
 * }} options
 * @returns {Readonly<import('../../ai/ai-provider.mjs').AIProvider>}
 */
export function createDeepSeekProvider(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createDeepSeekProvider requires an options object', { field: 'options' });
  }
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
    throw new ConfigError('DeepSeek provider requires a non-empty apiKey', { field: 'apiKey' });
  }
  if (typeof options.model !== 'string' || options.model.trim() === '') {
    throw new ConfigError('DeepSeek provider requires a non-empty model (from configuration)', { field: 'model' });
  }

  const apiKey = options.apiKey;
  const model = options.model.trim();
  const baseUrl = assertProviderBaseUrl(options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL);
  const endpoint = `${baseUrl}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? 20000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError('DeepSeek timeoutMs must be a positive finite number', { field: 'timeoutMs', value: timeoutMs });
  }
  // An omitted fetch falls back to the runtime global; an explicit null must
  // fail closed instead of silently using whatever the runtime provides.
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
  if (typeof fetchImpl !== 'function') {
    throw new ConfigError('DeepSeek provider requires a fetch implementation', { field: 'fetchImpl' });
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const logger = options.logger ?? silentLogger;
  const retryOptions = {
    policy: options.retry,
    sleep: options.sleep,
    random: options.random,
    operationName: 'deepseek.analyze',
    onRetry: (info) =>
      logger.debug('ai provider retrying', {
        provider: DEEPSEEK_PROVIDER_ID,
        attempt: info.attempt,
        delayMs: info.delayMs,
        code: isAppError(info.error) ? info.error.code : 'UNKNOWN',
      }),
  };

  /**
   * One chat-completion attempt. Classifies every failure with the §22 taxonomy.
   *
   * @param {Readonly<import('../../ai/prompts.mjs').AnalysisPrompt>} prompt
   * @returns {Promise<string>} the model's raw content
   */
  async function requestCompletion(prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          temperature: 0,
          stream: false,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new NetworkError(`DeepSeek request failed: ${describeTransport(error)}`, {
        details: { provider: DEEPSEEK_PROVIDER_ID },
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError(`DeepSeek rejected the credentials with HTTP ${response.status}`, {
        details: { provider: DEEPSEEK_PROVIDER_ID, status: response.status },
      });
    }
    if (response.status === 429) {
      throw new RateLimitError('DeepSeek rate limit reached', {
        details: { provider: DEEPSEEK_PROVIDER_ID, status: 429 },
      });
    }
    if (response.status >= 500) {
      throw new AIProviderError(`DeepSeek request failed with HTTP ${response.status}`, {
        details: { provider: DEEPSEEK_PROVIDER_ID, status: response.status },
      });
    }
    if (!response.ok) {
      throw new DataError(`DeepSeek rejected the request with HTTP ${response.status}`, {
        details: { provider: DEEPSEEK_PROVIDER_ID, status: response.status },
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new AIProviderError('DeepSeek returned malformed JSON', {
        details: { provider: DEEPSEEK_PROVIDER_ID },
        cause: error,
      });
    }

    const errorCode = payload && typeof payload === 'object' ? /** @type {any} */ (payload).error?.code : undefined;
    if (errorCode !== undefined) {
      throw new AIProviderError(`DeepSeek returned an error payload (code ${errorCode})`, {
        details: { provider: DEEPSEEK_PROVIDER_ID, code: errorCode },
      });
    }

    const content = payload && typeof payload === 'object' ? /** @type {any} */ (payload).choices?.[0]?.message?.content : undefined;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new AIProviderError('DeepSeek returned no message content', {
        details: { provider: DEEPSEEK_PROVIDER_ID },
      });
    }
    return content;
  }

  /**
   * @param {object} context output of `buildAIContext`
   * @returns {Promise<Readonly<import('../../ai/ai-provider.mjs').AIAnalysisOutcome>>}
   */
  async function analyze(context) {
    // A malformed context is a programming error and must throw, not be
    // reported as a model failure.
    const prompt = buildAnalysisPrompt(context);

    /** @type {string} */
    let content;
    try {
      content = await retry(() => requestCompletion(prompt), retryOptions);
    } catch (error) {
      const code = isAppError(error) ? error.code : 'AI_PROVIDER_ERROR';
      logger.warn('ai provider request failed', { provider: DEEPSEEK_PROVIDER_ID, code });
      return createAIAnalysisOutcome({
        status: AI_STATUS.PROVIDER_ERROR,
        issues: [code],
        modelId: model,
        promptVersion: prompt.version,
        receivedAt: now(),
      });
    }

    const parsed = parseModelResponse(content);
    if (!parsed.ok) {
      return createAIAnalysisOutcome({
        status: AI_STATUS.INVALID_OUTPUT,
        issues: parsed.issues,
        modelId: model,
        promptVersion: prompt.version,
        receivedAt: now(),
      });
    }

    const validated = validateAnalysisOutput(parsed.value);
    if (!validated.valid) {
      return createAIAnalysisOutcome({
        status: AI_STATUS.INVALID_OUTPUT,
        issues: validated.issues,
        modelId: model,
        promptVersion: prompt.version,
        receivedAt: now(),
      });
    }

    try {
      const symbol = /** @type {any} */ (context).market?.symbol;
      const analysis = finalizeAnalysis(validated.value, {
        symbol,
        modelId: model,
        generatedAt: now(),
        schemaVersion: AI_ANALYSIS_SCHEMA_VERSION,
      });
      return createAIAnalysisOutcome({
        status: AI_STATUS.OK,
        analysis,
        modelId: model,
        promptVersion: prompt.version,
        receivedAt: analysis.generatedAt,
      });
    } catch (error) {
      return createAIAnalysisOutcome({
        status: AI_STATUS.INVALID_OUTPUT,
        issues: [error instanceof Error ? error.message : 'analysis could not be finalized'],
        modelId: model,
        promptVersion: prompt.version,
        receivedAt: now(),
      });
    }
  }

  return defineAIProvider({ id: DEEPSEEK_PROVIDER_ID, modelId: model, promptVersion: PROMPT_VERSION, analyze });
}
