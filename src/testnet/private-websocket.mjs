/**
 * Bybit V5 PRIVATE WebSocket client — TESTNET ONLY (MASTER_SPEC Phase 8).
 *
 * The private stream carries authenticated account events (order, execution,
 * position, wallet). It must authenticate before it may subscribe, so this
 * client has a different lifecycle from the public market-data socket: connect
 * -> auth -> subscribe -> live. An authentication failure is terminal — bad
 * credentials are not fixed by reconnecting — and no subscription is ever sent
 * before auth succeeds.
 *
 * The WebSocket constructor, clock and timers are injectable so tests exercise
 * the handshake with a fake socket and no network and no real credentials.
 *
 * @module testnet/private-websocket
 */
import { ConfigurationError, AuthenticationError } from '../errors/taxonomy.mjs';
import { buildWebSocketAuthMessage } from './auth.mjs';
import { resolveTestnetPrivateWsUrl, TESTNET_PRIVATE_WS_URL } from './endpoints.mjs';
import { assertTestnetMode } from './mode-guard.mjs';

/**
 * @param {{
 *   testnet?: boolean,
 *   apiKey?: string,
 *   apiSecret?: string,
 *   url?: string,
 *   WebSocketImpl?: new (url: string) => any,
 *   topics?: string[],
 *   onMessage?: (message: object) => void,
 *   onStatus?: (status: object) => void,
 *   now?: () => number,
 *   pingIntervalMs?: number,
 *   reconnect?: { enabled?: boolean, maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, jitter?: number },
 *   setTimeout?: (handler: () => void, ms: number) => any,
 *   clearTimeout?: (handle: any) => void,
 *   random?: () => number,
 * }} [options]
 * @returns {object}
 * @throws {ConfigurationError}
 */
