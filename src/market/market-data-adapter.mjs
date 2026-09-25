/**
 * Market data adapter interface (port).
 *
 * The contract the trading core depends on. Implementations may talk to Bybit
 * over REST, to a recorded fixture, or to a static map — the core cannot tell
 * the difference, which is what keeps exchange specifics out of the core.
 *
 * Public by design: market data needs no credentials, so no implementation of
 * this port ever receives an API key (see `rest-market-data-adapter.mjs`).
 *
 * @module market/market-data-adapter
 */

/**
 * @typedef {import('./market-snapshot.mjs').MarketSnapshot} MarketSnapshot
 * @typedef {import('./instrument-info.mjs').InstrumentInfo} InstrumentInfo
 */

/**
 * @typedef {object} TickerData
 * @property {number | null} lastPrice
 * @property {number | null} markPrice
 * @property {number | null} bid
 * @property {number | null} ask
 * @property {number | null} volume
 */

/**
 * @typedef {object} OrderbookData
 * @property {number | null} bid
 * @property {number | null} ask
 * @property {Array<[number, number]>} bids
 * @property {Array<[number, number]>} asks
 */

/**
 * @typedef {object} MarketDataAdapter
 * @property {() => string} kind identifies the adapter, e.g. "static" / "rest"
 * @property {(symbol: string) => Promise<InstrumentInfo>} getInstrumentInfo
 * @property {(symbol: string) => Promise<TickerData>} getTicker
 * @property {(symbol: string, limit?: number) => Promise<OrderbookData>} getOrderbook
 * @property {(symbol: string, interval?: string, limit?: number) => Promise<import('./market-snapshot.mjs').Candle[]>} getCandles
 * @property {(symbol: string, options?: object) => Promise<MarketSnapshot>} getSnapshot
 */

/**
 * Validate that an object satisfies the adapter contract.
 *
 * A fake adapter that is missing a method would otherwise fail much later, deep
 * inside a paper fill; this fails at construction instead.
 *
 * @param {unknown} adapter
 * @returns {MarketDataAdapter}
 * @throws {Error} when the contract is not satisfied
 */
export function assertMarketDataAdapter(adapter) {
  const required = ['getInstrumentInfo', 'getTicker', 'getOrderbook', 'getCandles', 'getSnapshot', 'kind'];

  if (adapter === null || typeof adapter !== 'object') {
    throw new Error('MarketDataAdapter must be an object');
  }
  for (const method of required) {
    if (method === 'kind') {
      if (typeof adapter.kind !== 'function') throw new Error('MarketDataAdapter.kind() is required');
      continue;
    }
    if (typeof /** @type {any} */ (adapter)[method] !== 'function') {
      throw new Error(`MarketDataAdapter.${method}() is required`);
    }
  }
  return /** @type {MarketDataAdapter} */ (adapter);
}