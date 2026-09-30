// DEV / TEST FIXTURE ONLY. MOCK_NEWS=true swaps the Alpaca-news and Finnhub HTTP clients for deterministic canned data. Like MOCK_LLM it is
// refused (ignored + loud warning) in production/Render, and is never used automatically.
import { config } from '../config.js';
import { store } from '../db/store.js';

let warned = false;

export function mockNewsEnabled() {
  if (!config.news.mockRequested) return false;
  if (config.isProduction) {
    if (!warned) {
      warned = true;
      const msg = 'MOCK_NEWS=true is REFUSED in production/Render: the canned news/earnings fixture is a dev/test tool only and is being ignored. Remove MOCK_NEWS from the environment.';
      console.warn(`\n[security] WARNING: ${msg}\n`);
      try {
        store.addLog({ level: 'error', message: msg });
      } catch {
        /* logging must never throw */
      }
    }
    return false;
  }
  return true;
}

export const _resetMockNewsWarning = () => {
  warned = false;
};

const seed = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};
const canon = (s) => String(s).replace('/', '');
const HOUR = 3600_000;

/** Deterministic headlines for a symbol: 3 items, 2h / 10h / 30h old. */
export function mockHeadlines(symbol, now = Date.now()) {
  const c = canon(symbol);
  return [
    ['DEMO: %s shares move on analyst commentary', 2],
    ['DEMO: %s sector outlook in focus ahead of data', 10],
    ['DEMO: %s trading volume picks up', 30],
  ].map(([t, h], i) => ({
    title: t.replace('%s', c),
    url: `https://news.example.com/demo/${c.toLowerCase()}/${i + 1}`,
    publishedAt: new Date(now - h * HOUR).toISOString(),
    source: 'mock',
  }));
}

/** Deterministic earnings date: 1 in 4 symbols reports in 1 day, 1 in 4 in 5 days, the rest have none in the window. */
export function mockEarningsInDays(symbol) {
  const k = seed(canon(symbol)) % 4;
  return k === 0 ? 1 : k === 1 ? 5 : null;
}
