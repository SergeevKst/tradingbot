/**
 * Market news layer (MVP-2).
 *
 * There is no paid news/search API key and DeepSeek's chat API has no built-in
 * web search, so this module reads FREE public sources directly over HTTP:
 *   - the Crypto Fear & Greed index (a single JSON endpoint, no key)
 *   - public RSS feeds (CoinDesk, CoinTelegraph, Decrypt) — headlines only
 *
 * Everything is fail-closed: a network error or malformed feed yields an empty
 * result, never a thrown error that would kill the monitor loop. News is an
 * ADVISORY signal only — the deterministic risk engine and the guard still own
 * the final decision.
 *
 * @module telegram/news
 */
import { readFile } from 'node:fs/promises';

const FEAR_GREED_URL = 'https://api.alternative.me/fng/';
// Free fast aggregator (keyless, ~1-5 min freshness, 300+ sources). Supplements
// the RSS feeds, which are 22-60 min fresh.
const BREAKING_URL = 'https://cryptocurrency.cv/api/breaking';
const RSS_FEEDS = Object.freeze([
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'Blockworks', url: 'https://blockworks.co/feed' },
]);

/** Tiny no-dependency XML-ish extractor for <item><title>…</title> in RSS. */
function extractTitles(xml, limit = 20) {
  const titles = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && titles.length < limit) {
    const item = m[1];
    const t = item.match(/<title(?:[^>]*)>([\s\S]*?)<\/title>/i);
    if (t) {
      const title = t[1]
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (title) titles.push(title);
    }
  }
  return titles;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * Fetch the Fear & Greed index. Returns null on any failure (fail-closed).
 *
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [opts]
 * @returns {Promise<{ value: number, classification: string } | null>}
 */
export async function fetchFearGreed({ fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(FEAR_GREED_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const payload = await res.json();
    const data = payload?.data?.[0];
    const value = Number(data?.value);
    if (!Number.isFinite(value)) return null;
    return { value, classification: String(data?.value_classification ?? '') };
  } catch {
    return null;
  }
}

/**
 * Fetch headlines from the configured public RSS feeds. Each feed is optional —
 * one dead feed must not sink the whole call. Returns an array of
 * `{ source, title }`, empty on total failure.
 *
 * @param {{ fetchImpl?: typeof fetch, feeds?: Array<{ name: string, url: string }>, limit?: number }} [opts]
 * @returns {Promise<Array<{ source: string, title: string }>>}
 */
export async function fetchNewsHeadlines({
  fetchImpl = globalThis.fetch,
  feeds = RSS_FEEDS,
  limit = 20,
} = {}) {
  const out = [];
  await Promise.all(
    feeds.map(async (feed) => {
      try {
        const res = await fetchImpl(feed.url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return;
        const xml = await res.text();
        const titles = extractTitles(xml, limit).map((t) => decodeEntities(t));
        for (const title of titles) out.push({ source: feed.name, title });
      } catch {
        /* individual feed failure is non-fatal */
      }
    }),
  );
  // Stable, source-grouped order for deterministic logging.
  out.sort((a, b) => a.source.localeCompare(b.source) || a.title.localeCompare(b.title));
  return out;
}

/**
 * Fetch breaking headlines from the free cryptocurrency.cv aggregator (JSON).
 * Returns `[{ source, title }]`, empty on failure. This stream is much fresher
 * (~1-5 min) than RSS but is the noisiest — the caller dedupes against RSS.
 *
 * @param {{ fetchImpl?: typeof fetch, limit?: number }} [opts]
 * @returns {Promise<Array<{ source: string, title: string }>>}
 */
export async function fetchBreakingNews({ fetchImpl = globalThis.fetch, limit = 20 } = {}) {
  const out = [];
  try {
    const res = await fetchImpl(BREAKING_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return out;
    const payload = await res.json();
    const items = Array.isArray(payload) ? payload : (payload?.data ?? payload?.articles ?? []);
    for (const item of items.slice(0, limit)) {
      const title = typeof item?.title === 'string' ? item.title.trim() : (typeof item?.headline === 'string' ? item.headline.trim() : '');
      if (!title) continue;
      const source = typeof item?.source === 'string' ? item.source : (item?.source_name ?? 'breaking');
      out.push({ source, title });
    }
  } catch {
    /* fail-closed */
  }
  return out;
}

/**
 * Build a compact news context string for the guard/reasoner. Fear & Greed first,
 * then a deduplicated headline list. Returns '' when nothing was collected.
 *
 * @param {{ fng?: { value: number, classification: string } | null, headlines?: Array<{ source: string, title: string }> }} input
 * @returns {string}
 */
export function formatNewsContext({ fng = null, headlines = [] } = {}) {
  const parts = [];
  if (fng && Number.isFinite(fng.value)) {
    parts.push(`Fear & Greed: ${fng.value}/100 (${fng.classification})`);
  }
  if (headlines.length > 0) {
    parts.push('Recent headlines:');
    for (const h of headlines.slice(0, 30)) {
      parts.push(`- [${h.source}] ${h.title}`);
    }
  }
  return parts.length ? parts.join('\n') : '';
}

/**
 * Convenience: fetch both sources and format a single context string.
 *
 * @param {object} [opts]
 * @returns {Promise<{ fng: any, headlines: any[], text: string }>}
 */
export async function gatherNews(opts = {}) {
  const [fng, rssHeadlines, breaking] = await Promise.all([
    fetchFearGreed(opts),
    fetchNewsHeadlines(opts),
    fetchBreakingNews(opts),
  ]);
  // Prepend the freshest breaking items, then de-duplicate by title so RSS and
  // the aggregator do not repeat the same story.
  const seen = new Set();
  const headlines = [];
  for (const h of [...breaking, ...rssHeadlines]) {
    const key = h.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    headlines.push(h);
  }
  const text = formatNewsContext({ fng, headlines });
  return { fng, headlines, text };
}

/**
 * A filesystem-backed minimal stub for offline/testing: reads a captured JSON
 * snapshot instead of hitting the network. Used by tests only.
 *
 * @param {string} file
 * @returns {Promise<{ fng: any, headlines: any[], text: string }>}
 */
export async function loadNewsSnapshot(file) {
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return { fng: null, headlines: [], text: '' };
  }
  return {
    fng: data.fng ?? null,
    headlines: data.headlines ?? [],
    text: formatNewsContext({ fng: data.fng ?? null, headlines: data.headlines ?? [] }),
  };
}
