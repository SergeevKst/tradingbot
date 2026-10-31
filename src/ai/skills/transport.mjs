/**
 * Transport boundary for the data-only Skill runtime (architecture v1.1 §6.1).
 *
 * Two implementations exist:
 *
 *   - `createCompletionTransport({ complete })` — an injected seam. Tests and
 *     offline harnesses supply a function and nothing touches the network.
 *   - `createOpenAICompatibleTransport(...)` — a deliberately narrow
 *     OpenAI-shaped adapter. It validates the endpoint, injects the credential
 *     only inside the request, honours the reviewed settings exactly (no forced
 *     temperature, no dropped token cap) and bounds the response bytes.
 *
 * Neither implementation retries, falls back to another model, or repairs a
 * malformed answer. A provider failure is a per-request failure of the same
 * generation.
 *
 * @module ai/skills/transport
 */
import { ordinaryError, structuralError } from '../../errors/skill-error.mjs';

/** Maximum bytes the runtime will accept from a provider response. */
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * @param {unknown} response
 * @returns {{ status: number, body: string, usage: object | null, latencyMs: number }}
 */
function normalizeResponse(response) {
  if (response === null || typeof response !== 'object') {
    throw ordinaryError('SKILL_PROVIDER_ERROR', 'transport returned no response');
  }
  const value = /** @type {Record<string, unknown>} */ (response);
  if (!Number.isSafeInteger(value.status)) {
    throw ordinaryError('SKILL_PROVIDER_ERROR', 'transport response has no integer status');
  }
  if (typeof value.body !== 'string') {
    throw ordinaryError('SKILL_PROVIDER_ERROR', 'transport response has no string body');
  }
  const usage = value.usage === undefined || value.usage === null
    ? null
    : /** @type {object} */ (value.usage);
  return {
    status: /** @type {number} */ (value.status),
    body: value.body,
    usage,
    latencyMs: Number.isFinite(value.latencyMs) ? /** @type {number} */ (value.latencyMs) : 0,
  };
}

/**
 * Injected transport seam.
 *
 * @param {{ complete: (request: any) => Promise<any>, id?: string }} input
 */
export function createCompletionTransport(input) {
  if (input === null || typeof input !== 'object' || typeof input.complete !== 'function') {
    throw new TypeError('createCompletionTransport requires { complete }');
  }
  return Object.freeze({
    id: input.id ?? 'injected',
    /**
     * @param {{ identity: any, system: string, user: string, settings: any, signal: AbortSignal, maxOutputBytes: number }} request
     */
    async complete(request) {
      const response = await input.complete(request);
      return normalizeResponse(response);
    },
  });
}

/**
 * @param {string} value
 * @param {string} label
 */
function assertHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `${label} is not a valid URL`, { field: label });
  }
  if (url.protocol !== 'https:') {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `${label} must use https`, { field: label });
  }
  if (url.username !== '' || url.password !== '') {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `${label} must not embed credentials`, { field: label });
  }
  if (url.search !== '' || url.hash !== '') {
    throw structuralError('SKILL_CAPABILITY_MISMATCH', `${label} must not carry a query or fragment`, { field: label });
  }
  return url;
}

/**
 * OpenAI-compatible chat-completions transport.
 *
 * @param {{
 *   fetchImpl: typeof fetch,
 *   credentialProvider: (identity: any) => string | null,
 *   allowedHosts: readonly string[],
 *   maxResponseBytes?: number,
 *   clock?: () => number,
 * }} input
 */
export function createOpenAICompatibleTransport(input) {
  if (input === null || typeof input !== 'object' || typeof input.fetchImpl !== 'function') {
    throw new TypeError('createOpenAICompatibleTransport requires { fetchImpl, credentialProvider, allowedHosts }');
  }
  const allowedHosts = [...input.allowedHosts];
  if (allowedHosts.length === 0) {
    throw new TypeError('createOpenAICompatibleTransport requires a non-empty allowedHosts list');
  }
  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const clock = input.clock ?? (() => Date.now());

  return Object.freeze({
    id: 'openai-compatible.v1',
    /**
     * @param {{ identity: any, system: string, user: string, settings: any, signal: AbortSignal, maxOutputBytes: number }} request
     */
    async complete(request) {
      const identity = request.identity;
      const base = assertHttpsUrl(identity.canonicalBaseUrl, 'identity.canonicalBaseUrl');
      if (!allowedHosts.includes(base.hostname)) {
        throw structuralError('SKILL_CAPABILITY_MISMATCH', 'the resolved endpoint host is not allowlisted', {
          field: 'identity.canonicalBaseUrl',
        });
      }
      if (!/\/v1$/.test(base.pathname)) {
        throw structuralError('SKILL_CAPABILITY_MISMATCH', 'the canonical endpoint must end in /v1', {
          field: 'identity.canonicalBaseUrl',
        });
      }
      const credential = input.credentialProvider(identity);
      if (typeof credential !== 'string' || credential === '') {
        throw ordinaryError('SKILL_PROVIDER_ERROR', 'no local credential is available for the resolved provider');
      }
      const settings = request.settings;
      /** @type {Record<string, unknown>} */
      const payload = {
        model: identity.modelId,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        temperature: settings.temperature,
        stream: false,
      };
      if (settings.responseFormat === 'json_object') {
        payload.response_format = { type: 'json_object' };
      }
      if (settings.maxOutputTokens !== null) {
        payload.max_tokens = settings.maxOutputTokens;
      }
      if (settings.reasoningEffort !== null) {
        payload.reasoning_effort = settings.reasoningEffort;
      }
      const endpoint = `${base.origin}/v1/chat/completions`;
      const started = clock();
      let response;
      try {
        response = await input.fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // The credential is injected here only; it never enters a package,
            // a plan, a log line or an error message.
            authorization: `Bearer ${credential}`,
          },
          body: JSON.stringify(payload),
          redirect: 'error',
          signal: request.signal,
        });
      } catch (error) {
        if (/** @type {any} */ (error)?.name === 'AbortError') {
          throw ordinaryError('SKILL_TIMEOUT', 'the provider request was aborted');
        }
        throw ordinaryError('SKILL_PROVIDER_ERROR', 'the provider transport failed');
      }
      const latencyMs = Math.max(0, clock() - started);
      let text;
      try {
        text = await response.text();
      } catch {
        throw ordinaryError('SKILL_PROVIDER_ERROR', 'the provider response body could not be read');
      }
      if (Buffer.byteLength(text, 'utf8') > Math.min(maxResponseBytes, request.maxOutputBytes)) {
        throw ordinaryError('SKILL_RESOURCE_EXCEEDED', 'the provider response exceeded the output byte budget');
      }
      if (!response.ok) {
        throw ordinaryError('SKILL_PROVIDER_ERROR', `the provider answered with status ${response.status}`);
      }
      return Object.freeze({ status: response.status, body: text, usage: null, latencyMs });
    },
  });
}
