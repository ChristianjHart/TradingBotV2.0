// Finnhub earnings calendar client. The key is sent ONLY in the `X-Finnhub-Token` header (never in the URL, so it can never reach a log
// line, a proxy URL log or an error message). Crypto has no earnings. Responses are parsed defensively.
import { config, hasFinnhubKey } from '../config.js';
import { getJson, UpstreamError } from './upstream.js';
import { isCrypto } from './market.js';
import { mockNewsEnabled, mockEarningsInDays } from './mockNews.js';
import { setCapped } from './alpaca.js';

export const FINNHUB_HOST = 'finnhub.io';
const BASE = `https://${FINNHUB_HOST}/api/v1`;
const CACHE_TTL_MS = 6 * 3600_000;
const cache = new Map(); // SYMBOL -> { at, date:'YYYY-MM-DD'|null, hour }
export const _clearFinnhubCache = () => cache.clear();

const DAY = 86_400_000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

/** Whole days from today (UTC date) to `date` ('YYYY-MM-DD...'); null when unparseable. */
export function daysUntil(date, now = Date.now()) {
  if (typeof date !== 'string' || !ISO_DAY.test(date)) return null;
  const t = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - Date.parse(`${ymd(now)}T00:00:00Z`)) / DAY);
}

/** Earliest upcoming (today or later) report in a raw Finnhub body. Tolerates missing/odd shapes: returns { date, hour } or null. */
export function parseEarnings(body, symbol, now = Date.now()) {
  const list = Array.isArray(body?.earningsCalendar) ? body.earningsCalendar : Array.isArray(body) ? body : [];
  let best = null;
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.symbol === 'string' && symbol && e.symbol.toUpperCase() !== symbol.toUpperCase()) continue;
    const d = daysUntil(e.date, now);
    if (d === null || d < 0) continue;
    if (!best || d < best.d) best = { d, date: e.date.slice(0, 10), hour: typeof e.hour === 'string' ? e.hour.slice(0, 8) : null };
  }
  return best ? { date: best.date, hour: best.hour } : null;
}

/** One symbol's next earnings date. Returns { date, hour } | null (none in the window). Throws UpstreamError on failure. */
async function nextEarnings(symbol, now) {
  const hit = cache.get(symbol);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const q = new URLSearchParams({ from: ymd(now), to: ymd(now + 21 * DAY), symbol });
  const body = await getJson('finnhub', `${BASE}/calendar/earnings?${q}`, { headers: { 'X-Finnhub-Token': config.finnhub.key }, allowedHosts: [FINNHUB_HOST] });
  const value = parseEarnings(body, symbol, now);
  setCapped(cache, symbol, { at: now, value }, 500);
  return value;
}

/**
 * Earnings for many symbols. Returns { available, earnings: Map(symbol -> { date, hour, inDays } | null), known: n, failed: n, error }
 * `earnings` has an entry only for symbols whose lookup SUCCEEDED (null = no report in the next 3 weeks; crypto is always null).
 * `available` is false when there is no key / the key was rejected. Never throws.
 */
export async function getEarnings(symbols, { now = Date.now() } = {}) {
  const earnings = new Map();
  const out = { available: true, earnings, known: 0, failed: 0, error: null };
  if (mockNewsEnabled()) {
    for (const s of symbols) {
      const d = isCrypto(s) ? null : mockEarningsInDays(s);
      earnings.set(s, d === null ? null : { date: ymd(now + d * DAY), hour: null, inDays: d });
      out.known += 1;
    }
    return out;
  }
  if (!hasFinnhubKey()) return { ...out, available: false, error: 'no Finnhub key' };
  const todo = [];
  for (const s of symbols) {
    if (isCrypto(s)) {
      earnings.set(s, null);
      out.known += 1;
    } else todo.push(s);
  }
  let i = 0;
  let stop = false;
  await Promise.all(
    Array.from({ length: Math.min(4, todo.length) }, async () => {
      while (i < todo.length && !stop) {
        const s = todo[i++];
        try {
          const v = await nextEarnings(s, now);
          earnings.set(s, v ? { ...v, inDays: daysUntil(v.date, now) } : null);
          out.known += 1;
        } catch (err) {
          out.failed += 1;
          out.error = err instanceof UpstreamError ? err.message : 'finnhub lookup failed';
          if (err?.code === 'key_rejected') {
            stop = true;
            out.available = false;
          }
        }
      }
    }),
  );
  return out;
}

/** Minimal real call for POST /api/account/test. Returns the HTTP status. The key goes in the header only. */
export async function pingFinnhub() {
  const now = Date.now();
  const q = new URLSearchParams({ from: ymd(now), to: ymd(now + DAY), symbol: 'AAPL' });
  await getJson('finnhub', `${BASE}/calendar/earnings?${q}`, { headers: { 'X-Finnhub-Token': config.finnhub.key }, allowedHosts: [FINNHUB_HOST] });
  return true;
}
