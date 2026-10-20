/**
 * Market-data service.
 *
 * Wires a public market-data adapter and an optional public WebSocket feed into
 * the in-memory market state cache. It is the boundary between "Bybit sent
 * something" and "the core has a validated market view":
 *
 *   - every inbound message is normalized to a domain type before it is stored;
 *   - a malformed message is refused and recorded, never stored;
 *   - an orderbook sequence gap triggers a REST resync instead of a corrupt book;
 *   - lifecycle changes and bad data are emitted to an injectable observer,
 *     which may be the append-only journal.
 *
 * No credentials, no account data and no order path exist here.
 *
 * @module market-data/market-data-service
 */
import { ConfigurationError, isAppError } from '../errors/index.mjs';
import { normalizeBybitOrderbookDelta, normalizeBybitOrderbookSnapshot } from '../normalizers/bybit-orderbook.mjs';
import { normalizeBybitTicker } from '../normalizers/bybit-ticker.mjs';
import { normalizeBybitTrade } from '../normalizers/bybit-trade.mjs';
import { createJournalEvent } from '../state/journal.mjs';
import { silentLogger } from '../util/logger.mjs';
import { orderbookTopic, parsePublicTopic, tickerTopic, tradeTopic } from '../adapters/bybit/endpoints.mjs';
import { MARKET_DATA_EVENT } from './events.mjs';

/**
 * @param {{
 *   adapter?: object | null,
 *   cache: ReturnType<import('./market-state-cache.mjs').createMarketStateCache>,
 *   symbols?: string[],
 *   observer?: { record: (event: object) => Promise<void> | void } | null,
 *   logger?: { info: Function, warn: Function, error: Function, debug: Function },
 *   wsFactory?: ((handlers: { onMessage: (message: object) => void, onStatus: (status: object) => void }) => { connect?: Function, close?: Function }) | null,
 *   orderbookDepth?: number,
 *   primeOnStart?: boolean,
 *   include?: { ticker?: boolean, orderbook?: boolean, trade?: boolean },
 *   now?: () => number,
 * }} options
 */
