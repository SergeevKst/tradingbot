/**
 * STOPCHECK adapter — typed host contract for the fast loss-protection review.
 *
 * Baseline: `src/telegram/stopcheck.mjs` (STOPCHECK_SYSTEM_PROMPT,
 * buildStopcheckPrompt, shouldConsultStopcheck, isTrendAgainst,
 * decideStopcheckAction). The three-way deterministic gate — meaningful loss
 * AND adverse trend AND a valid model CLOSE — stays in code; the model cannot
 * close a position on its own.
 *
 * @module ai/skills/adapters/stopcheck
 */
import {
  closed,
  defineAdapter,
  finiteNumber,
  inputInvalid,
  outputInvalid,
  refuseSecretFields,
  stringField,
} from './shared.mjs';
import { shapeBtc, shapeMarket, shapeNews, shapePosition, shapeTrend } from './market-context.mjs';

/**
 * @param {unknown} hostInput
 */
function shape(hostInput) {
  const input = closed(hostInput, ['news', 'position', 'market', 'btc'], 'stopcheck input', inputInvalid);
  refuseSecretFields(hostInput, 'stopcheck input');
  const news = shapeNews(input.news, 'stopcheck input.news');
  const position = shapePosition(input.position, 'stopcheck input.position');
  const rawMarket = closed(
    input.market,
    ['symbol', 'lastPrice', 'bid', 'ask', 'high24h', 'low24h', 'avgRange14h', 'candles', 'atr14h', 'trend'],
    'stopcheck input.market',
    inputInvalid,
  );
  const market = shapeMarket(
    {
      symbol: rawMarket.symbol,
      lastPrice: rawMarket.lastPrice,
      bid: rawMarket.bid,
      ask: rawMarket.ask,
      high24h: rawMarket.high24h,
      low24h: rawMarket.low24h,
      avgRange14h: rawMarket.avgRange14h,
      candles: rawMarket.candles,
    },
    'stopcheck input.market',
  );
  if (market.symbol !== position.symbol) {
    inputInvalid('stopcheck input: position symbol must match the market snapshot symbol', 'stopcheck input.market.symbol');
  }
  const atr14h = finiteNumber(rawMarket.atr14h, 'stopcheck input.market.atr14h', { min: 0, nullable: true });
  const trend = shapeTrend(rawMarket.trend, 'stopcheck input.market.trend');
  const btc = shapeBtc(input.btc, 'stopcheck input.btc');
  return { news, position, market: { ...market, atr14h, trend }, btc };
}

/**
 * @param {unknown} value
 */
function validateOutput(value) {
  const output = closed(value, ['action', 'reason', 'confidence'], 'stopcheck output', outputInvalid);
  const action = stringField(output.action, 'stopcheck output.action', { values: ['CLOSE', 'HOLD'] }, outputInvalid);
  const reason = stringField(output.reason, 'stopcheck output.reason', { minLength: 1, maxLength: 800 }, outputInvalid);
  const confidence = finiteNumber(output.confidence, 'stopcheck output.confidence', { min: 0, max: 1 }, outputInvalid);
  return Object.freeze({ action, reason, confidence });
}

/** Host contract catalogue entry. */
export const stopcheckAdapter = defineAdapter(
  'STOPCHECK',
  'stopcheck.v1',
  { id: 'stopcheck.input', version: '1.0.0' },
  { id: 'stopcheck.output', version: '1.0.0' },
  ['position.stopcheck.v1', 'news.headlines.v1'],
  shape,
  validateOutput,
);
