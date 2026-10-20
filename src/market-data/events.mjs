/**
 * Market-data observability events (MASTER_SPEC §20–21).
 *
 * The market-data layer never writes to disk itself; it emits these structured
 * events to an injectable observer. A journal (or logger) can record them, which
 * keeps the feed observable without coupling market data to storage.
 *
 * @module market-data/events
 */

export const MARKET_DATA_EVENT = Object.freeze({
  CONNECTED: 'MARKET_DATA_CONNECTED',
  DISCONNECTED: 'MARKET_DATA_DISCONNECTED',
  TICK: 'MARKET_DATA_TICK',
  ERROR: 'MARKET_DATA_ERROR',
});

export const MARKET_DATA_EVENT_TYPES = Object.freeze(Object.values(MARKET_DATA_EVENT));
