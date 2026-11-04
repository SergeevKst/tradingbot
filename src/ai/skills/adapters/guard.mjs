/**
 * GUARD adapter — typed host contract for the adversarial risk filter.
 *
 * Baseline: `src/telegram/risk-filter.mjs` (GUARD_SYSTEM_PROMPT,
 * parseGuardResponse, buildGuardPrompt). The deterministic precheck and the
 * effect-authorization decision stay in code; this adapter only shapes the
 * snapshot and enforces the closed verdict contract. An `APPROVED` verdict is
 * advice, never a risk approval.
 *
 * @module ai/skills/adapters/guard
 */
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
import { shapeBtc, shapeCandles, shapeMarket, shapeNews, shapeSentiment } from './market-context.mjs';

const IDEA_KEYS = Object.freeze(['symbol', 'side', 'entry', 'stopLoss', 'takeProfit']);
const OUTPUT_KEYS = Object.freeze(['verdict', 'confidence', 'reasons']);

/**
 * @param {unknown} raw
 * @param {string} label
 */
function shapeIdea(raw, label) {
  const idea = closed(raw, IDEA_KEYS, label, inputInvalid);
  return Object.freeze({
    symbol: stringField(idea.symbol, `${label}.symbol`, { minLength: 1, maxLength: 40 }),
    side: stringField(idea.side, `${label}.side`, { values: ['LONG', 'SHORT'] }),
    entry: finiteNumber(idea.entry, `${label}.entry`, { min: 0 }),
    stopLoss: finiteNumber(idea.stopLoss, `${label}.stopLoss`, { min: 0 }),
    takeProfit: finiteNumber(idea.takeProfit, `${label}.takeProfit`, { min: 0 }),
  });
}

/**
 * @param {unknown} hostInput
 */
function shape(hostInput) {
  const input = closed(hostInput, ['btc', 'news', 'idea', 'market', 'sentiment'], 'guard input', inputInvalid);
  refuseSecretFields(hostInput, 'guard input');
  const btc = shapeBtc(input.btc, 'guard input.btc');
  const news = shapeNews(input.news, 'guard input.news');
  const idea = shapeIdea(input.idea, 'guard input.idea');
  const market = shapeMarket(input.market, 'guard input.market');
  // Baseline shape also carries precomputed candles for the same symbol; the
  // market block already owns them, so no second copy is projected.
  if (market.symbol !== idea.symbol) {
    inputInvalid('guard input: idea symbol must match the market snapshot symbol', 'guard input.idea.symbol');
  }
  const sentiment = shapeSentiment(input.sentiment, 'guard input.sentiment');
  return { btc, news, idea, market: { ...market, candles: shapeCandles(input.market.candles, 'guard input.market.candles') }, sentiment };
}

/**
 * @param {unknown} value
 */
function validateOutput(value) {
  const output = closed(value, OUTPUT_KEYS, 'guard output', outputInvalid);
  const verdict = stringField(output.verdict, 'guard output.verdict', { values: ['APPROVED', 'REJECTED'] }, outputInvalid);
  const confidence = finiteNumber(output.confidence, 'guard output.confidence', { min: 0, max: 1 }, outputInvalid);
  const reasons = arrayField(output.reasons, 'guard output.reasons', { max: 5 }, outputInvalid).map((reason, index) =>
    stringField(reason, `guard output.reasons[${index}]`, { minLength: 1, maxLength: 200 }, outputInvalid),
  );
  if (reasons.length === 0) outputInvalid('guard output.reasons must contain at least one reason', 'guard output.reasons');
  return Object.freeze({ verdict, confidence, reasons: Object.freeze(reasons) });
}

/** Host contract catalogue entry. */
export const guardAdapter = defineAdapter(
  'GUARD',
  'guard.v1',
  { id: 'guard.input', version: '1.0.0' },
  { id: 'guard.output', version: '1.0.0' },
  ['market.guard.v1', 'news.headlines.v1'],
  shape,
  validateOutput,
);
