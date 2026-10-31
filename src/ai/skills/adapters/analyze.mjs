/**
 * ANALYZE adapter — typed host contract for the core analysis operation.
 *
 * Baseline: `src/ai/prompts.mjs` (AI_SYSTEM_PROMPT / buildAnalysisPrompt) and
 * `src/ai/analysis-schema.mjs`. The packaged skill owns the instructions and the
 * model-facing schema; this adapter owns the trusted projection of the
 * buildAIContext snapshot and the closed domain checks on the model's answer.
 * The deterministic risk engine still decides what may happen with that answer.
 *
 * @module ai/skills/adapters/analyze
 */
import { ANALYSIS_BIASES } from '../../../types/enums.mjs';
import {
  arrayField,
  closed,
  defineAdapter,
  finiteNumber,
  inputInvalid,
  outputInvalid,
  refuseSecretFields,
  stringField,
} from './shared.mjs';

const INPUT_KEYS = Object.freeze(['market', 'position']);
const MARKET_KEYS = Object.freeze(['symbol', 'timeframe', 'lastPrice', 'bid', 'ask', 'candles', 'indicators']);
const CANDLE_KEYS = Object.freeze(['startTime', 'open', 'high', 'low', 'close', 'volume']);
const POSITION_KEYS = Object.freeze(['symbol', 'side', 'entryPrice', 'markPrice', 'unrealizedPnlUsd', 'stopLossPrice', 'takeProfitPrice']);
const OUTPUT_KEYS = Object.freeze(['bias', 'confidence', 'rationale', 'evidence']);

/**
 * @param {unknown} raw
 * @param {string} label
 */
function shapeCandles(raw, label) {
  const candles = arrayField(raw, label, { max: 100 }).map((entry, index) => {
    const at = `${label}[${index}]`;
    const candle = closed(entry, CANDLE_KEYS, at, inputInvalid);
    const open = finiteNumber(candle.open, `${at}.open`, {}, inputInvalid);
    const high = finiteNumber(candle.high, `${at}.high`, {}, inputInvalid);
    const low = finiteNumber(candle.low, `${at}.low`, {}, inputInvalid);
    const close = finiteNumber(candle.close, `${at}.close`, {}, inputInvalid);
    const volume = finiteNumber(candle.volume, `${at}.volume`, { min: 0 }, inputInvalid);
    if (high < low) inputInvalid(`${at}: high must not be below low`, at);
    if (close > high || close < low || open > high || open < low) {
      inputInvalid(`${at}: open/close must lie inside the candle range`, at);
    }
    return Object.freeze({
      startTime: finiteNumber(candle.startTime, `${at}.startTime`, {}),
      open,
      high,
      low,
      close,
      volume,
    });
  });
  for (let index = 1; index < candles.length; index += 1) {
    if (!(candles[index].startTime > candles[index - 1].startTime)) {
      inputInvalid(`${label} must be strictly chronological, oldest first`, label);
    }
  }
  return candles;
}

/**
 * Indicators are projected as a sorted `{name, value}` list: an open-ended
 * numeric map cannot be expressed by a closed schema, and a deterministic,
 * bounded list keeps the package contract checkable.
 *
 * @param {unknown} raw
 * @returns {ReadonlyArray<{ name: string, value: number }>}
 */
function shapeIndicators(raw) {
  const indicators = shapeIndicatorMap(raw);
  return Object.freeze(
    [...indicators.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, value]) => Object.freeze({ name, value })),
  );
}

/**
 * @param {unknown} raw
 * @returns {Map<string, number>}
 */
function shapeIndicatorMap(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    inputInvalid('analyze input.market.indicators must be an object', 'analyze input.market.indicators');
  }
  /** @type {Map<string, number>} */
  const out = new Map();
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (raw));
  if (entries.length > 32) inputInvalid('analyze input.market.indicators has too many entries', 'analyze input.market.indicators');
  for (const [key, value] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(key)) {
      inputInvalid('analyze input.market.indicators has an invalid key', 'analyze input.market.indicators');
    }
    out.set(key, finiteNumber(value, `analyze input.market.indicators.${key}`, {}));
  }
  return out;
}

