/**
 * Phase 2 WebSocket client tests.
 *
 * A fake socket and fake timers replace the network entirely, so connect,
 * subscribe, ping, message routing and reconnect/backoff are all deterministic.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ConfigurationError } from '../src/errors/taxonomy.mjs';
import { createBybitPublicWebSocket } from '../src/adapters/bybit/websocket-client.mjs';

class FakeWebSocket {
  /** @type {FakeWebSocket[]} */
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  send(text) {
    this.sent.push(text);
  }

  close() {
    this.closed = true;
    if (typeof this.onclose === 'function') this.onclose({ code: 1000 });
  }

  open() {
    if (typeof this.onopen === 'function') this.onopen();
  }

  message(payload) {
    if (typeof this.onmessage === 'function') {
      this.onmessage({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    }
  }

  error(error) {
    if (typeof this.onerror === 'function') this.onerror(error);
  }
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      handle.cleared = true;
    },
    pending: () => timers.filter((handle) => !handle.cleared),
  };
}

function makeClient(options = {}) {
  FakeWebSocket.instances.length = 0;
  const timers = fakeTimers();
  const messages = [];
  const statuses = [];
  const client = createBybitPublicWebSocket({
    WebSocketImpl: FakeWebSocket,
    url: 'wss://stream.bybit.com/v5/public/linear',
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    random: () => 0.5,
    ...options,
  });
  return { client, timers, messages, statuses, socket: () => FakeWebSocket.instances.at(-1) };
}

test('WS: connect subscribes to the configured public topics', () => {
  const { client, socket } = makeClient({ topics: ['tickers.BTCUSDT', 'orderbook.50.BTCUSDT'] });
  client.connect();

  assert.equal(client.status(), 'connecting');
  assert.equal(socket().url, 'wss://stream.bybit.com/v5/public/linear');

  socket().open();
  assert.equal(client.status(), 'open');
  assert.equal(client.isOpen(), true);

  const subscribe = socket().sent.map((text) => JSON.parse(text)).find((payload) => payload.op === 'subscribe');
  assert.deepEqual(subscribe.args, ['tickers.BTCUSDT', 'orderbook.50.BTCUSDT']);
});

test('WS: the ping protocol is driven by a timer', () => {
  const { client, timers, socket } = makeClient({ topics: [], pingIntervalMs: 20000 });
  client.connect();
  socket().open();

  const pingTimer = timers.pending().find((handle) => handle.ms === 20000);
  assert.ok(pingTimer, 'a 20s ping timer must be scheduled');
  pingTimer.fn();

  assert.deepEqual(JSON.parse(socket().sent.at(-1)), { op: 'ping' });
  assert.ok(timers.pending().some((handle) => handle.ms === 20000), 'the next ping must be scheduled');
});

test('WS: messages are parsed and routed, control frames are ignored', () => {
  const { client, messages, socket } = makeClient({ topics: [] });
  client.connect();
  socket().open();

  socket().message({ topic: 'publicTrade.BTCUSDT', type: 'snapshot', data: { s: 'BTCUSDT' } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].topic, 'publicTrade.BTCUSDT');

  socket().message({ op: 'pong' });
  socket().message({ op: 'ping' });
  assert.equal(messages.length, 1, 'control frames must not surface as market data');

  socket().message('{not-json');
  assert.equal(messages.at(-1).type, 'malformed');

  socket().message({ op: 'subscribe', success: false, ret_msg: 'bad topic' });
  assert.equal(messages.at(-1).type, 'error');
});

test('WS: a dropped socket reconnects with backoff', () => {
  const { client, timers, statuses, socket } = makeClient({ topics: [], reconnect: { maxAttempts: 1, baseDelayMs: 1000, jitter: 0 } });
  client.connect();
  socket().open();
  socket().close();

  assert.equal(client.status(), 'reconnecting');
  const reconnectTimer = timers.pending().find((handle) => handle.ms === 1000);
  assert.ok(reconnectTimer, `expected a 1000ms reconnect timer, saw ${timers.pending().map((handle) => handle.ms)}`);

  reconnectTimer.fn();
  assert.equal(client.status(), 'connecting');
  assert.equal(FakeWebSocket.instances.length, 2);

  // The reconnected socket never opens, so the attempt counter is not reset and
  // the cap is reached.
  socket().close();
  assert.equal(client.status(), 'failed', 'the attempt cap must stop reconnecting');
  assert.ok(statuses.some((entry) => entry.status === 'failed'));
});

test('WS: reconnection can be disabled and close() is terminal', () => {
  const { client, socket, timers } = makeClient({ topics: [], reconnect: { enabled: false } });
  client.connect();
  socket().open();
  socket().close();
  assert.equal(client.status(), 'closed');
  assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect when disabled');

  const second = makeClient({ topics: [] });
  second.client.connect();
  second.socket().open();
  second.client.close();
  assert.equal(second.client.status(), 'stopped');
  assert.equal(second.socket().closed, true);
  assert.equal(second.timers.pending().filter((handle) => handle.ms >= 500).length, 0, 'no reconnect timer after close');
});

test('WS: a missing WebSocket implementation is a configuration error', () => {
  const client = createBybitPublicWebSocket({ WebSocketImpl: null, url: 'wss://x' });
  assert.throws(() => client.connect(), ConfigurationError);
});
