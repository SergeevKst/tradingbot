/**
 * Deterministic moving-average crossover strategy — the first, non-AI strategy.
 *
 * LONG when the fast SMA crosses above the slow SMA on the latest candle,
 * SHORT when it crosses below, otherwise `null`. Entry is the side-appropriate
 * top of book; the stop sits one ATR-based distance behind entry and the target
 * is a fixed reward multiple of that distance. No randomness, clock or network.
 *
 * @module strategy/deterministic-ma-crossover
 */
import { defineStrategy, sma } from './strategy-interface.mjs';

export const MA_CROSSOVER_ID = 'deterministic-ma-crossover';

export const MA_CROSSOVER_DEFAULTS = Object.freeze({
  fastPeriod: 3,
  slowPeriod: 6,
  atrPeriod: 5,
  atrStopMultiple: 1.5,
  rewardMultiple: 2,
});

/**
 * @param {{ fastPeriod?: number, slowPeriod?: number, atrPeriod?: number, atrStopMultiple?: number, rewardMultiple?: number, id?: string }} [config]
 */
export function createMaCrossoverStrategy(config = {}) {
  const params = { ...MA_CROSSOVER_DEFAULTS, ...config };
  const id = config.id ?? MA_CROSSOVER_ID;

  return defineStrategy({
    id,
    indicators: { fastPeriod: params.fastPeriod, slowPeriod: params.slowPeriod, atrPeriod: params.atrPeriod },
    evaluate(context) {
      const candles = context?.candles ?? [];
      if (candles.length < params.slowPeriod + 1) return null; // need the previous SMAs too

      const closes = candles.map((candle) => candle.close);
      const fastNow = sma(closes, params.fastPeriod);
      const slowNow = sma(closes, params.slowPeriod);
      const fastPrev = sma(closes.slice(0, -1), params.fastPeriod);
      const slowPrev = sma(closes.slice(0, -1), params.slowPeriod);
      if (![fastNow, slowNow, fastPrev, slowPrev].every(Number.isFinite)) return null;

      const crossedUp = fastPrev <= slowPrev && fastNow > slowNow;
      const crossedDown = fastPrev >= slowPrev && fastNow < slowNow;
      if (!crossedUp && !crossedDown) return null;

      const side = crossedUp ? 'LONG' : 'SHORT';
      const snapshot = context.snapshot ?? {};
      const entryPrice = side === 'LONG' ? snapshot.ask ?? snapshot.lastPrice : snapshot.bid ?? snapshot.lastPrice;
      const atrValue = context.indicators?.atr;
      if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(atrValue) || atrValue <= 0) return null;

      const direction = side === 'LONG' ? 1 : -1;
      const stopDistance = atrValue * params.atrStopMultiple;
      const stopLossPrice = entryPrice - direction * stopDistance;
      const takeProfitPrice = entryPrice + direction * stopDistance * params.rewardMultiple;
      if (stopLossPrice <= 0 || takeProfitPrice <= 0) return null;

      return {
        symbol: context.symbol,
        side,
        entryPrice,
        stopLossPrice,
        takeProfitPrice,
        // Informational only: confidence never changes position size.
        confidence: 0.5,
        strategyId: id,
        timestamp: Number.isFinite(context.timestamp) ? context.timestamp : Date.now(),
      };
    },
  });
}
