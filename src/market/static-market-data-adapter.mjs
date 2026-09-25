/**
 * Static market data adapter — for tests and offline simulation.
 *
 * Holds a fixed instrument definition and a fixed book, so paper fills are
 * perfectly reproducible. It is the default adapter for tests and performs no
 * network access whatsoever.
 *
 * @module market/static-market-data-adapter
 */
import { ConfigError } from '../config/config-error.mjs';
import { normalizeInstrumentInfo } from './instrument-info.mjs';
import { createMarketSnapshot, normalizeCandle } from './market-snapshot.mjs';

/**
 * Build a static adapter.
 *
 * @param {{
 *   instrument: object,
 *   ticker?: { lastPrice?: number | null, markPrice?: number | null, bid?: number | null, ask?: number | null, volume?: number | null },
 *   candles?: object[],
 *   interval?: string,
 * }} options
 * @returns {import('./market-data-adapter.mjs').MarketDataAdapter}
 */
export function createStaticMarketDataAdapter(options) {
  if (options === null || typeof options !== 'object' || !options.instrument) {
    throw new ConfigError('createStaticMarketDataAdapter requires an `instrument` definition');
  }

  const instrument = normalizeInstrumentInfo(options.instrument);
  const ticker = {
    lastPrice: options.ticker?.lastPrice ?? null,
    markPrice: options.ticker?.markPrice ?? null,
    bid: options.ticker?.bid ?? null,
    ask: options.ticker?.ask ?? null,
    volume: options.ticker?.volume ?? null,
  };
  const candles = Object.freeze((options.candles ?? []).map(normalizeCandle));
  const interval = options.interval ?? '15';

  /** Mutable book so a test can simulate a price move between observations. */
  let currentTicker = { ...ticker };

  return Object.freeze({
    kind: () => 'static',

    async getInstrumentInfo(symbol) {
      assertSymbol(symbol, instrument.symbol);
      return instrument;
    },

    async getTicker(symbol) {
      assertSymbol(symbol, instrument.symbol);
      return { ...currentTicker };
    },

    async getOrderbook(symbol) {
      assertSymbol(symbol, instrument.symbol);
      return {
        bid: currentTicker.bid,
        ask: currentTicker.ask,
        bids: currentTicker.bid === null ? [] : [[currentTicker.bid, 1]],
        asks: currentTicker.ask === null ? [] : [[currentTicker.ask, 1]],
      };
    },

    async getCandles(symbol) {
      assertSymbol(symbol, instrument.symbol);
      return candles;
    },

    async getSnapshot(symbol) {
      assertSymbol(symbol, instrument.symbol);
      return createMarketSnapshot({
        symbol,
        lastPrice: currentTicker.lastPrice,
        markPrice: currentTicker.markPrice,
        bid: currentTicker.bid,
        ask: currentTicker.ask,
        volume: currentTicker.volume,
        candleTimeframe: candles.length > 0 ? interval : null,
        candles,
        instrument,
      });
    },

    /** Test helper: move the simulated market. Not part of the adapter contract. */
    setTicker(next) {
      currentTicker = { ...currentTicker, ...next };
    },
  });
}

/**
 * @param {unknown} symbol
 * @param {string} expected
 */
function assertSymbol(symbol, expected) {
  if (String(symbol).trim().toUpperCase() !== expected) {
    throw new ConfigError(`Static adapter only knows ${expected}, got ${JSON.stringify(symbol)}`, {
      field: 'symbol',
      value: symbol,
    });
  }
}