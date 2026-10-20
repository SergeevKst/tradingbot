/**
 * Position sizing for the Telegram pipeline (Phase 5).
 *
 * Bridges the domain Risk Engine (`evaluateTrade`) with the live Telegram
 * context: it builds the strict `TradeProposal` / `AccountState` / `MarketState`
 * inputs the engine demands, runs the engine, and returns an exchange-ready
 * quantity + the priced levels, snapped to the instrument's tick/step grid.
 *
 * The model NEVER sizes: the risk engine derives quantity from the money at
 * risk and the stop distance, and this module only normalizes the result to the
 * exchange grid (always rounding DOWN).
 *
 * @module telegram/size
 */
import { evaluateTrade } from '../risk/risk-engine.mjs';
import { normalizeQuantity, normalizePrice } from '../market/normalize.mjs';
import { loadRiskLimits } from '../config/risk.mjs';

// Resolve the risk profile ONCE from the environment (RISK_PER_TRADE_PCT etc.),
// so the operator controls the money-at-risk through .env, not code edits.
const RISK_LIMITS = loadRiskLimits();

/**
 * @param {object} input
 * @param {object} input.idea { symbol, side, entry, stopLoss, takeProfit }
 * @param {object} input.instrument { tickSize, qtyStep, minOrderQty, maxOrderQty, minNotionalUsd? }
 * @param {object} input.wallet { equityUsd, availableBalanceUsd }
 * @param {number} [input.riskPct] optional per-trade risk override (% equity); e.g. the auto-trader uses 1% while manual trades use the env default.
 */
export function sizePosition({ idea, instrument, wallet, riskPct }) {
  const side = idea.side === 'LONG' ? 'LONG' : 'SHORT';
  // When an explicit risk override is given, clone the frozen limits with the
  // new per-trade risk so the auto-trader can trade smaller without touching .env.
  let riskConfig = RISK_LIMITS;
  if (riskPct !== undefined && Number.isFinite(riskPct) && riskPct > 0) {
    riskConfig = Object.freeze({ ...RISK_LIMITS, riskPerTradePct: riskPct });
  }

  const proposal = {
    symbol: idea.symbol,
    side,
    entryPrice: Number(idea.entry),
    stopLossPrice: Number(idea.stopLoss),
    takeProfitPrice: Number(idea.takeProfit),
    confidence: 0.5, // informational only; sizing ignores it (see risk engine)
    strategyId: 'telegram-scout',
    timestamp: Date.now(),
  };

  const account = {
    equityUsd: wallet.equityUsd,
    availableBalanceUsd: wallet.availableBalanceUsd,
    dailyRealizedPnlUsd: 0,
    peakEquityUsd: wallet.equityUsd,
    openPositions: [],
    openOrders: [],
    tradesToday: 0,
  };

  const market = {
    markPrice: Number(idea.entry),
    bestAsk: Number(idea.entry),
    bestBid: Number(idea.entry),
    instrument: {
      symbol: idea.symbol,
      tickSize: instrument.tickSize,
      qtyStep: instrument.qtyStep,
      minOrderQty: instrument.minOrderQty,
      maxOrderQty: instrument.maxOrderQty,
      minNotionalUsd: instrument.minNotionalUsd,
    },
  };

  const result = evaluateTrade({ proposal, account, market, riskConfig });

  if (!result.approved) {
    return { approved: false, reason: result.message, reasonCode: result.reasonCode };
  }

  // Snap quantity DOWN to qtyStep (never risk more than approved).
  const qtyNorm = normalizeQuantity(result.estimatedQuantity, instrument.qtyStep);
  if (!qtyNorm.ok || qtyNorm.value === null) {
    return { approved: false, reason: qtyNorm.reason ?? 'quantity normalization failed', reasonCode: 'QTY_NORMALIZE' };
  }

  return {
    approved: true,
    quantity: qtyNorm.value,
    quantityStr: String(qtyNorm.value),
    entryPrice: result.entryPrice ?? Number(idea.entry),
    stopLossPrice: result.stopLossDistance !== undefined ? Number(idea.stopLoss) : Number(idea.stopLoss),
    takeProfitPrice: Number(idea.takeProfit),
    riskAmountUsd: result.riskAmountUsd,
    notionalUsd: result.positionNotionalUsd,
    riskReward: result.riskReward,
  };
}

/**
 * Normalize a price to the instrument tick grid (round toward market).
 *
 * @param {number} price
 * @param {number} tickSize
 * @returns {string} exchange-ready price string
 */
export function snapPrice(price, tickSize) {
  const norm = normalizePrice(price, tickSize);
  if (norm.ok && norm.value !== null) return String(norm.value);
  return String(price);
}
