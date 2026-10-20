/**
 * In-memory market state cache.
 *
 * The single place the current market view lives. It stores validated domain
 * values — a `MarketTick`, an `OrderBookSnapshot`, a normalized trade — keyed by
 * symbol. Every write re-validates through the domain constructor, so bad data
 * can never be stored silently.
 *
 * WebSocket orderbook deltas are merged into the stored snapshot. A delta that
 * is stale (already applied) is ignored idempotently; a delta with a sequence
 * gap, a delta with no snapshot to apply to, or a merge that produces a crossed
 * book reports `needsResync` instead of corrupting the book (MASTER_SPEC §30).
 *
 * @module market-data/market-state-cache
 */
import { createMarketTick } from '../domain/market-tick.mjs';
import { createOrderBookSnapshot } from '../domain/orderbook-snapshot.mjs';
import { DataError } from '../errors/taxonomy.mjs';
import { normalizeBybitTrade } from '../normalizers/bybit-trade.mjs';
import { mergeOrderbookLevels } from '../normalizers/bybit-orderbook.mjs';

/**
 * @typedef {object} MarketStateEntry
 * @property {string} symbol
 * @property {Readonly<import('../domain/market-tick.mjs').MarketTick> | null} tick
 * @property {Readonly<import('../domain/orderbook-snapshot.mjs').OrderBookSnapshot> | null} orderbook
 * @property {Readonly<import('../normalizers/bybit-trade.mjs').BybitTrade> | null} lastTrade
 * @property {number | null} updatedAt epoch milliseconds of the last update
 * @property {boolean} stale true when the entry is older than `staleAfterMs`
 */

/**
 * @param {{
 *   now?: () => number,
 *   staleAfterMs?: number,
 *   maxOrderbookLevels?: number,
 * }} [options]
 * @returns {{
 *   applyTick: (raw: unknown) => Readonly<import('../domain/market-tick.mjs').MarketTick>,
 *   applyOrderbook: (raw: unknown, meta?: { updateId?: number }) => Readonly<import('../domain/orderbook-snapshot.mjs').OrderBookSnapshot>,
 *   applyOrderbookDelta: (delta: object) => Readonly<{ applied: boolean, reason: string | null, needsResync: boolean, symbol: string, snapshot?: object }>,
 *   applyTrade: (raw: unknown) => Readonly<import('../normalizers/bybit-trade.mjs').BybitTrade>,
 *   get: (symbol: string) => Readonly<MarketStateEntry> | null,
 *   isStale: (symbol: string) => boolean,
 *   toRiskMarketState: (symbol: string) => Readonly<{ markPrice: number | null, bestBid: number | null, bestAsk: number | null }>,
 *   symbols: () => string[],
 *   size: () => number,
 *   clear: () => void,
 * }}
 */
