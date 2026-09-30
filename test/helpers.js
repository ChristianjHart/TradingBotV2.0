// Deterministic fake market data: replaces the network-facing methods of the shared `alpaca` object.
const { alpaca } = await import('../server/services/alpaca.js');

export const HOUR = 3600_000;
export const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();
export const bar = (hoursAgo, o, h, l, c) => ({ t: ago(hoursAgo), o, h, l, c, v: 1000 });

export const fake = {
  bars: new Map(), // symbol -> bars[]
  stale: new Set(),
  fail: new Set(), // symbols whose bar fetch throws
  delayMs: new Map(),
  price: 100, // default price for symbols without explicit bars
};

export function resetFake() {
  fake.bars.clear();
  fake.stale.clear();
  fake.fail.clear();
  fake.delayMs.clear();
  fake.price = 100;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flat(symbol, limit) {
  return Array.from({ length: Math.min(limit, 120) }, (_, i) => {
    const k = Math.min(limit, 120) - i;
    const p = fake.price * (1 + Math.sin(k / 5 + symbol.length) * 0.004);
    return { t: ago(k), o: p, h: p * 1.003, l: p * 0.997, c: p, v: 1000 };
  });
}

alpaca.getBars = async function (symbol, { limit = 100 } = {}) {
  if (fake.delayMs.has(symbol)) await sleep(fake.delayMs.get(symbol));
  if (fake.fail.has(symbol)) throw new Error('boom');
  const b = fake.bars.get(symbol) || flat(symbol, limit);
  return b.slice(-limit);
};
alpaca.isStale = (symbol) => fake.stale.has(symbol);
alpaca.prefetch = async () => {};
alpaca.clearCache = () => {};
// getQuote / getSnapshot from the real object build on getBars + isStale.

let n = 0;
export function mkPos(store, over = {}) {
  const openedAt = over.openedAt || ago(5);
  const p = {
    id: `pos_test_${++n}`, symbol: 'AAA', side: 'long', status: 'open', entry: 100, stopLoss: 95, initialStop: 95,
    takeProfit: 110, allocation: 1000, qty: 10, fees: 0, slippage: 0, trailing: false, confidence: 0.7, reason: 't',
    source: 'ai', openedAt, expiresAt: new Date(new Date(openedAt).getTime() + 24 * HOUR).toISOString(), ...over,
  };
  store.setPositions([p, ...store.getPositions()]);
  return p.id;
}

// ---- scripted OpenRouter (stubbed global fetch): the sandbox has no egress, and tests must be deterministic ----
const { config } = await import('../server/config.js');
export const realFetch = globalThis.fetch;
export const TEST_KEY = 'sk-or-test-key-000111';

/** A chat-completions reply. `cost` (USD) is reported in usage.cost when given. */
export function chatReply(content, { prompt = 1000, completion = 500, cost, headers } = {}) {
  const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  if (cost !== undefined) usage.cost = cost;
  return Response.json({ id: 'gen-1', choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }], usage }, { headers });
}

/** The canned "model" used by tests: scanner -> first 30 rows alternating long/short; trader -> confidence-weighted 2 ATR / 3.5 ATR trades. */
export function defaultModelReply(body) {
  const sys = body.messages[0].content;
  const input = JSON.parse(body.messages[1].content);
  if (/news and earnings analyst/.test(sys)) {
    return { notes: input.untrusted_news_data.map((x) => ({ symbol: x.symbol, sentiment: 0.4, catalyst: 'test catalyst', earningsInDays: x.earningsInDays, riskFlags: [], summary: 'test summary', sources: x.headlines.slice(0, 1).map((h) => ({ id: h.id })) })) };
  }
  if (/screener/.test(sys)) {
    return {
      picks: input.rows.slice(0, 30).map((r, i) => ({ symbol: r.symbol, direction: i % 2 === 0 || r.symbol.includes('/') ? 'long' : 'short', confidence: 0.8 - i * 0.01, reason: 'test pick' })),
    };
  }
  const cands = input.candidates;
  const w = cands.map((c) => Math.max(0.05, (c.confidence || 0) - 0.35));
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return {
    summary: 'test desk',
    trades: cands.slice(0, input.freeSlots).map((c, i) => {
      const atr = c.price * ((c.atrPct || 1.5) / 100);
      const dir = c.direction === 'long' ? 1 : -1;
      return { symbol: c.symbol, side: c.direction, stopLoss: c.price - dir * atr * 2, takeProfit: c.price + dir * atr * 3.5, allocationUsd: (input.account.cash * 0.95 * w[i]) / sum, reason: `test: ${c.reason}` };
    }),
  };
}

/**
 * Install a fake OpenRouter. `handler(body, n, url)` returns a Response, a plain object (sent as the model's JSON content) or a
 * string; default = defaultModelReply. `models` = raw /models body (or a function). Loopback requests (the app under test) pass through.
 * Returns { calls (chat bodies), urls (every non-loopback url), restore() }.
 */
export function stubOpenRouter(handler = defaultModelReply, { models, key = TEST_KEY } = {}) {
  const calls = [];
  const urls = [];
  config.openrouter.key = key;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) return realFetch(url, opts);
    urls.push(u);
    if (u.startsWith('https://openrouter.ai/api/v1/models')) {
      const m = typeof models === 'function' ? await models(u) : models;
      return m instanceof Response ? m : Response.json(m ?? { data: [] });
    }
    if (u.endsWith('/chat/completions')) {
      const body = JSON.parse(opts.body);
      calls.push(body);
      const r = await handler(body, calls.length, u);
      if (r instanceof Response) return r;
      return chatReply(typeof r === 'string' ? r : JSON.stringify(r));
    }
    return realFetch(url, opts);
  };
  return {
    calls,
    urls,
    restore() {
      globalThis.fetch = realFetch;
      config.openrouter.key = '';
    },
  };
}