export function createBybitTestnetPrivateWebSocket(options = {}) {
  assertTestnetMode({
    testnet: options.testnet,
    restBaseUrl: options.restBaseUrl ?? 'https://api-testnet.bybit.com',
    apiKey: options.apiKey,
    apiSecret: options.apiSecret,
  });

  const url = options.url ?? resolveTestnetPrivateWsUrl({ testnet: options.testnet });
  if (url !== TESTNET_PRIVATE_WS_URL) {
    throw new ConfigurationError(`Private WebSocket is TESTNET ONLY; url must be ${TESTNET_PRIVATE_WS_URL}`, {
      details: { field: 'url', value: url },
    });
  }

  const WebSocketImpl = options.WebSocketImpl === undefined ? globalThis.WebSocket : options.WebSocketImpl;
  const onMessage = typeof options.onMessage === 'function' ? options.onMessage : () => {};
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  const now = options.now ?? Date.now;
  const pingIntervalMs = options.pingIntervalMs ?? 20000;
  const setTimeoutImpl = options.setTimeout ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
  const random = options.random ?? Math.random;
  const reconnectOptions = Object.freeze({
    enabled: true,
    maxAttempts: 5,
    baseDelayMs: 500,
    maxDelayMs: 15000,
    jitter: 0.2,
    ...(options.reconnect ?? {}),
  });
  const initialTopics = Object.freeze(Array.isArray(options.topics) ? [...options.topics] : []);

  let socket = null;
  let isSocketOpen = false;
  let isAuthenticated = false;
  let status = 'idle';
  let attempt = 0;
  let stopped = false;
  let authFailed = false;
  let pingTimer = null;
  let reconnectTimer = null;

  /** @param {string} next @param {Record<string, unknown>} [detail] */
  function emitStatus(next, detail = {}) {
    status = next;
    safeCall(onStatus, { status: next, attempt, ...detail });
  }

  /** @param {() => void} fn @param {object} arg */
  function safeCall(fn, arg) {
    try {
      fn(arg);
    } catch {
      // An observer throwing must never take down the feed.
    }
  }

  /** @param {Record<string, unknown>} payload */
  function send(payload) {
    if (socket !== null && isSocketOpen) socket.send(JSON.stringify(payload));
  }

  function startPing() {
    stopPing();
    if (pingIntervalMs <= 0) return;
    pingTimer = setTimeoutImpl(() => {
      send({ op: 'ping' });
      startPing();
    }, pingIntervalMs);
  }

  function stopPing() {
    if (pingTimer !== null) {
      clearTimeoutImpl(pingTimer);
      pingTimer = null;
    }
  }

  /** @param {unknown} event */
  function handleRaw(event) {
    const data = event !== null && typeof event === 'object' && 'data' in /** @type {any} */ (event) ? /** @type {any} */ (event).data : event;
    let parsed = data;
    if (typeof data === 'string') {
      try {
        parsed = JSON.parse(data);
      } catch {
        safeCall(onMessage, { type: 'malformed', raw: data });
        return;
      }
    }
    if (parsed === null || typeof parsed !== 'object') {
      safeCall(onMessage, { type: 'malformed', raw: data });
      return;
    }

    if (parsed.op === 'auth') {
      if (parsed.success === true) {
        isAuthenticated = true;
        emitStatus('authenticated');
        if (initialTopics.length > 0) send({ op: 'subscribe', args: initialTopics });
        startPing();
      } else {
        // A rejected credential is terminal: reconnecting would replay a known
        // bad secret. Fail closed and stop. `authFailed` keeps the close that
        // follows from overwriting the status with a generic 'stopped'.
        isAuthenticated = false;
        stopped = true;
        authFailed = true;
        stopPing();
        emitStatus('auth_failed');
        const current = socket;
        socket = null;
        isSocketOpen = false;
        if (current !== null && typeof current.close === 'function') {
          try {
            current.close();
          } catch {
            // Already closing.
          }
        }
      }
      return;
    }
    if (parsed.op === 'pong' || parsed.op === 'ping') return;
    if (parsed.op === 'subscribe') {
      if (parsed.success === false) safeCall(onMessage, { type: 'error', request: parsed });
      return;
    }
    if (typeof parsed.topic === 'string') {
      safeCall(onMessage, parsed);
      return;
    }
    if (parsed.success === false) safeCall(onMessage, { type: 'error', request: parsed });
  }

  function scheduleReconnect() {
    if (stopped || reconnectOptions.enabled !== true) return;
    if (attempt >= reconnectOptions.maxAttempts) {
      emitStatus('failed');
      return;
    }
    attempt += 1;
    const exponential = reconnectOptions.baseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(reconnectOptions.maxDelayMs, exponential);
    const factor = 1 + (random() * 2 - 1) * reconnectOptions.jitter;
    const delayMs = Math.max(0, Math.round(capped * factor));
    emitStatus('reconnecting', { delayMs });
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  }

  function connect() {
    if (stopped) return;
    if (typeof WebSocketImpl !== 'function') {
      throw new ConfigurationError('Private WebSocket requires a WebSocket implementation', { details: { field: 'WebSocketImpl' } });
    }
    if (socket !== null) return;

    emitStatus('connecting');
    let next;
    try {
      next = new WebSocketImpl(url);
    } catch (error) {
      socket = null;
      emitStatus('error', { error: describe(error) });
      scheduleReconnect();
      return;
    }
    socket = next;

    next.onopen = () => {
      isSocketOpen = true;
      isAuthenticated = false;
      attempt = 0;
      emitStatus('authenticating');
      send(buildWebSocketAuthMessage({ apiKey: options.apiKey, apiSecret: options.apiSecret, now: now() }));
    };
    next.onmessage = (event) => handleRaw(event);
    next.onerror = (event) => emitStatus('error', { error: describe(event) });
    next.onclose = (event) => {
      isSocketOpen = false;
      isAuthenticated = false;
      stopPing();
      if (socket === next) socket = null;
      if (authFailed) return;
      if (stopped) {
        emitStatus('stopped');
        return;
      }
      emitStatus('closed', { code: event && typeof event === 'object' ? event.code ?? null : null });
      scheduleReconnect();
    };
  }

  function close() {
    stopped = true;
    stopPing();
    if (reconnectTimer !== null) {
      clearTimeoutImpl(reconnectTimer);
      reconnectTimer = null;
    }
    const current = socket;
    socket = null;
    isSocketOpen = false;
    isAuthenticated = false;
    if (current !== null && typeof current.close === 'function') {
      try {
        current.close();
      } catch {
        // Closing an already-dead socket is not an error worth surfacing.
      }
    }
    emitStatus('stopped');
  }

  return Object.freeze({
    url,
    topics: initialTopics,
    connect,
    close,
    subscribe(topics) {
      if (!Array.isArray(topics) || topics.length === 0) return;
      // Subscribing before auth would be rejected by the exchange and could
      // leak intent; refuse locally instead.
      if (!isAuthenticated) throw new AuthenticationError('The private stream must authenticate before subscribing', { details: { field: 'authenticated' } });
      send({ op: 'subscribe', args: topics });
    },
    unsubscribe(topics) {
      if (!Array.isArray(topics) || topics.length === 0) return;
      if (!isAuthenticated) return;
      send({ op: 'unsubscribe', args: topics });
    },
    isOpen: () => isSocketOpen,
    isAuthenticated: () => isAuthenticated,
    status: () => status,
    attempts: () => attempt,
  });
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  if (error instanceof Error && error.message !== '') return error.message;
  if (error && typeof error === 'object' && 'message' in /** @type {any} */ (error)) {
    return String(/** @type {any} */ (error).message);
  }
  return 'websocket error';
}
