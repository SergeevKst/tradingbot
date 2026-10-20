/**
 * Bybit PUBLIC WebSocket client.
 *
 * Connects to a public market stream, subscribes to topics, answers Bybit's
 * ping protocol, and reconnects with bounded exponential backoff. It is
 * transport-only: it validates the envelope shape and hands `{ topic, type,
 * data, ts }` to `onMessage`, where the market-data service normalizes it.
 *
 * The WebSocket constructor is injectable, so tests exercise the connect /
 * subscribe / ping / reconnect logic with a fake socket and fake timers and no
 * network. No credential is read; every stream here is public.
 *
 * @module adapters/bybit/websocket-client
 */
import { ConfigurationError } from '../../errors/taxonomy.mjs';
import { resolvePublicWsUrl } from './endpoints.mjs';

/**
 * @param {{
 *   category?: string,
 *   testnet?: boolean,
 *   url?: string,
 *   WebSocketImpl?: new (url: string) => any,
 *   topics?: string[],
 *   onMessage?: (message: object) => void,
 *   onStatus?: (status: object) => void,
 *   pingIntervalMs?: number,
 *   reconnect?: { enabled?: boolean, maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, jitter?: number },
 *   setTimeout?: (handler: () => void, ms: number) => any,
 *   clearTimeout?: (handle: any) => void,
 *   random?: () => number,
 * }} [options]
 * @returns {{
 *   url: string,
 *   topics: readonly string[],
 *   connect: () => void,
 *   close: () => void,
 *   subscribe: (topics: string[]) => void,
 *   unsubscribe: (topics: string[]) => void,
 *   isOpen: () => boolean,
 *   status: () => string,
 *   attempts: () => number,
 * }}
 */
export function createBybitPublicWebSocket(options = {}) {
  const category = options.category ?? 'linear';
  const url = options.url ?? resolvePublicWsUrl({ category, testnet: options.testnet === true });
  // Only an omitted value falls back to the global; an explicit null must fail
  // closed at connect time.
  const WebSocketImpl = options.WebSocketImpl === undefined ? globalThis.WebSocket : options.WebSocketImpl;
  const onMessage = typeof options.onMessage === 'function' ? options.onMessage : () => {};
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
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
  let status = 'idle';
  let attempt = 0;
  let stopped = false;
  let pingTimer = null;
  let reconnectTimer = null;
  /** Messages sent before the socket is open. */
  const pending = [];

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
    const text = JSON.stringify(payload);
    if (socket !== null && isSocketOpen) {
      socket.send(text);
      return true;
    }
    pending.push(text);
    return false;
  }

  function flush() {
    if (socket === null || !isSocketOpen) return;
    while (pending.length > 0) socket.send(pending.shift());
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
      throw new ConfigurationError('Bybit WebSocket requires a WebSocket implementation', {
        details: { field: 'WebSocketImpl' },
      });
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
      attempt = 0;
      emitStatus('open');
      flush();
      if (initialTopics.length > 0) send({ op: 'subscribe', args: initialTopics });
      startPing();
    };
    next.onmessage = (event) => handleRaw(event);
    next.onerror = (event) => emitStatus('error', { error: describe(event) });
    next.onclose = (event) => {
      isSocketOpen = false;
      stopPing();
      if (socket === next) socket = null;
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
      send({ op: 'subscribe', args: topics });
    },
    unsubscribe(topics) {
      if (!Array.isArray(topics) || topics.length === 0) return;
      send({ op: 'unsubscribe', args: topics });
    },
    isOpen: () => isSocketOpen,
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
