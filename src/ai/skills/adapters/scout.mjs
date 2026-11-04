/**
 * SCOUT adapter — typed host contract for trade-idea generation.
 *
 * Baseline: `src/telegram/ideas.mjs` (SCOUT_SYSTEM_PROMPT, ideaIssues,
 * validateIdeasWithMarket). The packaged skill owns the instructions and the
 * model-facing schema; this adapter owns data minimisation, the symbol/position
 * association checks and idea geometry. Sizing and human workflow stay in code.
 *
 * @module ai/skills/adapters/scout
 */
import {
  ALLOWED_SIDES,
  ENTRY_MAX_DEVIATION_PCT,
  MAX_IDEAS,
  MIN_REWARD_RISK,
  STOP_MIN_RANGE_MULT,
} from '../../../telegram/ideas.mjs';
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

const INPUT_KEYS = Object.freeze(['news', 'symbols', 'openPositions']);
const SYMBOL_KEYS = Object.freeze(['symbol', 'lastPrice', 'bid', 'ask', 'high24h', 'low24h', 'avgRange14h', 'candles']);
const CANDLE_KEYS = Object.freeze(['o', 'h', 'l', 'c', 'v']);
const OPEN_POSITION_KEYS = Object.freeze(['symbol', 'side']);
const IDEA_KEYS = Object.freeze(['symbol', 'side', 'entry', 'stopLoss', 'takeProfit', 'rationale']);

/**
 * @param {unknown} raw
 * @param {string} label
 */
function shapeCandles(raw, label) {
  const candles = arrayField(raw, label, { max: 30 }).map((entry, index) => {
    const at = `${label}[${index}]`;
    const candle = closed(entry, CANDLE_KEYS, at, inputInvalid);
    const o = finiteNumber(candle.o, `${at}.o`, { min: 0 });
    const h = finiteNumber(candle.h, `${at}.h`, { min: 0 });
    const l = finiteNumber(candle.l, `${at}.l`, { min: 0 });
    const c = finiteNumber(candle.c, `${at}.c`, { min: 0 });
    const v = finiteNumber(candle.v, `${at}.v`, { min: 0 });
    if (h < l) inputInvalid(`${at}: h must not be below l`, at);
    if (c > h || c < l || o > h || o < l) inputInvalid(`${at}: o/c must lie inside the candle range`, at);
    return Object.freeze({ o, h, l, c, v });
  });
  if (candles.length === 0) inputInvalid(`${label} must not be empty`, label);
  return Object.freeze(candles);
}

/**
 * @param {unknown} hostInput
 */
function shape(hostInput) {
  const input = closed(hostInput, INPUT_KEYS, 'scout input', inputInvalid);
  refuseSecretFields(hostInput, 'scout input');
  const news = input.news === null ? null : stringField(input.news, 'scout input.news', { maxLength: 8192 });
  const symbols = arrayField(input.symbols, 'scout input.symbols', { max: 20 }).map((entry, index) => {
    const at = `scout input.symbols[${index}]`;
    const raw = closed(entry, SYMBOL_KEYS, at, inputInvalid);
    return Object.freeze({
      symbol: stringField(raw.symbol, `${at}.symbol`, { minLength: 1, maxLength: 40 }),
      lastPrice: finiteNumber(raw.lastPrice, `${at}.lastPrice`, { min: 0 }),
      bid: finiteNumber(raw.bid, `${at}.bid`, { min: 0, nullable: true }),
      ask: finiteNumber(raw.ask, `${at}.ask`, { min: 0, nullable: true }),
      high24h: finiteNumber(raw.high24h, `${at}.high24h`, { min: 0, nullable: true }),
      low24h: finiteNumber(raw.low24h, `${at}.low24h`, { min: 0, nullable: true }),
      avgRange14h: finiteNumber(raw.avgRange14h, `${at}.avgRange14h`, { min: 0, nullable: true }),
      candles: shapeCandles(raw.candles, `${at}.candles`),
    });
  });
  if (symbols.length === 0) inputInvalid('scout input.symbols must not be empty', 'scout input.symbols');
  const seen = new Set();
  for (const entry of symbols) {
    if (seen.has(entry.symbol)) inputInvalid('scout input.symbols must not repeat a symbol', 'scout input.symbols');
    seen.add(entry.symbol);
    if (entry.high24h !== null && entry.low24h !== null && entry.high24h < entry.low24h) {
      inputInvalid(`scout input.symbols ${entry.symbol}: high24h is below low24h`, 'scout input.symbols');
    }
  }
  const openPositions = input.openPositions === null
    ? null
    : Object.freeze(
        arrayField(input.openPositions, 'scout input.openPositions', { max: 20 }).map((entry, index) => {
          const at = `scout input.openPositions[${index}]`;
          const raw = closed(entry, OPEN_POSITION_KEYS, at, inputInvalid);
          return Object.freeze({
            symbol: stringField(raw.symbol, `${at}.symbol`, { minLength: 1, maxLength: 40 }),
            side: stringField(raw.side, `${at}.side`, { values: ALLOWED_SIDES }),
          });
        }),
      );
  return { news, symbols, openPositions };
}

/**
 * Market-aware domain validation of the model's ideas. Any invalid idea voids
 * the whole response (v2.0 has no partial salvage, architecture §2.4 #8).
 *
 * @param {unknown} value
 * @param {Readonly<object>} dto
 */
