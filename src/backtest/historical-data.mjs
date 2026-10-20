/**
 * Historical data loader for backtests.
 *
 * Offline by construction: it reads an in-memory array or a local JSON/JSONL
 * file and never touches the network. Invalid market data must not silently
 * enter a strategy (MASTER_SPEC §30), so every row is normalized and the series
 * is rejected outright if it is out of order, duplicated, or contains an
 * impossible candle (negative price, high below low, or a body outside the
 * high/low range).
 *
 * @module backtest/historical-data
 */
import { readFile as readFileDefault } from 'node:fs/promises';
import { ConfigError } from '../config/config-error.mjs';
import { normalizeCandle } from '../market/market-snapshot.mjs';

/**
 * @typedef {object} HistoricalDataset
 * @property {readonly import('../market/market-snapshot.mjs').Candle[]} candles strictly increasing by startTime
 * @property {string | null} symbol symbol the series belongs to, when the file declares one
 * @property {object | null} instrument instrument metadata, when the file declares one
 * @property {string | null} interval candle interval code, when the file declares one
 * @property {string} source description of where the data came from
 */

/**
 * Normalize and validate a candle series.
 *
 * @param {unknown} rawCandles
 * @returns {readonly import('../market/market-snapshot.mjs').Candle[]}
 * @throws {ConfigError} when the series is empty, unordered, duplicated or impossible
 */
export function normalizeHistoricalCandles(rawCandles) {
  if (!Array.isArray(rawCandles)) {
    throw new ConfigError('Historical data must be an array of candles', { field: 'candles' });
  }
  if (rawCandles.length === 0) {
    throw new ConfigError('Historical data is empty — nothing to backtest', { field: 'candles' });
  }

  /** @type {import('../market/market-snapshot.mjs').Candle[]} */
  const candles = [];
  /** @type {import('../market/market-snapshot.mjs').Candle | null} */
  let previous = null;

  rawCandles.forEach((raw, index) => {
    const candle = normalizeCandle(raw);

    for (const field of ['open', 'high', 'low', 'close']) {
      if (candle[field] <= 0) {
        throw new ConfigError(`Candle[${index}].${field} must be > 0, got ${candle[field]}`, {
          field: `candles[${index}].${field}`,
          value: candle[field],
        });
      }
    }
    if (candle.high < Math.max(candle.open, candle.close) - 1e-9) {
      throw new ConfigError(
        `Candle[${index}].high ${candle.high} is below its body (open ${candle.open}, close ${candle.close})`,
        { field: `candles[${index}].high` },
      );
    }
    if (candle.low > Math.min(candle.open, candle.close) + 1e-9) {
      throw new ConfigError(
        `Candle[${index}].low ${candle.low} is above its body (open ${candle.open}, close ${candle.close})`,
        { field: `candles[${index}].low` },
      );
    }
    if (candle.volume < 0) {
      throw new ConfigError(`Candle[${index}].volume must be >= 0, got ${candle.volume}`, {
        field: `candles[${index}].volume`,
      });
    }

    if (previous !== null) {
      if (candle.startTime === previous.startTime) {
        throw new ConfigError(`Historical data has a duplicate candle at ${new Date(candle.startTime).toISOString()}`, {
          field: `candles[${index}].startTime`,
        });
      }
      if (candle.startTime < previous.startTime) {
        throw new ConfigError(
          `Historical data is not ordered: candle[${index}] starts ${new Date(candle.startTime).toISOString()} after ${new Date(previous.startTime).toISOString()}`,
          { field: `candles[${index}].startTime` },
        );
      }
    }

    previous = candle;
    candles.push(candle);
  });

  return Object.freeze(candles);
}

/**
 * Detect gaps in an otherwise valid series.
 *
 * A gap is reported, not rejected: some instruments legitimately halt, and the
 * caller decides whether that is acceptable. An issue is never silent.
 *
 * @param {readonly import('../market/market-snapshot.mjs').Candle[]} candles
 * @param {number} intervalMs expected spacing between consecutive candle starts
 * @returns {readonly { index: number, expectedStart: number, actualStart: number, missingBars: number }[]}
 */
