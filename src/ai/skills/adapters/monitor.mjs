/**
 * MONITOR adapter — typed host contract for the open-position guardian.
 *
 * Baseline: `src/telegram/monitor.mjs` (MONITOR_SYSTEM_PROMPT,
 * buildMonitorPrompt, parseMonitorResponse). Trailing stops, take-profits and
 * the human EXIT confirmation stay in code; the model only proposes HOLD/EXIT.
 *
 * @module ai/skills/adapters/monitor
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
  const input = closed(hostInput, ['news', 'position', 'market', 'btc'], 'monitor input', inputInvalid);
  refuseSecretFields(hostInput, 'monitor input');
  const news = shapeNews(input.news, 'monitor input.news');
  const position = shapePosition(input.position, 'monitor input.position');
  const rawMarket = closed(
    input.market,
    ['symbol', 'lastPrice', 'bid', 'ask', 'high24h', 'low24h', 'avgRange14h', 'candles', 'atr14h', 'trend'],
    'monitor input.market',
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
    'monitor input.market',
  );
  if (market.symbol !== position.symbol) {
    inputInvalid('monitor input: position symbol must match the market snapshot symbol', 'monitor input.market.symbol');
  }
  const atr14h = finiteNumber(rawMarket.atr14h, 'monitor input.market.atr14h', { min: 0, nullable: true });
  const trend = shapeTrend(rawMarket.trend, 'monitor input.market.trend');
  const btc = shapeBtc(input.btc, 'monitor input.btc');
  return { news, position, market: { ...market, atr14h, trend }, btc };
}

/**
 * @param {unknown} value
 */
function validateOutput(value) {
  const output = closed(value, ['action', 'reason', 'confidence'], 'monitor output', outputInvalid);
  const action = stringField(output.action, 'monitor output.action', { values: ['HOLD', 'EXIT'] }, outputInvalid);
  const reason = stringField(output.reason, 'monitor output.reason', { minLength: 1, maxLength: 800 }, outputInvalid);
  const confidence = finiteNumber(output.confidence, 'monitor output.confidence', { min: 0, max: 1 }, outputInvalid);
  return Object.freeze({ action, reason, confidence });
}

/** Host contract catalogue entry. */
export const monitorAdapter = defineAdapter(
  'MONITOR',
  'monitor.v1',
  { id: 'monitor.input', version: '1.0.0' },
  { id: 'monitor.output', version: '1.0.0' },
  ['position.monitor.v1', 'news.headlines.v1'],
  shape,
  validateOutput,
);
