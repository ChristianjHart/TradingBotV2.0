// Alpaca News client (GET https://data.alpaca.markets/v1beta1/news) using the SAME Alpaca credentials as market data.
// Headlines are normalised, de-duplicated and bounded; every field may be missing or oddly typed in the wild.
import { config, hasAlpacaCredentials } from '../config.js';
import { getJson } from './upstream.js';
import { isCrypto } from './market.js';
import { mockNewsEnabled, mockHeadlines } from './mockNews.js';
import { setCapped } from './alpaca.js';

export const NEWS_HOST = 'data.alpaca.markets';
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map();
export const _clearNewsCache = () => cache.clear();

export const MAX_HEADLINES_PER_SYMBOL = 8;
export const HEADLINE_WINDOW_HOURS = 48;
const BATCH = 5;
const PAGE_LIMIT = 50;

const canonKey = (s) => String(s).toUpperCase().replace('/', '');
/** Alpaca News uses 'BTCUSD' for crypto; equities as-is. */
export const toNewsSymbol = (s) => (isCrypto(s) ? canonKey(s) : String(s).toUpperCase());
const normTitle = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Normalise one raw Alpaca item to { title, url, publishedAt, source, symbols:[CANON] } or null. */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = [raw.headline, raw.title].find((v) => typeof v === 'string' && v.trim());
  if (!title) return null;
  const when = [raw.created_at, raw.updated_at, raw.publishedAt, raw.published_at].find((v) => typeof v === 'string' && Number.isFinite(Date.parse(v)));
  const url = typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url.trim()) && raw.url.length <= 500 ? raw.url.trim() : '';
  const symbols = Array.isArray(raw.symbols) ? raw.symbols.filter((s) => typeof s === 'string').map(canonKey) : [];
  return {
    title: title.trim().slice(0, 300),
    url,
    publishedAt: when ? new Date(when).toISOString() : null,
    source: typeof raw.source === 'string' ? raw.source.slice(0, 40) : typeof raw.author === 'string' ? raw.author.slice(0, 40) : '',
    symbols,
  };
}

/** Group normalised items per requested symbol: newest first, within the window, de-duplicated, at most `max` each. */
export function groupHeadlines(items, symbols, { now = Date.now(), hours = HEADLINE_WINDOW_HOURS, max = MAX_HEADLINES_PER_SYMBOL } = {}) {
  const cutoff = now - hours * 3600_000;
  const byKey = new Map(symbols.map((s) => [canonKey(s), s]));
  const out = new Map(symbols.map((s) => [s, []]));
  const seen = new Map(symbols.map((s) => [s, new Set()]));
  const sorted = items.filter(Boolean).sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  for (const it of sorted) {
    if (it.publishedAt && Date.parse(it.publishedAt) < cutoff) continue;
    for (const k of it.symbols) {
      const sym = byKey.get(k);
      if (!sym) continue;
      const list = out.get(sym);
      const key = normTitle(it.title);
      if (!key || list.length >= max || seen.get(sym).has(key)) continue;
      seen.get(sym).add(key);
      list.push({ title: it.title, url: it.url, publishedAt: it.publishedAt, source: it.source });
    }
  }
  return out;
}

async function fetchBatch(symbols, now) {
  const names = symbols.map(toNewsSymbol);
  const ck = `${names.join(',')}|${Math.floor(now / CACHE_TTL_MS)}`;
  const hit = cache.get(ck);
  if (hit) return hit;
  const items = [];
  let token = '';
  for (let page = 0; page < 2; page++) {
    const q = new URLSearchParams({ symbols: names.join(','), limit: String(PAGE_LIMIT), start: new Date(now - HEADLINE_WINDOW_HOURS * 3600_000).toISOString(), sort: 'desc', ...(token ? { page_token: token } : {}) });
    const body = await getJson('alpaca-news', `https://${NEWS_HOST}/v1beta1/news?${q}`, {
      headers: { 'APCA-API-KEY-ID': config.alpaca.key, 'APCA-API-SECRET-KEY': config.alpaca.secret },
      allowedHosts: [NEWS_HOST],
    });
    const list = Array.isArray(body?.news) ? body.news : Array.isArray(body) ? body : [];
    for (const raw of list) items.push(normalizeItem(raw));
    token = typeof body?.next_page_token === 'string' ? body.next_page_token : '';
    if (!token || list.length < PAGE_LIMIT) break;
  }
  setCapped(cache, ck, items, 100);
  return items;
}

/**
 * Headlines for many symbols. Returns { available, headlines: Map(symbol -> [{title,url,publishedAt,source}]), failedBatches, total, error }.
 * `available` is false when there are no Alpaca credentials (and MOCK_NEWS is off). Never throws: a failed batch leaves its symbols empty.
 */
export async function getHeadlines(symbols, { now = Date.now() } = {}) {
  const res = { available: true, headlines: new Map(symbols.map((s) => [s, []])), failedBatches: 0, total: 0, error: null };
  if (mockNewsEnabled()) {
    for (const s of symbols) res.headlines.set(s, mockHeadlines(s, now));
  } else if (!hasAlpacaCredentials()) {
    return { ...res, available: false, error: 'no Alpaca credentials' };
  } else {
    const batches = [];
    for (let i = 0; i < symbols.length; i += BATCH) batches.push(symbols.slice(i, i + BATCH));
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, batches.length) }, async () => {
        while (next < batches.length) {
          const b = batches[next++];
          try {
            const grouped = groupHeadlines(await fetchBatch(b, now), b, { now });
            for (const [s, list] of grouped) res.headlines.set(s, list);
          } catch (err) {
            res.failedBatches += 1;
            res.error = err?.message || 'news fetch failed';
          }
        }
      }),
    );
  }
  for (const list of res.headlines.values()) res.total += list.length;
  return res;
}
