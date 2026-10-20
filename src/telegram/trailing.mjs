/**
 * Trailing stop logic (MVP-2).
 *
 * A deterministic, pure module that decides whether to move a protective stop
 * closer to the live price after a favorable move. It is deliberately dumb and
 * side-effect free: it computes a candidate stop and returns the ACTUAL stop to
 * publish, never executing anything.
 *
 * Trailing is LOSS-ONLY-NARROWING: it may only move the stop toward profit,
 * never away from it. This guarantees the module can never silently worsen a
 * position's protection.
 *
 * @module telegram/trailing
 */

/**
 * @typedef {object} TrailInput
 * @property {'LONG' | 'SHORT'} side
 * @property {number} entryPrice the position's average entry
 * @property {number} currentStop the stop currently on the exchange
 * @property {number} markPrice the live mark/last price
 * @property {number} trailDistance distance to keep behind price (same units as price)
 * @property {number} [activationPct] how far price must move in favor before trailing starts (absolute % of entry)
 */

/**
 * Decide the new stop for a position given a live price.
 *
 * LONG:  trail only up,   new stop = markPrice - trailDistance, but never below currentStop.
 * SHORT: trail only down, new stop = markPrice + trailDistance, but never above currentStop.
 *
 * @param {TrailInput} input
 * @returns {{ moved: boolean, stop: number, reason: string }}
 */
export function computeTrailingStop({
  side,
  entryPrice,
  currentStop,
  markPrice,
  trailDistance,
  activationPct = 0,
}) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentStop) || !Number.isFinite(markPrice)) {
    return { moved: false, stop: currentStop, reason: 'non-finite input' };
  }
  if (!Number.isFinite(trailDistance) || trailDistance <= 0) {
    return { moved: false, stop: currentStop, reason: 'trailDistance must be positive' };
  }

  // Activation: do not start trailing until price has moved `activationPct` in favor.
  const travel = side === 'LONG' ? (markPrice - entryPrice) / entryPrice * 100
    : (entryPrice - markPrice) / entryPrice * 100;
  if (travel < activationPct) {
    return { moved: false, stop: currentStop, reason: `activation not reached (moved ${travel.toFixed(2)}%, need ${activationPct}%)` };
  }

  const candidate = side === 'LONG' ? markPrice - trailDistance : markPrice + trailDistance;

  if (side === 'LONG') {
    if (candidate <= currentStop) {
      return { moved: false, stop: currentStop, reason: 'candidate stop is not better than current' };
    }
    return { moved: true, stop: candidate, reason: `trail up to ${candidate}` };
  }
  // SHORT
  if (candidate >= currentStop) {
    return { moved: false, stop: currentStop, reason: 'candidate stop is not better than current' };
  }
  return { moved: true, stop: candidate, reason: `trail down to ${candidate}` };
}

/**
 * Snap a computed trailing stop onto the instrument tick grid using an integer
 * "round toward market" so the exchange never rejects it.
 *
 * For LONG the stop should be snapped DOWN (so it stays below market); for SHORT
 * snapped UP. `tickSize` defaults to 0.01 when absent so the helper is usable
 * without an instrument row.
 *
 * @param {number} price
 * @param {'LONG' | 'SHORT'} side
 * @param {number} [tickSize]
 * @returns {string} exchange-ready price string
 */
export function snapTrailingPrice(price, side, tickSize = 0.01) {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) return String(price);
  const decimals = Math.round(-Math.log10(tickSize));
  const factor = 10 ** Math.max(0, decimals);
  const snapped = side === 'LONG'
    ? Math.floor(price * factor) / factor
    : Math.ceil(price * factor) / factor;
  // Avoid floating noise like 2500.3999999
  return snapped.toFixed(decimals);
}

