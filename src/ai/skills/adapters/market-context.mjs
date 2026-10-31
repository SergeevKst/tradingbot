/**
 * Shared host-snapshot projections for position-scoped operations
 * (GUARD, MONITOR, STOPCHECK).
 *
 * These are trusted, code-owned shapes: only named fields survive, numbers are
 * finite, candle chronology and OHLC geometry are checked, and the model never
 * sees quantity, credentials or account identifiers.
 *
 * @module ai/skills/adapters/market-context
 */
import { arrayField, closed, finiteNumber, inputInvalid, stringField } from './shared.mjs';

export const TREND_BIASES = Object.freeze(['up', 'down', 'flat']);

const CANDLE_KEYS = Object.freeze(['o', 'h', 'l', 'c', 'v']);
const MARKET_KEYS = Object.freeze(['symbol', 'lastPrice', 'bid', 'ask', 'high24h', 'low24h', 'avgRange14h', 'candles']);
const POSITION_KEYS = Object.freeze([
  'symbol',
  'side',
  'avgPrice',
  'markPrice',
  'stopLoss',
  'takeProfit',
  'unrealisedPnl',
  'leverage',
  'kind',
]);
const TREND_KEYS = Object.freeze(['ema21h', 'change4hPct', 'bias']);
const BTC_KEYS = Object.freeze(['lastPrice', 'ema21h', 'change4hPct', 'bias']);

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {ReadonlyArray<Readonly<object>>}
 */
export function shapeCandles(raw, label) {
  const candles = arrayField(raw, label, { max: 30 }).map((entry, index) => {
    const at = `${label}[${index}]`;
    const candle = closed(entry, CANDLE_KEYS, at, inputInvalid);
    const open = finiteNumber(candle.o, `${at}.o`, { min: 0 });
    const high = finiteNumber(candle.h, `${at}.h`, { min: 0 });
    const low = finiteNumber(candle.l, `${at}.l`, { min: 0 });
    const close = finiteNumber(candle.c, `${at}.c`, { min: 0 });
    const volume = finiteNumber(candle.v, `${at}.v`, { min: 0 });
    if (high < low) inputInvalid(`${at}: h must not be below l`, at);
    if (open > high || open < low || close > high || close < low) {
      inputInvalid(`${at}: o/c must lie inside the candle range`, at);
    }
    return Object.freeze({ o: open, h: high, l: low, c: close, v: volume });
  });
  if (candles.length === 0) inputInvalid(`${label} must not be empty`, label);
  return Object.freeze(candles);
}

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {Readonly<object>}
 */
export function shapeMarket(raw, label) {
  const market = closed(raw, MARKET_KEYS, label, inputInvalid);
  return Object.freeze({
    symbol: stringField(market.symbol, `${label}.symbol`, { minLength: 1, maxLength: 40 }),
    lastPrice: finiteNumber(market.lastPrice, `${label}.lastPrice`, { min: 0 }),
    bid: finiteNumber(market.bid, `${label}.bid`, { min: 0, nullable: true }),
    ask: finiteNumber(market.ask, `${label}.ask`, { min: 0, nullable: true }),
    high24h: finiteNumber(market.high24h, `${label}.high24h`, { min: 0, nullable: true }),
    low24h: finiteNumber(market.low24h, `${label}.low24h`, { min: 0, nullable: true }),
    avgRange14h: finiteNumber(market.avgRange14h, `${label}.avgRange14h`, { min: 0, nullable: true }),
    candles: shapeCandles(market.candles, `${label}.candles`),
  });
}

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {Readonly<object>}
 */
export function shapePosition(raw, label) {
  const position = closed(raw, POSITION_KEYS, label, inputInvalid);
  return Object.freeze({
    symbol: stringField(position.symbol, `${label}.symbol`, { minLength: 1, maxLength: 40 }),
    side: stringField(position.side, `${label}.side`, { values: ['LONG', 'SHORT'] }),
    avgPrice: finiteNumber(position.avgPrice, `${label}.avgPrice`, { min: 0 }),
    markPrice: finiteNumber(position.markPrice, `${label}.markPrice`, { min: 0 }),
    stopLoss: finiteNumber(position.stopLoss, `${label}.stopLoss`, { min: 0, nullable: true }),
    takeProfit: finiteNumber(position.takeProfit, `${label}.takeProfit`, { min: 0, nullable: true }),
    unrealisedPnl: finiteNumber(position.unrealisedPnl, `${label}.unrealisedPnl`, {}),
    leverage: finiteNumber(position.leverage, `${label}.leverage`, { min: 0 }),
    kind: stringField(position.kind, `${label}.kind`, { minLength: 1, maxLength: 32 }),
  });
}

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {Readonly<{ ema21h: number, change4hPct: number, bias: string }>}
 */
export function shapeTrend(raw, label) {
  const trend = closed(raw, TREND_KEYS, label, inputInvalid);
  return Object.freeze({
    ema21h: finiteNumber(trend.ema21h, `${label}.ema21h`, { min: 0 }),
    change4hPct: finiteNumber(trend.change4hPct, `${label}.change4hPct`, {}),
    bias: stringField(trend.bias, `${label}.bias`, { values: TREND_BIASES }),
  });
}

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {Readonly<object> | null}
 */
export function shapeBtc(raw, label) {
  if (raw === null) return null;
  const btc = closed(raw, BTC_KEYS, label, inputInvalid);
  return Object.freeze({
    lastPrice: finiteNumber(btc.lastPrice, `${label}.lastPrice`, { min: 0 }),
    ema21h: finiteNumber(btc.ema21h, `${label}.ema21h`, { min: 0 }),
    change4hPct: finiteNumber(btc.change4hPct, `${label}.change4hPct`, {}),
    bias: stringField(btc.bias, `${label}.bias`, { values: TREND_BIASES }),
  });
}

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {string | null}
 */
export function shapeNews(raw, label) {
  if (raw === null) return null;
  return stringField(raw, label, { maxLength: 8192 });
}

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {Readonly<object> | null}
 */
export function shapeSentiment(raw, label) {
  if (raw === null) return null;
  const sentiment = closed(
    raw,
    ['fearGreed', 'fundingRate', 'turnover24hUsd', 'openInterestUsd'],
    label,
    inputInvalid,
  );
  return Object.freeze({
    fearGreed: finiteNumber(sentiment.fearGreed, `${label}.fearGreed`, { min: 0, max: 100, nullable: true }),
    fundingRate: finiteNumber(sentiment.fundingRate, `${label}.fundingRate`, { nullable: true }),
    turnover24hUsd: finiteNumber(sentiment.turnover24hUsd, `${label}.turnover24hUsd`, { min: 0, nullable: true }),
    openInterestUsd: finiteNumber(sentiment.openInterestUsd, `${label}.openInterestUsd`, { min: 0, nullable: true }),
  });
}