export function createMarketStateCache(options = {}) {
  const now = options.now ?? (() => Date.now());
  const staleAfterMs = options.staleAfterMs ?? 30000;
  const maxOrderbookLevels = options.maxOrderbookLevels ?? 200;

  /** @type {Map<string, Readonly<import('../domain/market-tick.mjs').MarketTick>>} */
  const ticks = new Map();
  /** @type {Map<string, Readonly<import('../domain/orderbook-snapshot.mjs').OrderBookSnapshot>>} */
  const books = new Map();
  /** @type {Map<string, number | null>} */
  const bookUpdateIds = new Map();
  /** @type {Map<string, Readonly<import('../normalizers/bybit-trade.mjs').BybitTrade>>} */
  const trades = new Map();
  /** @type {Map<string, number>} */
  const updatedAt = new Map();

  /** @param {string} symbol */
  function touch(symbol) {
    updatedAt.set(symbol, now());
  }

  /** @param {unknown} raw */
  function applyTick(raw) {
    const tick = createMarketTick(raw);
    ticks.set(tick.symbol, tick);
    touch(tick.symbol);
    return tick;
  }

  /**
   * @param {unknown} raw
   * @param {{ updateId?: number }} [meta]
   */
  function applyOrderbook(raw, meta = {}) {
    const snapshot = createOrderBookSnapshot(raw);
    books.set(snapshot.symbol, snapshot);
    bookUpdateIds.set(snapshot.symbol, toUpdateId(meta.updateId));
    touch(snapshot.symbol);
    return snapshot;
  }

  /** @param {object} delta */
  function applyOrderbookDelta(delta) {
    if (delta === null || typeof delta !== 'object') {
      throw new DataError('orderbook delta must be an object', { details: { field: 'orderbook' } });
    }
    const symbol = normalizeKey(/** @type {any} */ (delta).symbol);
    const current = books.get(symbol);
    if (current === undefined) {
      return result(false, 'no-snapshot', true, symbol);
    }

    const previous = bookUpdateIds.get(symbol) ?? null;
    const next = toUpdateId(/** @type {any} */ (delta).updateId);
    if (previous !== null && next !== null) {
      if (next <= previous) return result(false, 'stale', false, symbol);
      if (next > previous + 1) return result(false, 'gap', true, symbol);
    }

    const bids = mergeOrderbookLevels(current.bids, /** @type {any} */ (delta).bids ?? [], 'desc', maxOrderbookLevels);
    const asks = mergeOrderbookLevels(current.asks, /** @type {any} */ (delta).asks ?? [], 'asc', maxOrderbookLevels);

    let snapshot;
    try {
      snapshot = createOrderBookSnapshot({
        symbol,
        bids,
        asks,
        timestamp: /** @type {any} */ (delta).timestamp,
      });
    } catch {
      // A merge that yields a crossed or malformed book means local state has
      // diverged; the caller must resync from a REST snapshot, not keep it.
      return result(false, 'invalid', true, symbol);
    }

    books.set(symbol, snapshot);
    bookUpdateIds.set(symbol, next);
    touch(symbol);
    return Object.freeze({ applied: true, reason: null, needsResync: false, symbol, snapshot });
  }

  /** @param {unknown} raw */
  function applyTrade(raw) {
    const trade = normalizeBybitTrade(raw);
    trades.set(trade.symbol, trade);
    touch(trade.symbol);
    return trade;
  }

  /** @param {string} symbol */
  function get(symbol) {
    const key = normalizeKey(symbol);
    if (!ticks.has(key) && !books.has(key) && !trades.has(key)) return null;
    const timestamp = updatedAt.get(key) ?? null;
    return Object.freeze({
      symbol: key,
      tick: ticks.get(key) ?? null,
      orderbook: books.get(key) ?? null,
      lastTrade: trades.get(key) ?? null,
      updatedAt: timestamp,
      stale: timestamp === null ? true : now() - timestamp > staleAfterMs,
    });
  }

  /** @param {string} symbol */
  function isStale(symbol) {
    const key = normalizeKey(symbol);
    const timestamp = updatedAt.get(key);
    if (timestamp === undefined) return true;
    return now() - timestamp > staleAfterMs;
  }

  /** @param {string} symbol */
  function toRiskMarketState(symbol) {
    const key = normalizeKey(symbol);
    const tick = ticks.get(key) ?? null;
    const book = books.get(key) ?? null;
    const bestBid = book !== null && book.bids.length > 0 ? book.bids[0][0] : tick?.bid ?? null;
    const bestAsk = book !== null && book.asks.length > 0 ? book.asks[0][0] : tick?.ask ?? null;
    return Object.freeze({ markPrice: tick?.price ?? null, bestBid, bestAsk });
  }

  function symbols() {
    return [...new Set([...ticks.keys(), ...books.keys(), ...trades.keys()])].sort();
  }

  function size() {
    return symbols().length;
  }

  function clear() {
    ticks.clear();
    books.clear();
    bookUpdateIds.clear();
    trades.clear();
    updatedAt.clear();
  }

  return Object.freeze({
    applyTick,
    applyOrderbook,
    applyOrderbookDelta,
    applyTrade,
    get,
    isStale,
    toRiskMarketState,
    symbols,
    size,
    clear,
  });
}

/**
 * @param {boolean} applied
 * @param {string | null} reason
 * @param {boolean} needsResync
 * @param {string} symbol
 */
function result(applied, reason, needsResync, symbol) {
  return Object.freeze({ applied, reason, needsResync, symbol });
}

/** @param {unknown} raw */
function toUpdateId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** @param {unknown} symbol */
function normalizeKey(symbol) {
  return String(symbol).trim().toUpperCase();
}