/**
 * Per-position give-back lock (T-1). Once peak open profit reached armUsd, a
 * retrace of retracePct from the peak closes the position at market.
 *
 * @param {{ pnlUsd: number, peakPnlUsd: number, armUsd?: number, retracePct?: number }} input
 * @returns {{ close: boolean, peak: number, reason: string }}
 */
export function harvestDecision({ pnlUsd, peakPnlUsd, armUsd = 1.5, retracePct = 50 }) {
  const peak = Math.max(Number(peakPnlUsd) || 0, Number(pnlUsd) || 0);
  if (peak < armUsd) {
    return { close: false, peak, reason: 'peak below arm' };
  }
  const threshold = peak * (1 - retracePct / 100);
  if (pnlUsd <= threshold) {
    return { close: true, peak, reason: 'harvest retrace lock' };
  }
  return { close: false, peak, reason: 'retrace not reached' };
}

/**
 * Average True Range (Wilder's RMA smoothing) over a series of candles.
 *
 * Each candle is `[open, high, low, close]` (numbers). Returns the ATR in the
 * candle's price units, or null when there are not enough candles.
 *
 * @param {Array<Array<number>>} candles chronological (oldest first)
 * @param {number} [period] ATR lookback (default 14)
 * @returns {number | null}
 */
export function computeATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const high = Number(cur[1]);
    const low = Number(cur[2]);
    const prevClose = Number(prev[3]);
    if (![high, low, prevClose].every(Number.isFinite)) continue;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trs.length < period) return null;
  // Wilder RMA: seed with the simple mean of the first `period` TRs.
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return Number.isFinite(atr) ? atr : null;
}

/**
 * Build the trail distance from an ATR and a multiplier. This is the
 * volatility-adaptive distance: highly volatile coins get a wider stop, quiet
 * coins a tighter one — instead of a fixed % that ignores the asset.
 *
 * @param {number} atr current ATR (price units)
 * @param {number} multiplier e.g. 2.0
 * @returns {number}
 */
export function trailDistanceFromATR(atr, multiplier = 2.0) {
  if (!Number.isFinite(atr) || atr <= 0) return 0;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 0;
  return atr * multiplier;
}

/**
 * Compute the take-profit to publish when the trend extends, mirroring the
 * trailing stop: for a LONG it sits `distance` ABOVE the live price; for a
 * SHORT, `distance` BELOW. It only ever moves in the favorable direction (LONG
 * raises the TP, never lowers it; SHORT lowers, never raises).
 *
 * @param {object} input
 * @param {'LONG' | 'SHORT'} input.side
 * @param {number} input.markPrice
 * @param {number} input.currentTakeProfit current TP on the exchange (0 if none)
 * @param {number} input.distance ATR-derived distance
 * @returns {{ moved: boolean, takeProfit: number, reason: string }}
 */
export function computeTrailingTakeProfit({ side, markPrice, currentTakeProfit, distance }) {
  if (!Number.isFinite(markPrice) || !Number.isFinite(currentTakeProfit) || currentTakeProfit < 0) {
    return { moved: false, takeProfit: currentTakeProfit, reason: 'non-finite input' };
  }
  if (!Number.isFinite(distance) || distance <= 0) {
    return { moved: false, takeProfit: currentTakeProfit, reason: 'distance must be positive' };
  }
  const candidate = side === 'LONG' ? markPrice + distance : markPrice - distance;

  if (side === 'LONG') {
    // Raise TP only when it moves the exit further into profit.
    if (candidate <= currentTakeProfit) {
      return { moved: false, takeProfit: currentTakeProfit, reason: 'candidate TP is not better than current' };
    }
    return { moved: true, takeProfit: candidate, reason: `raise TP to ${candidate}` };
  }
  // SHORT: lower TP to follow price down.
  if (candidate >= currentTakeProfit) {
    return { moved: false, takeProfit: currentTakeProfit, reason: 'candidate TP is not better than current' };
  }
  return { moved: true, takeProfit: candidate, reason: `lower TP to ${candidate}` };
}