export function createMarketDataService(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigurationError('createMarketDataService requires an options object', { details: { field: 'options' } });
  }
  if (options.cache === null || typeof options.cache !== 'object') {
    throw new ConfigurationError('createMarketDataService requires a cache', { details: { field: 'cache' } });
  }

  const adapter = options.adapter ?? null;
  const cache = options.cache;
  const observer = options.observer ?? null;
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => Date.now());
  const orderbookDepth = options.orderbookDepth ?? 50;
  const primeOnStart = options.primeOnStart !== false;
  const include = Object.freeze({ ticker: true, orderbook: true, trade: true, ...(options.include ?? {}) });
  const symbols = Object.freeze(
    (Array.isArray(options.symbols) ? options.symbols : [])
      .map((symbol) => String(symbol).trim().toUpperCase())
      .filter((symbol) => symbol !== ''),
  );
  const wsFactory = typeof options.wsFactory === 'function' ? options.wsFactory : null;

  const stats = { messages: 0, ticks: 0, orderbooks: 0, trades: 0, invalid: 0, resyncs: 0 };
  /** In-flight observer writes, so a caller can wait for the audit trail. */
  const pendingObservers = new Set();
  let ws = null;
  let started = false;

  /**
   * @param {string} eventType
   * @param {Record<string, unknown>} [fields]
   */
  function emit(eventType, fields = {}) {
    if (observer === null || typeof observer.record !== 'function') return;
    try {
      const record = observer.record(createJournalEvent({ eventType, ...fields }));
      if (record && typeof record.then === 'function') {
        const tracked = Promise.resolve(record).catch((error) =>
          logger.warn('market data observer rejected event', { eventType, reason: describe(error) }),
        );
        pendingObservers.add(tracked);
        tracked.finally(() => pendingObservers.delete(tracked));
      }
    } catch (error) {
      logger.warn('market data observer rejected event', { eventType, reason: describe(error) });
    }
  }

  /** @param {object} message */
  function ingestWsMessage(message) {
    if (message === null || typeof message !== 'object') {
      stats.invalid += 1;
      return Object.freeze({ kind: null, applied: false });
    }
    if (/** @type {any} */ (message).type === 'malformed') {
      stats.invalid += 1;
      emit(MARKET_DATA_EVENT.ERROR, { reason: 'malformed-message' });
      return Object.freeze({ kind: null, applied: false });
    }
    if (/** @type {any} */ (message).type === 'error') {
      stats.invalid += 1;
      emit(MARKET_DATA_EVENT.ERROR, { reason: 'stream-error' });
      return Object.freeze({ kind: null, applied: false });
    }

    const topic = parsePublicTopic(/** @type {any} */ (message).topic);
    if (topic === null || /** @type {any} */ (message).data === undefined) {
      return Object.freeze({ kind: null, applied: false });
    }
    stats.messages += 1;
    const timestamp = now();

    try {
      if (topic.kind === 'ticker') {
        const tick = normalizeBybitTicker(/** @type {any} */ (message).data, { timestamp });
        cache.applyTick(tick);
        stats.ticks += 1;
        emit(MARKET_DATA_EVENT.TICK, {
          symbol: tick.symbol,
          price: tick.price,
          timestamp: new Date(tick.timestamp).toISOString(),
          reason: 'ticker',
        });
        return Object.freeze({ kind: 'ticker', applied: true, symbol: tick.symbol });
      }

      if (topic.kind === 'trade') {
        const trade = normalizeBybitTrade(/** @type {any} */ (message).data);
        cache.applyTrade(trade);
        stats.trades += 1;
        return Object.freeze({ kind: 'trade', applied: true, symbol: trade.symbol });
      }

      // orderbook
      const isDelta = /** @type {any} */ (message).type === 'delta' || /** @type {any} */ (message).data?.type === 'delta';
      if (isDelta) {
        const delta = normalizeBybitOrderbookDelta(/** @type {any} */ (message).data, { timestamp });
        const outcome = cache.applyOrderbookDelta(delta);
        if (outcome.needsResync) {
          stats.resyncs += 1;
          emit(MARKET_DATA_EVENT.ERROR, { symbol: delta.symbol, reason: `orderbook-${outcome.reason}` });
          void resync(delta.symbol);
        }
        return Object.freeze({ kind: 'orderbook', applied: outcome.applied, symbol: delta.symbol, needsResync: outcome.needsResync });
      }

      const snapshot = normalizeBybitOrderbookSnapshot(/** @type {any} */ (message).data, { timestamp });
      cache.applyOrderbook(snapshot, { updateId: Number(/** @type {any} */ (message).data?.u) });
      stats.orderbooks += 1;
      return Object.freeze({ kind: 'orderbook', applied: true, symbol: snapshot.symbol });
    } catch (error) {
      stats.invalid += 1;
      emit(MARKET_DATA_EVENT.ERROR, { symbol: topic.symbol, reason: describe(error) });
      logger.warn('market data message rejected', { symbol: topic.symbol, reason: describe(error) });
      return Object.freeze({ kind: topic.kind, applied: false, symbol: topic.symbol });
    }
  }

  /**
   * Pull a fresh REST orderbook after a gap or divergence.
   *
   * @param {string} symbol
   * @returns {Promise<object | null>}
   */
  async function resync(symbol) {
    if (adapter === null || typeof adapter.getOrderbook !== 'function') return null;
    try {
      const snapshot = await adapter.getOrderbook(symbol, orderbookDepth);
      cache.applyOrderbook(snapshot);
      stats.resyncs += 1;
      return snapshot;
    } catch (error) {
      emit(MARKET_DATA_EVENT.ERROR, { symbol, reason: 'resync-failed' });
      logger.warn('market data resync failed', { symbol, reason: describe(error) });
      return null;
    }
  }

  /** @param {object} update */
  function handleStatus(update) {
    const status = update && typeof update === 'object' ? /** @type {any} */ (update).status : undefined;
    if (status === 'open') emit(MARKET_DATA_EVENT.CONNECTED, { reason: 'stream-open' });
    else if (status === 'error') emit(MARKET_DATA_EVENT.ERROR, { reason: 'stream-error' });
    else if (status === 'failed') {
      emit(MARKET_DATA_EVENT.ERROR, { reason: 'reconnect-exhausted' });
      emit(MARKET_DATA_EVENT.DISCONNECTED, { reason: 'reconnect-exhausted' });
    } else if (status === 'closed' || status === 'stopped') {
      emit(MARKET_DATA_EVENT.DISCONNECTED, { reason: `stream-${status}` });
    } else if (status === 'reconnecting') {
      logger.warn('market data stream reconnecting', { attempt: /** @type {any} */ (update).attempt });
    }
  }

  /** The public topics this service subscribes to for its configured symbols. */
  function topics() {
    /** @type {string[]} */
    const list = [];
    for (const symbol of symbols) {
      if (include.ticker) list.push(tickerTopic(symbol));
      if (include.orderbook) list.push(orderbookTopic(symbol, orderbookDepth));
      if (include.trade) list.push(tradeTopic(symbol));
    }
    return Object.freeze(list);
  }

  /**
   * @returns {Promise<{ primed: string[], failed: string[] }>}
   */
  async function start() {
    if (started) return { primed: [], failed: [] };
    started = true;

    const primed = [];
    const failed = [];
    if (primeOnStart && adapter !== null) {
      for (const symbol of symbols) {
        try {
          const [tick, orderbook] = await Promise.all([
            adapter.getTicker(symbol),
            adapter.getOrderbook(symbol, orderbookDepth),
          ]);
          cache.applyTick(tick);
          cache.applyOrderbook(orderbook);
          primed.push(symbol);
        } catch (error) {
          failed.push(symbol);
          emit(MARKET_DATA_EVENT.ERROR, { symbol, reason: describe(error) });
          logger.warn('market data prime failed', { symbol, reason: describe(error) });
        }
      }
    }

    if (wsFactory !== null) {
      ws = wsFactory({ onMessage: ingestWsMessage, onStatus: handleStatus });
      if (ws && typeof ws.connect === 'function') {
        try {
          ws.connect();
        } catch (error) {
          emit(MARKET_DATA_EVENT.ERROR, { reason: describe(error) });
        }
      }
    }

    return { primed, failed };
  }

  function stop() {
    started = false;
    if (ws !== null && typeof ws.close === 'function') {
      try {
        ws.close();
      } catch {
        // Closing an already-closed feed is not worth surfacing.
      }
    }
    ws = null;
  }

  /** Wait for every in-flight observer write (e.g. before reading the journal). */
  async function flush() {
    await Promise.all([...pendingObservers]);
  }

  return Object.freeze({
    start,
    stop,
    ingestWsMessage,
    resync,
    topics,
    flush,
    getMarketState: (symbol) => cache.get(symbol),
    getRiskMarketState: (symbol) => cache.toRiskMarketState(symbol),
    stats: () => Object.freeze({ ...stats }),
    isStarted: () => started,
  });
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  if (isAppError(error)) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
