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
    source: 'rules', openedAt, expiresAt: new Date(new Date(openedAt).getTime() + 24 * HOUR).toISOString(), ...over,
  };
  store.setPositions([p, ...store.getPositions()]);
  return p.id;
}
