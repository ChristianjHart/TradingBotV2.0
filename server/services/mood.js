// Live market mood: a homemade 0-100 fear/greed-style index built ONLY from market data the app already fetches (no extra provider,
// no AI cost). It is NOT CNN's Fear & Greed index and says so. Components: SPY trend, SPY short-term momentum, market breadth
// (share of the stock universe above its 20-day average), new highs vs lows, volatility regime, and Bitcoin momentum.
import { alpaca } from './alpaca.js';
import { STOCKS } from './universe.js';
import { dailyContext, marketRegime } from './context.js';
import { usMarketOpen } from './market.js';

const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
/** Linear map of x from [lo, hi] to [0, 100], clamped. */
export const scale = (x, lo, hi) => clamp(((x - lo) / (hi - lo)) * 100);
const r1 = (n) => Math.round(n * 10) / 10;
const stdev = (a) => {
  if (a.length < 2) return null;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

export const LEVELS = [
  { max: 20, id: 'extreme-fear', label: 'Extreme fear', emoji: '😱' },
  { max: 40, id: 'fear', label: 'Fear', emoji: '😟' },
  { max: 60, id: 'neutral', label: 'Neutral', emoji: '😐' },
  { max: 80, id: 'greed', label: 'Greed', emoji: '🙂' },
  { max: 101, id: 'extreme-greed', label: 'Extreme greed', emoji: '🤑' },
];
export const levelOf = (score) => LEVELS.find((l) => score < l.max);

export const WEIGHTS = { trend: 0.2, momentum: 0.15, breadth: 0.25, highsLows: 0.15, volatility: 0.15, crypto: 0.1 };

/** Volatility regime: ratio of the last 10 daily-return stdevs to the previous 30. Calm (<=0.7) is greedy, elevated (>=1.6) fearful. */
export function volRatio(closes) {
  if (!closes || closes.length < 25) return null;
  const rets = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const recent = stdev(rets.slice(-10));
  const prior = stdev(rets.slice(0, -10));
  return recent !== null && prior ? recent / prior : null;
}

/**
 * Pure. Inputs: ctx = dailyContext() of SPY/BTC, closes = SPY daily closes, breadth = { above, total, nearHigh, nearLow } over the stock universe.
 * Returns { score, level, components:[{id,label,score,detail}] } renormalising over the components that could be computed; null score when none could.
 */
export function moodFrom({ spy, btc, spyCloses, breadth }) {
  const comps = [];
  if (spy) {
    comps.push({ id: 'trend', label: 'SPY trend (20 days)', score: scale(spy.ret20d, -6, 6) * 0.85 + (spy.aboveSma20 ? 15 : 0), detail: `${spy.ret20d >= 0 ? '+' : ''}${spy.ret20d}% over 20 days, ${spy.aboveSma20 ? 'above' : 'below'} its 20-day average` });
    comps.push({ id: 'momentum', label: 'SPY momentum (5 days)', score: scale(spy.ret5d, -3, 3), detail: `${spy.ret5d >= 0 ? '+' : ''}${spy.ret5d}% over 5 days` });
  }
  if (breadth && breadth.total >= 10) {
    comps.push({ id: 'breadth', label: 'Breadth', score: (breadth.above / breadth.total) * 100, detail: `${breadth.above} of ${breadth.total} stocks above their 20-day average` });
    const hl = breadth.nearHigh + breadth.nearLow;
    comps.push({ id: 'highsLows', label: 'Highs vs lows', score: hl ? (breadth.nearHigh / hl) * 100 : 50, detail: `${breadth.nearHigh} near 20-day highs, ${breadth.nearLow} near lows` });
  }
  const vr = volRatio(spyCloses);
  if (vr !== null) comps.push({ id: 'volatility', label: 'Volatility', score: 100 - scale(vr, 0.7, 1.6), detail: vr >= 1.3 ? `SPY swings are ${vr.toFixed(1)}x its recent norm (fear)` : vr <= 0.8 ? 'SPY swings are calm (greed)' : 'SPY swings are normal' });
  if (btc) comps.push({ id: 'crypto', label: 'Bitcoin momentum', score: scale(btc.ret5d, -8, 8), detail: `BTC ${btc.ret5d >= 0 ? '+' : ''}${btc.ret5d}% over 5 days` });
  const wsum = comps.reduce((s, c) => s + WEIGHTS[c.id], 0);
  if (!wsum) return { score: null, level: null, components: [] };
  const score = Math.round(comps.reduce((s, c) => s + c.score * WEIGHTS[c.id], 0) / wsum);
  return { score, level: levelOf(score), components: comps.map((c) => ({ ...c, score: Math.round(c.score), weight: WEIGHTS[c.id] })) };
}

const INDEXES = ['SPY', 'QQQ', 'IWM', 'BTC/USD'];
const SLOW_TTL = 5 * 60_000;
let slow = null; // { at, spy, btc, spyCloses, breadth }
export const _clearMoodCache = () => (slow = null);

async function slowInputs(now) {
  if (slow && now - slow.at < SLOW_TTL) return slow;
  await alpaca.prefetch(STOCKS, { timeframe: '1Day', limit: 40 });
  const daily = async (s) => alpaca.getBars(s, { timeframe: '1Day', limit: 40 }).catch(() => []);
  const spyBars = await daily('SPY');
  const btcBars = await daily('BTC/USD');
  const breadth = { above: 0, total: 0, nearHigh: 0, nearLow: 0 };
  let i = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (i < STOCKS.length) {
        const bars = await daily(STOCKS[i++]);
        const c = dailyContext(bars);
        if (!c) continue;
        breadth.total += 1;
        if (c.aboveSma20) breadth.above += 1;
        if (c.distHigh20 >= -2) breadth.nearHigh += 1;
        if (c.distLow20 <= 2) breadth.nearLow += 1;
      }
    }),
  );
  slow = { at: now, spy: dailyContext(spyBars), btc: dailyContext(btcBars), spyCloses: spyBars.map((b) => b.c), breadth };
  return slow;
}

/** The /api/mood payload: index + live index quotes. Never throws (a failed part is omitted). */
export async function getMood({ now = Date.now() } = {}) {
  let idx = { score: null, level: null, components: [] };
  let regime = null;
  try {
    const s = await slowInputs(now);
    idx = moodFrom(s);
    regime = marketRegime(s.spy, s.btc).label;
  } catch {
    /* quotes below may still work */
  }
  const quotes = (await alpaca.getQuotes(INDEXES).catch(() => [])).map((q) => ({ symbol: q.symbol, price: q.price, changePct: +Number(q.changePct).toFixed(2), stale: Boolean(q.stale) }));
  return { ...idx, ...(idx.level ? { label: idx.level.label, emoji: idx.level.emoji } : {}), regime, quotes, marketOpen: usMarketOpen(new Date(now)), asOf: new Date(now).toISOString(), mock: alpaca.usingMock(), note: 'Homemade index from this app’s own market data. Not CNN’s Fear & Greed.' };
}