export function detectCandleGaps(candles, intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new ConfigError(`detectCandleGaps requires a positive intervalMs, got ${JSON.stringify(intervalMs)}`);
  }
  const issues = [];
  for (let index = 1; index < candles.length; index += 1) {
    const expectedStart = candles[index - 1].startTime + intervalMs;
    const actualStart = candles[index].startTime;
    if (actualStart !== expectedStart) {
      issues.push({
        index,
        expectedStart,
        actualStart,
        missingBars: Math.max(0, Math.round((actualStart - expectedStart) / intervalMs)),
      });
    }
  }
  return Object.freeze(issues);
}

/**
 * Parse a JSON or JSONL document into a raw candle array plus optional metadata.
 *
 * @param {string} text
 * @param {'json' | 'jsonl'} format
 * @returns {{ candles: unknown[], symbol: string | null, instrument: object | null, interval: string | null }}
 */
export function parseHistoricalText(text, format) {
  if (format === 'jsonl') {
    const candles = String(text)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new ConfigError(
            `Historical JSONL is corrupt at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
            { field: 'file' },
          );
        }
      });
    return { candles, symbol: null, instrument: null, interval: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Historical JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`, {
      field: 'file',
    });
  }

  if (Array.isArray(parsed)) {
    return { candles: parsed, symbol: null, instrument: null, interval: null };
  }
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.candles)) {
    return {
      candles: parsed.candles,
      symbol: typeof parsed.symbol === 'string' ? parsed.symbol : null,
      instrument: parsed.instrument && typeof parsed.instrument === 'object' ? parsed.instrument : null,
      interval: typeof parsed.interval === 'string' ? parsed.interval : null,
    };
  }
  throw new ConfigError('Historical JSON must be a candle array or an object with a `candles` array', { field: 'file' });
}

/**
 * Load a historical dataset from an array, a `{ candles, ... }` object, or a
 * local JSON/JSONL file.
 *
 * The file path is read with `node:fs/promises` unless `readFile` is injected,
 * which keeps the loader fully offline and unit-testable.
 *
 * @param {{
 *   source: unknown[] | object | string,
 *   format?: 'json' | 'jsonl',
 *   readFile?: (path: string, encoding: string) => Promise<string>,
 * }} options
 * @returns {Promise<Readonly<HistoricalDataset>>}
 */
export async function loadHistoricalData(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('loadHistoricalData requires options');
  }
  const source = options.source;
  const readFile = options.readFile ?? readFileDefault;

  /** @type {{ candles: unknown[], symbol: string | null, instrument: object | null, interval: string | null }} */
  let raw;

  if (Array.isArray(source)) {
    raw = { candles: source, symbol: null, instrument: null, interval: null };
  } else if (source !== null && typeof source === 'object') {
    raw = {
      candles: /** @type {any} */ (source).candles,
      symbol: typeof /** @type {any} */ (source).symbol === 'string' ? /** @type {any} */ (source).symbol : null,
      instrument: /** @type {any} */ (source).instrument ?? null,
      interval: typeof /** @type {any} */ (source).interval === 'string' ? /** @type {any} */ (source).interval : null,
    };
  } else if (typeof source === 'string' && source.trim() !== '') {
    const format = options.format ?? (/\.(jsonl|ndjson)$/i.test(source) ? 'jsonl' : 'json');
    const text = await readFile(source, 'utf8');
    raw = parseHistoricalText(text, format);
  } else {
    throw new ConfigError('loadHistoricalData requires an array, a dataset object, or a file path', { field: 'source' });
  }

  const candles = normalizeHistoricalCandles(raw.candles);
  return Object.freeze({
    candles,
    symbol: raw.symbol,
    instrument: raw.instrument,
    interval: raw.interval,
    source: Array.isArray(source) ? 'array' : typeof source === 'string' ? source : 'object',
  });
}
