/**
 * Persistent process state for the Telegram phase (MVP-2).
 *
 * Keeps daily loss counters, auto-opened symbols, reflected close ids and the
 * previous positions snapshot on disk so a process restart does not reset risk
 * accounting or duplicate reflections. Writes are atomic (tmp + rename) and
 * fail-silent.
 *
 * @module telegram/state
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_REFLECTED_IDS = 500;

/**
 * @returns {string} today's UTC date as YYYY-MM-DD
 */
function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * Validate and normalize persisted state. Returns a safe default on any
 * mismatch so a corrupt file cannot crash the bot.
 *
 * @param {unknown} raw
 * @returns {{
 *   day: string,
 *   autoDailyLossUsd: number,
 *   autoOpenedSymbols: string[],
 *   reflectedCloseIds: string[],
 *   prevPositions: Record<string, { symbol: string, side: string, avgPrice: number, markPrice: number, stopLoss?: number|null, takeProfit?: number|null, unrealisedPnl: number, firstSeenAt: string }>,
 *   positionsPeak: Record<string, number>,
 * }}
 */
function normalizeState(raw) {
  const today = utcDay();
  const state = {
    day: today,
    autoDailyLossUsd: 0,
    autoOpenedSymbols: [],
    reflectedCloseIds: [],
    prevPositions: {},
    positionsPeak: {},
  };
  if (!raw || typeof raw !== 'object') return state;
  const obj = /** @type {Record<string, unknown>} */ (raw);

  const savedDay = isNonEmptyString(obj.day) ? obj.day : today;
  state.day = today;
  // If the UTC day changed, reset the daily loss counter but keep the rest.
  if (typeof obj.autoDailyLossUsd === 'number' && Number.isFinite(obj.autoDailyLossUsd)) {
    state.autoDailyLossUsd = savedDay === today ? obj.autoDailyLossUsd : 0;
  }
  if (Array.isArray(obj.autoOpenedSymbols)) {
    state.autoOpenedSymbols = obj.autoOpenedSymbols.filter(isNonEmptyString);
  }
  if (Array.isArray(obj.reflectedCloseIds)) {
    state.reflectedCloseIds = obj.reflectedCloseIds.filter(isNonEmptyString).slice(-MAX_REFLECTED_IDS);
  }
  if (obj.prevPositions && typeof obj.prevPositions === 'object' && !Array.isArray(obj.prevPositions)) {
    for (const [key, value] of Object.entries(obj.prevPositions)) {
      if (!value || typeof value !== 'object') continue;
      const v = /** @type {Record<string, unknown>} */ (value);
      if (!isNonEmptyString(v.symbol) || !isNonEmptyString(v.side)) continue;
      state.prevPositions[key] = {
        symbol: String(v.symbol),
        side: String(v.side),
        avgPrice: Number(v.avgPrice) || 0,
        markPrice: Number(v.markPrice) || 0,
        stopLoss: v.stopLoss == null ? null : Number(v.stopLoss),
        takeProfit: v.takeProfit == null ? null : Number(v.takeProfit),
        unrealisedPnl: Number(v.unrealisedPnl) || 0,
        firstSeenAt: isNonEmptyString(v.firstSeenAt) ? String(v.firstSeenAt) : new Date().toISOString(),
      };
    }
  }
  if (obj.positionsPeak && typeof obj.positionsPeak === 'object' && !Array.isArray(obj.positionsPeak)) {
    for (const [key, value] of Object.entries(obj.positionsPeak)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        state.positionsPeak[key] = value;
      }
    }
  }
  return state;
}

/**
 * Load persisted state. Returns a safe default if the file is missing or corrupt.
 *
 * @param {string} [file]
 * @returns {Promise<ReturnType<typeof normalizeState>>}
 */
export async function loadState(file = 'data/telegram/state.json') {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    return normalizeState(parsed);
  } catch {
    return normalizeState(null);
  }
}

/**
 * Atomically persist state. Never throws.
 *
 * @param {ReturnType<typeof normalizeState>} state
 * @param {string} [file]
 * @returns {Promise<boolean>}
 */
export async function saveState(state, file = 'data/telegram/state.json') {
  try {
    await mkdir(dirname(file), { recursive: true });
    const trimmed = {
      ...state,
      reflectedCloseIds: (state.reflectedCloseIds || []).slice(-MAX_REFLECTED_IDS),
    };
    const tmp = join(dirname(file), `.${String(Date.now())}.state.json.tmp`);
    await writeFile(tmp, JSON.stringify(trimmed), 'utf8');
    await rename(tmp, file);
    return true;
  } catch {
    try {
      await unlink(tmp).catch(() => {});
    } catch {
      /* best-effort cleanup */
    }
    return false;
  }
}