/**
 * @param {unknown} hostInput
 */
function shape(hostInput) {
  const input = closed(hostInput, INPUT_KEYS, 'analyze input', inputInvalid);
  refuseSecretFields(hostInput, 'analyze input');
  const market = closed(input.market, MARKET_KEYS, 'analyze input.market', inputInvalid);
  const symbol = stringField(market.symbol, 'analyze input.market.symbol', { minLength: 1, maxLength: 40 });
  const candles = shapeCandles(market.candles, 'analyze input.market.candles');
  if (candles.length === 0) inputInvalid('analyze input.market.candles must not be empty', 'analyze input.market.candles');
  const position = input.position === null
    ? null
    : (() => {
        const raw = closed(input.position, POSITION_KEYS, 'analyze input.position', inputInvalid);
        return Object.freeze({
          symbol: stringField(raw.symbol, 'analyze input.position.symbol', { minLength: 1, maxLength: 40 }),
          side: stringField(raw.side, 'analyze input.position.side', { values: ['LONG', 'SHORT'] }),
          entryPrice: finiteNumber(raw.entryPrice, 'analyze input.position.entryPrice', { min: 0 }),
          markPrice: finiteNumber(raw.markPrice, 'analyze input.position.markPrice', { min: 0 }),
          unrealizedPnlUsd: finiteNumber(raw.unrealizedPnlUsd, 'analyze input.position.unrealizedPnlUsd', {}),
          stopLossPrice: finiteNumber(raw.stopLossPrice, 'analyze input.position.stopLossPrice', { min: 0, nullable: true }),
          takeProfitPrice: finiteNumber(raw.takeProfitPrice, 'analyze input.position.takeProfitPrice', { min: 0, nullable: true }),
        });
      })();
  return {
    market: {
      symbol,
      timeframe: stringField(market.timeframe, 'analyze input.market.timeframe', { maxLength: 16, nullable: true }),
      lastPrice: finiteNumber(market.lastPrice, 'analyze input.market.lastPrice', { min: 0 }),
      bid: finiteNumber(market.bid, 'analyze input.market.bid', { min: 0, nullable: true }),
      ask: finiteNumber(market.ask, 'analyze input.market.ask', { min: 0, nullable: true }),
      candles,
      indicators: market.indicators === null ? null : shapeIndicators(market.indicators),
    },
    position,
  };
}

/**
 * @param {unknown} value
 */
function validateOutput(value) {
  const output = closed(value, OUTPUT_KEYS, 'analyze output', outputInvalid);
  const bias = stringField(output.bias, 'analyze output.bias', { values: ANALYSIS_BIASES }, outputInvalid);
  const confidence = finiteNumber(output.confidence, 'analyze output.confidence', { min: 0, max: 1 }, outputInvalid);
  const rationale = stringField(output.rationale, 'analyze output.rationale', { minLength: 1, maxLength: 2000 }, outputInvalid);
  let evidence = null;
  if (output.evidence !== undefined && output.evidence !== null) {
    evidence = arrayField(output.evidence, 'analyze output.evidence', { max: 20 }, outputInvalid).map((item, index) =>
      stringField(item, `analyze output.evidence[${index}]`, { minLength: 1, maxLength: 500 }, outputInvalid),
    );
  }
  return Object.freeze({ bias, confidence, rationale, evidence: evidence === null ? null : Object.freeze(evidence) });
}

/** Host contract catalogue entry. */
export const analyzeAdapter = defineAdapter(
  'ANALYZE',
  'analyze.v1',
  { id: 'analyze.input', version: '1.0.0' },
  { id: 'analyze.output', version: '1.0.0' },
  ['market.analysis.v1'],
  shape,
  validateOutput,
);