export function validateScoutIdeas(value, dto) {
  const typed = /** @type {any} */ (dto);
  const output = closed(value, ['ideas'], 'scout output', outputInvalid);
  const ideas = arrayField(output.ideas, 'scout output.ideas', { max: MAX_IDEAS }, outputInvalid);
  const marketBySymbol = new Map(typed.symbols.map((entry) => [entry.symbol, entry]));
  const openSymbols = new Set((typed.openPositions ?? []).map((entry) => entry.symbol));
  const proposed = new Set();
  return Object.freeze(
    ideas.map((entry, index) => {
      const at = `scout output.ideas[${index}]`;
      const idea = closed(entry, IDEA_KEYS, at, outputInvalid);
      const symbol = stringField(idea.symbol, `${at}.symbol`, { minLength: 1, maxLength: 40 }, outputInvalid);
      const side = stringField(idea.side, `${at}.side`, { values: ALLOWED_SIDES }, outputInvalid);
      const entryPrice = finiteNumber(idea.entry, `${at}.entry`, { min: 0 }, outputInvalid);
      const stopLoss = finiteNumber(idea.stopLoss, `${at}.stopLoss`, { min: 0 }, outputInvalid);
      const takeProfit = finiteNumber(idea.takeProfit, `${at}.takeProfit`, { min: 0 }, outputInvalid);
      const rationale = stringField(idea.rationale, `${at}.rationale`, { minLength: 1, maxLength: 600 }, outputInvalid);
      const market = marketBySymbol.get(symbol);
      if (!market) outputInvalid(`${at}: symbol ${JSON.stringify(symbol)} was not in the market data`, at);
      if (proposed.has(symbol)) outputInvalid(`${at}: duplicate idea for ${JSON.stringify(symbol)}`, at);
      proposed.add(symbol);
      if (openSymbols.has(symbol)) outputInvalid(`${at}: ${JSON.stringify(symbol)} already has an open position`, at);
      if (side === 'LONG' ? !(stopLoss < entryPrice && takeProfit > entryPrice) : !(stopLoss > entryPrice && takeProfit < entryPrice)) {
        outputInvalid(`${at}: levels are inconsistent with a ${side} trade`, at);
      }
      const deviationPct = (Math.abs(entryPrice - market.lastPrice) / market.lastPrice) * 100;
      if (!(deviationPct <= ENTRY_MAX_DEVIATION_PCT)) {
        outputInvalid(`${at}: entry is more than ${ENTRY_MAX_DEVIATION_PCT}% away from lastPrice`, at);
      }
      const risk = Math.abs(entryPrice - stopLoss);
      const reward = Math.abs(takeProfit - entryPrice);
      if (!(risk > 0) || !(reward >= MIN_REWARD_RISK * risk * (1 - 1e-9))) {
        outputInvalid(`${at}: reward/risk is below ${MIN_REWARD_RISK}`, at);
      }
      if (market.avgRange14h !== null && !(risk >= STOP_MIN_RANGE_MULT * market.avgRange14h)) {
        outputInvalid(`${at}: stop is closer than ${STOP_MIN_RANGE_MULT} x avgRange14h`, at);
      }
      return Object.freeze({
        symbol,
        side,
        entry: entryPrice,
        stopLoss,
        takeProfit,
        rationale,
      });
    }),
  );
}

/** Host contract catalogue entry. */
export const scoutAdapter = defineAdapter(
  'SCOUT',
  'scout.v1',
  { id: 'scout.input', version: '1.0.0' },
  { id: 'scout.output', version: '1.0.0' },
  ['market.scout.v1', 'news.headlines.v1'],
  shape,
  (value) => {
    // Output validation needs the shaped input; the runtime re-validates with
    // domain context, so this pure pass checks only the closed shape.
    const output = closed(value, ['ideas'], 'scout output', outputInvalid);
    const ideas = arrayField(output.ideas, 'scout output.ideas', { max: MAX_IDEAS }, outputInvalid);
    return Object.freeze({
      ideas: Object.freeze(
        ideas.map((entry, index) => {
          const at = `scout output.ideas[${index}]`;
          const idea = closed(entry, IDEA_KEYS, at, outputInvalid);
          return Object.freeze({
            symbol: stringField(idea.symbol, `${at}.symbol`, { minLength: 1, maxLength: 40 }, outputInvalid),
            side: stringField(idea.side, `${at}.side`, { values: ALLOWED_SIDES }, outputInvalid),
            entry: finiteNumber(idea.entry, `${at}.entry`, { min: 0 }, outputInvalid),
            stopLoss: finiteNumber(idea.stopLoss, `${at}.stopLoss`, { min: 0 }, outputInvalid),
            takeProfit: finiteNumber(idea.takeProfit, `${at}.takeProfit`, { min: 0 }, outputInvalid),
            rationale: stringField(idea.rationale, `${at}.rationale`, { minLength: 1, maxLength: 600 }, outputInvalid),
          });
        }),
      ),
    });
  },
  // Market-aware geometry: a model-proposed entry must sit near the observed
  // price, the stop/target must bracket it and honour the minimum reward/risk,
  // and the symbol must exist in the projected market snapshot.
  (value, dto) => Object.freeze({ ideas: validateScoutIdeas(value, dto) }),
);
