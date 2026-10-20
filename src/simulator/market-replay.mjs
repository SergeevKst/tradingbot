/**
 * Market replay — turn historical OHLCV bars into deterministic market
 * snapshots the existing paper executor can consume unchanged.
 *
 * This is the "Historical Data -> Market Data Interface" seam of the backtest
 * pipeline (MASTER_SPEC §27). It fabricates nothing about price history: it
 * takes a bar that already exists and presents it as a point-in-time book.
 *
 * Bar semantics (deliberately explicit)
 * -------------------------------------
 * A bar gives four prices and hides the path between them. The replay never
 * pretends to know that path. It exposes three views per bar:
 *
 *   close  reference = close  — used to mark positions and to route entries;
 *   low    reference = low    — used to test the DOWNWARD extreme first;
 *   high   reference = high   — used to test the UPWARD extreme first.
 *
 * The backtest engine feeds `low` then `high` for a LONG and `high` then `low`
 * for a SHORT, so the adverse extreme is always considered first. Combined with
 * the paper executor's own stop-first ambiguity rule, an unknowable intrabar
 * path is resolved conservatively rather than optimistically.
 *
 * Bid/ask are centred on the chosen reference with a configurable spread and an
 * additional slippage model, so every simulated fill already includes its cost.
 *
 * @module simulator/market-replay
 */
import { ConfigError } from '../config/config-error.mjs';
import { normalizeInstrumentInfo } from '../market/instrument-info.mjs';
import { createMarketSnapshot } from '../market/market-snapshot.mjs';
import { assertSlippageModel, createZeroSlippageModel } from '../backtest/slippage-model.mjs';

/** Bar intervals accepted by the snapshot type, matching Bybit's interval codes. */
export const REPLAY_INTERVALS = Object.freeze(['1', '3', '5', '15', '30', '60', '120', '240', '360', '720', 'D', 'W', 'M']);

/**
 * Build the executable book for one reference price.
 *
 * @param {{ referencePrice: number, spreadBps: number, slippageModel: import('../backtest/slippage-model.mjs').SlippageModel }} input
 * @returns {{ bid: number, ask: number }}
 */
export function createExecutableBook(input) {
  const { referencePrice, spreadBps, slippageModel } = input;
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    throw new ConfigError(`Market replay requires a positive reference price, got ${JSON.stringify(referencePrice)}`);
  }
  if (!Number.isFinite(spreadBps) || spreadBps < 0) {
    throw new ConfigError(`spreadBps must be a finite number >= 0, got ${JSON.stringify(spreadBps)}`, {
      field: 'spreadBps',
      value: spreadBps,
    });
  }

  const halfSpread = (referencePrice * spreadBps) / 2 / 10_000;
  const raw = { bid: referencePrice - halfSpread, ask: referencePrice + halfSpread };
  const adjusted = slippageModel.adjustBook({ mid: referencePrice, bid: raw.bid, ask: raw.ask });

  const bid = Number.isFinite(adjusted?.bid) && adjusted.bid > 0 ? adjusted.bid : referencePrice * 1e-9;
  const ask = Number.isFinite(adjusted?.ask) && adjusted.ask > 0 ? adjusted.ask : referencePrice;
  // A crossed book is corrupt data; the snapshot type refuses it too.
  if (ask < bid) {
    throw new ConfigError(`Market replay produced a crossed book: bid ${bid} > ask ${ask}`);
  }
  return { bid, ask };
}

/**
 * Build one normalized snapshot from a bar and a chosen reference price.
 *
 * @param {{
 *   candle: import('../market/market-snapshot.mjs').Candle,
 *   symbol: string,
 *   instrument: object,
 *   referencePrice: number,
 *   candles?: readonly import('../market/market-snapshot.mjs').Candle[],
 *   interval?: string,
 *   spreadBps?: number,
 *   slippageModel?: import('../backtest/slippage-model.mjs').SlippageModel,
 * }} options
 * @returns {Readonly<import('../market/market-snapshot.mjs').MarketSnapshot>}
 */
export function createBarSnapshot(options) {
  const {
    candle,
    symbol,
    instrument,
    referencePrice,
    candles = [],
    interval = '15',
    spreadBps = 1,
    slippageModel = createZeroSlippageModel(),
  } = options;

  if (candle === null || typeof candle !== 'object') {
    throw new ConfigError('createBarSnapshot requires a candle');
  }
  if (!REPLAY_INTERVALS.includes(interval)) {
    throw new ConfigError(`interval must be one of: ${REPLAY_INTERVALS.join(', ')} — got ${JSON.stringify(interval)}`);
  }

  const normalizedInstrument = normalizeInstrumentInfo(instrument);
  const { bid, ask } = createExecutableBook({ referencePrice, spreadBps, slippageModel });

  return createMarketSnapshot({
    symbol,
    timestamp: new Date(candle.startTime).toISOString(),
    lastPrice: referencePrice,
    markPrice: referencePrice,
    bid,
    ask,
    volume: candle.volume,
    candleTimeframe: interval,
    candles,
    instrument: normalizedInstrument,
  });
}

/**
 * Bind the replay to one symbol/instrument/cost profile.
 *
 * @param {{
 *   symbol: string,
 *   instrument: object,
 *   interval?: string,
 *   spreadBps?: number,
 *   slippageModel?: import('../backtest/slippage-model.mjs').SlippageModel,
 * }} options
 */
export function createMarketReplay(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createMarketReplay requires options');
  }
  if (typeof options.symbol !== 'string' || options.symbol.trim() === '') {
    throw new ConfigError('createMarketReplay requires a symbol');
  }
  const symbol = options.symbol.trim().toUpperCase();
  const instrument = normalizeInstrumentInfo(options.instrument);
  const interval = options.interval ?? '15';
  const spreadBps = options.spreadBps ?? 1;
  const slippageModel = assertSlippageModel(options.slippageModel ?? createZeroSlippageModel());

  /**
   * @param {import('../market/market-snapshot.mjs').Candle} candle
   * @param {number} referencePrice
   * @param {readonly import('../market/market-snapshot.mjs').Candle[]} [window]
   */
  function snapshot(candle, referencePrice, window = []) {
    return createBarSnapshot({
      candle,
      symbol,
      instrument,
      referencePrice,
      candles: window,
      interval,
      spreadBps,
      slippageModel,
    });
  }

  return Object.freeze({
    symbol,
    instrument,
    interval,
    spreadBps,
    slippageModel,
    /** Close-price view: marking and entry routing. */
    close: (candle, window) => snapshot(candle, candle.close, window),
    /** The bar's adverse extreme, chosen by the caller. */
    extreme: (candle, which, window) => {
      if (which !== 'low' && which !== 'high') {
        throw new ConfigError(`replay.extreme requires 'low' or 'high', got ${JSON.stringify(which)}`);
      }
      return snapshot(candle, candle[which], window);
    },
  });
}
