import { config, hasAlpacaCredentials } from '../config.js';
import { loggedFetch } from './http.js';
import { validateBars } from './bars.js';
import { isCrypto, assetClassOf, isStale } from './market.js';

function seed(symbol) {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return h;
}

const STEP_MS = { '1Hour': 3600_000, '1Day': 86_400_000 };

function mockBars(symbol, limit = 100, timeframe = '1Hour') {
  const s = seed(symbol);
  const step = STEP_MS[timeframe] || 3600_000;
  const base =
    symbol.includes('BTC') ? 68000 :
    symbol.includes('ETH') ? 3400 :
    symbol.includes('SOL') ? 145 :
    symbol === 'SPY' ? 565 :
    symbol === 'QQQ' ? 490 :
    symbol === 'IWM' ? 220 :
    80 + (s % 400);
  const bars = [];
  let price = base;
  const now = Date.now();
  for (let i = limit; i >= 0; i--) {
    const drift = Math.sin((s + i) / 7) * 0.004 + ((s % 17) - 8) * 0.0002;
    const open = price;
    const close = price * (1 + drift + ((i % 5) - 2) * 0.0015);
    const high = Math.max(open, close) * (1 + 0.002 + (i % 3) * 0.001);
    const low = Math.min(open, close) * (1 - 0.002 - (i % 4) * 0.0008);
    const volume = 500000 + ((s + i * 997) % 2000000);
    bars.push({
      t: new Date(now - i * step).toISOString(),
      o: +open.toFixed(4),
      h: +high.toFixed(4),
      l: +low.toFixed(4),
      c: +close.toFixed(4),
      v: volume,
    });
    price = close;
  }
  return bars;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter; honours a Retry-After header (seconds), capped. */
export function backoffMs(attempt, retryAfter, rand = Math.random) {
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 15_000);
  return Math.min(400 * 2 ** attempt + rand() * 250, 8_000);
}

const MAX_ATTEMPTS = 4;

/** GET against Alpaca with retry on network errors, 429 and 5xx. */
async function alpacaFetch(urlPath, { data = true } = {}) {
  const base = data ? config.alpaca.dataUrl : config.alpaca.baseUrl;
  const headers = { 'APCA-API-KEY-ID': config.alpaca.key, 'APCA-API-SECRET-KEY': config.alpaca.secret };
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let retryAfter;
    try {
      const res = await loggedFetch('alpaca', `${base}${urlPath}`, { headers });
      if (res.ok) return await res.json();
      const text = await res.text();
      lastErr = new Error(`Alpaca ${res.status}: ${text.slice(0, 200)}`);
      if (res.status !== 429 && res.status < 500) throw Object.assign(lastErr, { fatal: true });
      retryAfter = res.headers.get('retry-after');
    } catch (err) {
      if (err.fatal) throw err;
      lastErr = err;
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(backoffMs(attempt, retryAfter));
  }
  throw lastErr;
}

const toAlpacaCrypto = (s) => (s.includes('/') ? s : `${s.slice(0, -3)}/${s.slice(-3)}`);
const LOOKBACK_DAYS = { equity: { '1Hour': 30, '1Day': 90 }, crypto: { '1Hour': 7, '1Day': 90 } };

/** Multi-symbol bars (paginated). Returns Map(symbol -> raw bars ascending). Symbols must share an asset class. */
async function fetchBatch(symbols, timeframe) {
  const crypto = isCrypto(symbols[0]);
  const names = symbols.map((s) => (crypto ? toAlpacaCrypto(s) : s));
  const back = LOOKBACK_DAYS[crypto ? 'crypto' : 'equity'][timeframe] || 30;
  const out = new Map();
  let token = '';
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({
      symbols: names.join(','),
      timeframe,
      limit: '10000',
      start: new Date(Date.now() - back * 86400_000).toISOString(),
      sort: 'asc',
      ...(crypto ? {} : { adjustment: 'split', feed: 'iex' }),
      ...(token ? { page_token: token } : {}),
    });
    const data = await alpacaFetch(`${crypto ? '/v1beta3/crypto/us/bars' : '/v2/stocks/bars'}?${q}`);
    for (const [name, bars] of Object.entries(data.bars || {})) {
      const sym = symbols.find((s) => s === name || toAlpacaCrypto(s) === name) || name;
      out.set(sym, (out.get(sym) || []).concat(bars));
    }
    token = data.next_page_token;
    if (!token) break;
  }
  return out;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // `${symbol}|${timeframe}` -> { at, limit, bars }
