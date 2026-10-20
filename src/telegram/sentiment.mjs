/**
 * Market sentiment layer (MVP-3).
 *
 * A trade is not decided by price math alone: crowd positioning, liquidity and
 * macro mood all influence whether a setup actually works. This module reads
 * FREE public Bybit endpoints to build a compact "sentiment" object per symbol:
 *   - Funding rate (are longs or shorts crowded/paying?)
 *   - 24h volume + turnover (is the move backed by real liquidity?)
 *   - Open interest (are new positions adding, or is it just churn?)
 * plus the Fear & Greed reading from news.mjs.
 *
 * Everything is advisory and fail-closed: a missing field yields null, never a
 * throw, and the guard treats absent sentiment as "unknown", not as bullish.
 *
 * @module telegram/sentiment
 */

const MAINNET_REST_BASE_URL = 'https://api.bybit.com';

/**
 * @typedef {object} Sentiment
 * @property {number|null} fearGreed 0-100 (optional)
 * @property {string|null} fearGreedClass e.g. "Greed"
 * @property {number|null} fundingRate current funding (positive = longs pay shorts)
 * @property {number|null} volume24h 24h base-coin volume
 * @property {number|null} turnover24h 24h quote-coin turnover (USD-ish)
 * @property {number|null} openInterestValue open interest in quote value
 */

/**
 * Fetch funding + volume + open interest for one linear symbol.
 *
 * @param {string} symbol
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Partial<Sentiment>>}
 */
export async function fetchMarketSentiment(symbol, { fetchImpl = globalThis.fetch } = {}) {
  const out = { fundingRate: null, volume24h: null, turnover24h: null, openInterestValue: null };
  try {
    const res = await fetchImpl(
      `${MAINNET_REST_BASE_URL}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return out;
    const payload = await res.json();
    const row = (payload?.result?.list ?? [])[0];
    if (!row) return out;
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    out.fundingRate = num(row.fundingRate);
    out.volume24h = num(row.volume24h);
    out.turnover24h = num(row.turnover24h);
    out.openInterestValue = num(row.openInterestValue);
  } catch {
    /* fail-closed */
  }
  return out;
}

/**
 * Build a compact human-readable sentiment context string for the guard.
 *
 * @param {Sentiment} sentiment
 * @returns {string}
 */
export function formatSentiment(sentiment = {}) {
  const parts = [];
  if (Number.isFinite(sentiment.fearGreed)) {
    parts.push(`Fear&Greed: ${sentiment.fearGreed}/100 (${sentiment.fearGreedClass ?? ''})`);
  }
  if (Number.isFinite(sentiment.fundingRate)) {
    const fr = sentiment.fundingRate;
    const pct = (fr * 100).toFixed(4);
    const bias = fr > 0.0003 ? 'longs crowded (bullish but overheated)' : fr < -0.0003 ? 'shorts crowded (bearish but squeezed)' : 'neutral';
    parts.push(`Funding: ${pct}%/interval — ${bias}`);
  }
  if (Number.isFinite(sentiment.turnover24h)) {
    parts.push(`24h turnover: $${formatUsd(sentiment.turnover24h)}`);
  }
  if (Number.isFinite(sentiment.openInterestValue)) {
    parts.push(`Open interest: $${formatUsd(sentiment.openInterestValue)}`);
  }
  return parts.length ? parts.join('\n') : '';
}

function formatUsd(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}
