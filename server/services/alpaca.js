import { config, hasAlpacaCredentials } from '../config.js';

const UNIVERSE = {
  stocks: [
    'SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA',
    'AMD', 'NFLX', 'COIN', 'PLTR', 'CRM', 'AVGO', 'JPM', 'BAC', 'XOM', 'UNH',
    'COST', 'DIS', 'BA', 'UBER', 'SHOP', 'XYZ', 'SOFI', 'RIVN', 'SMCI', 'ARM',
  ],
  crypto: [
    'BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD', 'LINK/USD', 'DOGE/USD',
    'DOT/USD', 'LTC/USD', 'UNI/USD', 'AAVE/USD',
  ],
};

function seed(symbol) {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return h;
}

function mockBars(symbol, limit = 100) {
  const s = seed(symbol);
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
      t: new Date(now - i * 3600_000).toISOString(),
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

async function alpacaFetch(urlPath, { data = true } = {}) {
  const base = data ? config.alpaca.dataUrl : config.alpaca.baseUrl;
  const res = await fetch(`${base}${urlPath}`, {
    headers: {
      'APCA-API-KEY-ID': config.alpaca.key,
      'APCA-API-SECRET-KEY': config.alpaca.secret,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Alpaca defaults `start` to the current day, which yields too few bars on
// weekends / pre-market. Ask for a window and take the newest bars (sort=desc).
function lookbackStart(days = 30) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

function isCrypto(symbol) {
  return symbol.includes('/') || symbol.endsWith('USD') && ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'DOGE', 'DOT', 'LTC', 'UNI', 'AAVE'].some((c) => symbol.startsWith(c));
}

// Symbols whose last live fetch failed and were served mock data instead.
const fallbacks = new Map();

export const alpaca = {
  universe: UNIVERSE,

  getFallbacks() {
    return {
      count: fallbacks.size,
      symbols: [...fallbacks.entries()].map(([symbol, f]) => ({ symbol, ...f })),
    };
  },

  usingMock() {
    return config.useMockData || !hasAlpacaCredentials();
  },

  async getBars(symbol, { timeframe = '1Hour', limit = 100 } = {}) {
    if (this.usingMock()) return mockBars(symbol, limit);

    try {
      if (isCrypto(symbol)) {
        const sym = symbol.includes('/') ? symbol : `${symbol.slice(0, -3)}/${symbol.slice(-3)}`;
        const q = new URLSearchParams({
          timeframe: timeframe === '1Hour' ? '1Hour' : timeframe,
          limit: String(limit),
          start: lookbackStart(),
          sort: 'desc',
        });
        const data = await alpacaFetch(`/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(sym)}&${q}`);
        const bars = data.bars?.[sym] || data.bars?.[symbol] || [];
        if (!bars.length) throw new Error('no bars returned');
        fallbacks.delete(symbol);
        return bars.reverse().map((b) => ({
          t: b.t,
          o: b.o,
          h: b.h,
          l: b.l,
          c: b.c,
          v: b.v,
        }));
      }

      const q = new URLSearchParams({
        timeframe,
        limit: String(limit),
        adjustment: 'split',
        feed: 'iex',
        start: lookbackStart(),
        sort: 'desc',
      });
      const data = await alpacaFetch(`/v2/stocks/${encodeURIComponent(symbol)}/bars?${q}`);
      if (!data.bars?.length) throw new Error('no bars returned');
      fallbacks.delete(symbol);
      return data.bars.reverse().map((b) => ({
        t: b.t,
        o: b.o,
        h: b.h,
        l: b.l,
        c: b.c,
        v: b.v,
      }));
    } catch (err) {
      // Soft-fallback so the dashboard still works offline / without keys
      console.warn(`[alpaca] bars failed for ${symbol}, using mock:`, err.message);
      fallbacks.set(symbol, { error: err.message, at: new Date().toISOString() });
      return mockBars(symbol, limit);
    }
  },

  async getQuote(symbol) {
    const bars = await this.getBars(symbol, { limit: 2 });
    if (!bars.length) return null;
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2] || last;
    const changePct = prev.c ? ((last.c - prev.c) / prev.c) * 100 : 0;
    return {
      symbol,
      price: last.c,
      changePct,
      asOf: last.t,
      assetClass: isCrypto(symbol) ? 'crypto' : 'equity',
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
          assetClass: isCrypto(symbol) ? 'crypto' : 'equity',
        }
      : null;
    return { symbol, bars, quote };
  },
};
