/**
 * Phase 8 private (authenticated) WebSocket tests.
 *
 * A fake socket and fake timers replace the network entirely, so the auth
 * handshake, the subscribe-after-auth ordering, order-event routing, the
 * terminal auth failure and reconnect/backoff are all deterministic.
 */
import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { AuthenticationError, ConfigurationError } from '../src/errors/taxonomy.mjs';
import { createBybitTestnetPrivateWebSocket } from '../src/testnet/private-websocket.mjs';
import { TESTNET_PRIVATE_WS_URL } from '../src/testnet/endpoints.mjs';

const API_KEY = 'TESTNET-KEY-abc';
const API_SECRET = 'TESTNET-SECRET-xyz';
const TS = 1_700_000_000_000;

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
    if (typeof this.onmessage === 'function') this.onmessage({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
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
  const client = createBybitTestnetPrivateWebSocket({
    testnet: true,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    WebSocketImpl: FakeWebSocket,
    topics: ['order'],
    now: () => TS,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    random: () => 0.5,
    ...options,
  });
  return { client, timers, messages, statuses, socket: () => FakeWebSocket.instances.at(-1) };
}

test('PRIVATE WS: connect authenticates with a signed frame before subscribing', () => {
  const { client, socket } = makeClient();
  client.connect();
  assert.equal(socket().url, TESTNET_PRIVATE_WS_URL);
  assert.equal(client.status(), 'connecting');

  socket().open();
  assert.equal(client.status(), 'authenticating');

  const auth = JSON.parse(socket().sent[0]);
  assert.equal(auth.op, 'auth');
  assert.equal(auth.args[0], API_KEY);
  assert.equal(auth.args[1], TS + 10000);
  assert.equal(auth.args[2], createHmac('sha256', API_SECRET).update(`GET/realtime${TS + 10000}`).digest('hex'));
  assert.ok(!JSON.stringify(auth).includes(API_SECRET), 'the secret must never be sent');

  assert.equal(socket().sent.some((text) => JSON.parse(text).op === 'subscribe'), false, 'no subscribe before auth success');

  socket().message({ op: 'auth', success: true });
  assert.equal(client.isAuthenticated(), true);
  assert.equal(client.status(), 'authenticated');
  const subscribe = socket().sent.map((text) => JSON.parse(text)).find((payload) => payload.op === 'subscribe');
  assert.deepEqual(subscribe.args, ['order']);
});

test('PRIVATE WS: order events are routed after authentication, control frames ignored', () => {
  const { client, messages, socket } = makeClient();
  client.connect();
  socket().open();
  socket().message({ op: 'auth', success: true });

  socket().message({ topic: 'order', type: 'snapshot', data: [{ orderId: 'o-1' }] });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].topic, 'order');

  socket().message({ op: 'pong' });
  assert.equal(messages.length, 1);

  socket().message('{not-json');
  assert.equal(messages.at(-1).type, 'malformed');
});

test('PRIVATE WS: a rejected auth is terminal and never subscribes', () => {
  const { client, timers, statuses, socket } = makeClient();
  client.connect();
  socket().open();
  socket().message({ op: 'auth', success: false, ret_msg: 'invalid signature' });

  assert.equal(client.status(), 'auth_failed');
  assert.equal(client.isAuthenticated(), false);
  assert.equal(socket().closed, true);
  assert.equal(socket().sent.some((text) => JSON.parse(text).op === 'subscribe'), false);
  assert.equal(timers.pending().length, 0, 'bad credentials must not trigger a reconnect loop');
  assert.ok(statuses.some((entry) => entry.status === 'auth_failed'));
});

test('PRIVATE WS: subscribing before auth is refused locally', () => {
  const { client, socket } = makeClient();
  client.connect();
  socket().open();
  assert.throws(() => client.subscribe(['execution']), AuthenticationError);
});

test('PRIVATE WS: the constructor refuses mainnet, non-testnet and missing credentials', () => {
  const base = { testnet: true, apiKey: API_KEY, apiSecret: API_SECRET, WebSocketImpl: FakeWebSocket };
  assert.throws(() => createBybitTestnetPrivateWebSocket({ ...base, testnet: false }), ConfigurationError);
  assert.throws(() => createBybitTestnetPrivateWebSocket({ ...base, url: 'wss://stream.bybit.com/v5/private' }), ConfigurationError);
  assert.throws(() => createBybitTestnetPrivateWebSocket({ ...base, apiKey: undefined }), ConfigurationError);
  assert.throws(() => createBybitTestnetPrivateWebSocket({ ...base, apiSecret: undefined }), ConfigurationError);
});

test('PRIVATE WS: a dropped socket reconnects with backoff and re-authenticates', () => {
  const { client, timers, socket } = makeClient({ reconnect: { maxAttempts: 1, baseDelayMs: 1000, jitter: 0 } });
  client.connect();
  socket().open();
  socket().message({ op: 'auth', success: true });
  socket().close();

  assert.equal(client.status(), 'reconnecting');
  const reconnectTimer = timers.pending().find((handle) => handle.ms === 1000);
  assert.ok(reconnectTimer, 'a 1000ms reconnect timer must be scheduled');
  reconnectTimer.fn();

  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(client.status(), 'connecting');
  socket().open();
  assert.equal(socket().sent.some((text) => JSON.parse(text).op === 'auth'), true, 'reconnect must re-authenticate');
});

test('PRIVATE WS: close() is terminal and clears timers', () => {
  const { client, timers, socket } = makeClient();
  client.connect();
  socket().open();
  socket().message({ op: 'auth', success: true });
  client.close();
  assert.equal(client.status(), 'stopped');
  assert.equal(socket().closed, true);
  assert.equal(timers.pending().filter((handle) => handle.ms >= 500).length, 0);
});
