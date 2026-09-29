// Real alpaca.js (no fake helpers): live-mode failures must never be papered over with mock bars.
import './setup.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const { config } = await import('../server/config.js');
const { alpaca, MarketDataError, setCapped } = await import('../server/services/alpaca.js');
const { createApp } = await import('../server/app.js');

const realFetch = globalThis.fetch;
let upstream = () => new Response('unauthorized', { status: 401 });
globalThis.fetch = (url, opts) => (String(url).startsWith('http://127.0.0.1') ? realFetch(url, opts) : Promise.resolve(upstream(String(url))));
after(() => {
  globalThis.fetch = realFetch;
  server.close();
});

const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const goodBars = (n = 60) =>
  Array.from({ length: n }, (_, i) => ({ t: new Date(Date.now() - (n - i) * 3600_000).toISOString(), o: 100, h: 101, l: 99, c: 100.5, v: 10 }));

function live() {
  config.useMockData = false;
  config.alpaca.key = 'k';
  config.alpaca.secret = 's';
}

test('mock mode still serves mock bars', async () => {
  config.useMockData = true;
  const bars = await alpaca.getBars('AAPL', { limit: 50 });
  assert.ok(bars.length > 30);
});

test('LIVE fetch failure throws MarketDataError (no mock bars) and is reported in fallbacks', async () => {
  live();
  upstream = () => new Response('unauthorized', { status: 401 }); // fatal, no retries
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(alpaca.getBars('AAPL', { limit: 50 }), (e) => e instanceof MarketDataError && e.status === 502 && e.code === 'market_data_unavailable' && e.symbol === 'AAPL');
    await assert.rejects(alpaca.getQuote('AAPL'), (e) => e.code === 'market_data_unavailable');
  } finally {
    console.warn = warn;
  }
  const fb = alpaca.getFallbacks();
  assert.equal(fb.count, 1);
  assert.equal(fb.symbols[0].symbol, 'AAPL');
  // HTTP: 502 on the market route; health still lists the failed symbol
  const r = await realFetch(`${base}/api/market/quote/AAPL`);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, 'market_data_unavailable');
  const h = await (await realFetch(`${base}/api/health`)).json();
  assert.equal(h.fallbacks.symbols[0].symbol, 'AAPL');
});

test('a later successful fetch clears the failed marker', async () => {
  live();
  upstream = (url) => {
    const syms = new URL(url).searchParams.get('symbols').split(',');
    return Response.json({ bars: Object.fromEntries(syms.map((s) => [s, goodBars()])) });
  };
  const bars = await alpaca.getBars('AAPL', { limit: 50 });
  assert.equal(bars.length, 50);
  assert.equal(alpaca.getFallbacks().count, 0);
});

test('caches are size-capped (LRU) no matter how many symbols are requested', async () => {
  live();
  for (let i = 0; i < 700; i++) await alpaca.getBars(`SYM${i}`, { limit: 20 });
  const s = alpaca._sizes();
  assert.ok(s.cache <= 600 && s.stale <= 600 && s.fallbacks <= 600, JSON.stringify(s));
  const m = new Map();
  for (let i = 0; i < 10; i++) setCapped(m, i, i, 3);
  assert.deepEqual([...m.keys()], [7, 8, 9]);
  setCapped(m, 7, 'x', 3); // refresh recency
  setCapped(m, 10, 1, 3);
  assert.deepEqual([...m.keys()], [9, 7, 10]);
  config.useMockData = true;
});