// Symbols whose last live fetch failed and were served mock data instead.
const fallbacks = new Map();
// symbol -> true when the latest live bar is stale (closed market / old data)
const staleMap = new Map();

function remember(symbol, timeframe, limit, rawBars) {
  const { bars } = validateBars(rawBars);
  if (!bars.length) return null;
  cache.set(`${symbol}|${timeframe}`, { at: Date.now(), limit, bars: bars.slice(-limit) });
  fallbacks.delete(symbol);
  if (timeframe === '1Hour') staleMap.set(symbol, isStale(symbol, bars[bars.length - 1].t));
  return bars.slice(-limit);
}

export const alpaca = {
  getFallbacks() {
    return {
      count: fallbacks.size,
      symbols: [...fallbacks.entries()].map(([symbol, f]) => ({ symbol, ...f })),
    };
  },

  /** Symbols currently served from stale data (equities outside the session, or old bars). */
  getStale() {
    return [...staleMap.entries()].filter(([, v]) => v).map(([k]) => k);
  },

  isStale(symbol) {
    return !this.usingMock() && Boolean(staleMap.get(symbol));
  },

  usingMock() {
    return config.useMockData || !hasAlpacaCredentials();
  },

  /** Drop cached bars (start of every run). */
  clearCache() {
    cache.clear();
  },

  /** Warm the cache with a few multi-symbol requests instead of one request per symbol. Failures are silent (getBars falls back). */
  async prefetch(symbols, { timeframe = '1Hour', limit = 120 } = {}) {
    if (this.usingMock()) return;
    const groups = [
      symbols.filter((s) => !isCrypto(s)),
      symbols.filter((s) => isCrypto(s)),
    ];
    for (const group of groups) {
      for (let i = 0; i < group.length; i += 25) {
        const chunk = group.slice(i, i + 25);
        try {
          const got = await fetchBatch(chunk, timeframe);
          for (const [sym, bars] of got) remember(sym, timeframe, limit, bars);
        } catch (err) {
          console.warn(`[alpaca] batch bars failed (${chunk.length} symbols): ${err.message}`);
        }
      }
    }
  },

  async getBars(symbol, { timeframe = '1Hour', limit = 100 } = {}) {
    if (this.usingMock()) return mockBars(symbol, limit, timeframe);
    const hit = cache.get(`${symbol}|${timeframe}`);
    if (hit && hit.limit >= limit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bars.slice(-limit);
    try {
      const want = Math.max(limit, 120);
      const got = await fetchBatch([symbol], timeframe);
      const bars = remember(symbol, timeframe, want, got.get(symbol) || []);
      if (!bars) throw new Error('no valid bars returned');
      return bars.slice(-limit);
    } catch (err) {
      // Soft-fallback so the dashboard still works offline / without keys
      console.warn(`[alpaca] bars failed for ${symbol}, using mock:`, err.message);
      fallbacks.set(symbol, { error: err.message, at: new Date().toISOString() });
      return mockBars(symbol, limit, timeframe);
    }
  },

  async getQuote(symbol) {
    const bars = await this.getBars(symbol, { limit: 120 });
    if (!bars.length) return null;
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2] || last;
    const changePct = prev.c ? ((last.c - prev.c) / prev.c) * 100 : 0;
    return {
      symbol,
      price: last.c,
      changePct,
      asOf: last.t,
      assetClass: assetClassOf(symbol),
      stale: this.isStale(symbol),
    };
  },

  async getQuotes(symbols) {
    const out = [];
    for (const symbol of symbols) {
      try {
        const q = await this.getQuote(symbol);
        if (q) out.push(q);
      } catch {
        /* skip */
      }
    }
    return out;
  },

  async getSnapshot(symbol) {
    const bars = await this.getBars(symbol, { limit: 120 });
    const quote = bars.length
      ? {
          symbol,
          price: bars[bars.length - 1].c,
          changePct:
            bars.length > 1
              ? ((bars[bars.length - 1].c - bars[bars.length - 2].c) / bars[bars.length - 2].c) * 100
              : 0,
          asOf: bars[bars.length - 1].t,
          assetClass: assetClassOf(symbol),
          stale: this.isStale(symbol),
        }
      : null;
    return { symbol, bars, quote };
  },
};
