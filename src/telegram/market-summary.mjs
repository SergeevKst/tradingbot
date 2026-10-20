/**
 * Pure market-summary helpers (MVP-2).
 *
 * Pre-computes the small numeric blocks the deterministic trading layers need:
 * true 24h extremes, a volatility unit, and a trend bias block. Kept pure so it
 * is testable without the network or the app entry point.
 *
 * @module telegram/market-summary
 */

/**
 * Summarize hourly candles into the fields the scout/guard use.
 *
 * @param {Array<{open?: number, high?: number, low?: number, close?: number, volume?: number, o?: number, h?: number, l?: number, c?: number, v?: number}>} candles
 * @returns {{ high24h: number | undefined, low24h: number | undefined, avgRange14h: number | undefined }}
 */
export function summarizeCandles(candles) {
  const rows = Array.isArray(candles) ? candles : [];
  const last24 = rows.slice(-24);
  const highs = last24
    .map((c) => (c && typeof c === 'object' ? (c.high ?? c.h) : undefined))
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  const lows = last24
    .map((c) => (c && typeof c === 'object' ? (c.low ?? c.l) : undefined))
    .filter((v) => typeof v === 'number' && Number.isFinite(v));

  const last14 = rows.slice(-14);
  const ranges = last14
    .map((c) => {
      if (!c || typeof c !== 'object') return NaN;
      const h = typeof c.high === 'number' ? c.high : c.h;
      const l = typeof c.low === 'number' ? c.low : c.l;
      return typeof h === 'number' && typeof l === 'number' && Number.isFinite(h) && Number.isFinite(l)
        ? h - l
        : NaN;
    })
    .filter((v) => Number.isFinite(v));

  const avgRange14h = ranges.length > 0
    ? ranges.reduce((a, b) => a + b, 0) / ranges.length
    : undefined;

  return {
    high24h: highs.length ? Math.max(...highs) : undefined,
    low24h: lows.length ? Math.min(...lows) : undefined,
    avgRange14h,
  };
}

/** Exponential moving average, last value. Returns null when data < period. */
export function emaLast(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return Number.isFinite(ema) ? ema : null;
}

/**
 * Precomputed trend block. bias mirrors the old guard rule 4:
 *   'down' when last < EMA21(1h) OR 4h change <= -1%;
 *   'up'   when last > EMA21(1h) AND 4h change >= +1%;
 *   'flat' otherwise. Returns null when data is insufficient (<22 closes).
 *
 * @param {Array<{c?: number, close?: number}>} candleRows
 * @returns {{ lastPrice: number, ema21h: number, change4hPct: number, bias: 'up'|'down'|'flat' } | null}
 */
/**
 * Compact 4h summary for the scout (S-6).
 *
 * @param {Array<{open?: number, high?: number, low?: number, close?: number, o?: number, h?: number, l?: number, c?: number}>} candles4h
 * @returns {{ bias4h: 'up'|'down'|'flat'|null, swingHigh4h: number|undefined, swingLow4h: number|undefined }}
 */
export function summarize4h(candles4h) {
  const rows = Array.isArray(candles4h) ? candles4h : [];
  const closes = rows
    .map((c) => (c && typeof c === 'object' ? (c.c ?? c.close) : undefined))
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  const highs = rows
    .map((c) => (c && typeof c === 'object' ? (c.h ?? c.high) : undefined))
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  const lows = rows
    .map((c) => (c && typeof c === 'object' ? (c.l ?? c.low) : undefined))
    .filter((v) => typeof v === 'number' && Number.isFinite(v));

  const trend = computeBtcBlock(rows.map((c) => ({ c: c.c ?? c.close })));
  const last7Highs = highs.slice(-7);
  const last7Lows = lows.slice(-7);
  return {
    bias4h: trend?.bias ?? null,
    swingHigh4h: last7Highs.length ? Math.max(...last7Highs) : undefined,
    swingLow4h: last7Lows.length ? Math.min(...last7Lows) : undefined,
  };
}

export function computeBtcBlock(candleRows) {
  const closes = (Array.isArray(candleRows) ? candleRows : [])
    .map((c) => (c && typeof c === 'object' ? (c.c ?? c.close) : undefined))
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (closes.length < 22) return null;
  const ema21h = emaLast(closes, 21);
  const last = closes[closes.length - 1];
  const back4 = closes[closes.length - 5];
  if (ema21h === null || typeof back4 !== 'number' || back4 <= 0) return null;
  const change4hPct = ((last - back4) / back4) * 100;
  let bias = 'flat';
  if (last < ema21h || change4hPct <= -1) bias = 'down';
  else if (last > ema21h && change4hPct >= 1) bias = 'up';
  return { lastPrice: last, ema21h, change4hPct, bias };
}
