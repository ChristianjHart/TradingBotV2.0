import { alpaca } from './alpaca.js';
import { extractFeatures, atr } from './indicators.js';
import { predictFromBars, rankCandidates } from './predictor.js';
import { chatJson } from './openrouter.js';
import { UNIVERSE } from './universe.js';
import { dailyContext, relStrength, marketRegime } from './context.js';
import { cleanPicks } from './picks.js';
import { isCrypto } from './market.js';
import { config, hasOpenRouterKey } from '../config.js';
import { store } from '../db/store.js';
import { insert } from '../db/supabase.js';

const TOP_N = 100;

async function mapPool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/** Pull hourly + daily bars for the whole universe (batched, cached) and reduce each symbol to a compact feature row. */
export async function gatherMarketData() {
  await alpaca.prefetch(UNIVERSE, { timeframe: '1Hour', limit: 120 });
  await alpaca.prefetch(UNIVERSE, { timeframe: '1Day', limit: 40 });
  const rows = await mapPool(UNIVERSE, 8, async (symbol) => {
    try {
      const { bars } = await alpaca.getSnapshot(symbol);
      if (!bars || bars.length < 30) return null;
      const daily = await alpaca.getBars(symbol, { timeframe: '1Day', limit: 40 }).catch(() => []);
      const f = extractFeatures(bars);
      const a = atr(bars);
      return {
        symbol,
        bars,
        price: f.price,
        atrPct: a ? +((a / f.price) * 100).toFixed(2) : null,
        ctx: dailyContext(daily),
        row: {
          symbol,
          price: +f.price.toFixed(4),
          mom5: +(f.momentum5 * 100).toFixed(2),
          mom20: +(f.momentum20 * 100).toFixed(2),
          rsi: +f.rsi.toFixed(1),
          macdHist: +f.macdHist.toFixed(4),
          volRatio: +f.volumeRatio.toFixed(2),
          volPct: +(f.volatility * 100).toFixed(2),
          trend: +(f.trend * 100).toFixed(2),
        },
      };
    } catch {
      return null;
    }
  });
  const data = rows.filter(Boolean);
  const bySym = new Map(data.map((d) => [d.symbol, d]));
  const spy = bySym.get('SPY')?.ctx;
  const btc = bySym.get('BTC/USD')?.ctx;
  for (const d of data) {
    if (!d.ctx) continue;
    const rs = relStrength(d.ctx, isCrypto(d.symbol) ? btc : spy);
    Object.assign(d.row, {
      ret5d: d.ctx.ret5d,
      ret20d: d.ctx.ret20d,
      fromHigh20: d.ctx.distHigh20,
      fromLow20: d.ctx.distLow20,
      ...(rs && d.symbol !== 'SPY' && d.symbol !== 'BTC/USD' ? rs : {}),
    });
  }
  return { data, regime: marketRegime(spy, btc) };
}

function heuristicPicks(data) {
  const preds = data.map((d) => predictFromBars(d.symbol, d.bars));
  return rankCandidates(preds)
    .slice(0, TOP_N)
    .map((p) => ({
      symbol: p.symbol,
      direction: p.direction,
      confidence: p.confidence,
      reason: p.reasons.slice(0, 2).join('; '),
    }));
}

const SYSTEM = `You are a quantitative market screener. You receive a market regime line and a table of features for a universe of stocks/ETFs/crypto.
Hourly features: mom5/mom20 = % momentum, rsi, macdHist, volRatio = volume vs average, volPct = volatility %, trend = EMA spread %. Daily context: ret5d/ret20d = % return over 5/20 days, fromHigh20/fromLow20 = % distance from the 20-day high (<=0) / low (>=0), rs5d/rs20d = return relative to the benchmark (SPY for stocks/ETFs, BTC for crypto).
Select up to ${TOP_N} symbols with the most potential for a meaningful move over the next ~24 hours, ranked best first. Each pick needs a direction ("long" or "short"), a confidence between 0 and 1 (be calibrated: 0.5 means a coin flip, reserve >0.8 for exceptional setups), and a one-sentence reason grounded in the supplied numbers.
Rules: crypto cannot be shorted (long only); list each symbol at most once; keep the book balanced — no more than ~70% of picks in one direction unless the regime clearly justifies it; weigh the regime and relative strength (prefer longs with positive relative strength in risk-on, shorts with negative relative strength in risk-off).
Reply with ONLY JSON: {"picks":[{"symbol":"...","direction":"long|short","confidence":0.0,"reason":"..."}]}. Use only symbols from the table.`;

const MAX_RAW_PICKS = 500;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Defensive parse of the scanner LLM's JSON: `picks` must be an array of plain objects with a known string symbol
 * and long/short direction. Bad entries are dropped; a bad overall shape throws so the caller uses the rules fallback.
 */
export function sanitizePicks(json, known) {
  if (!isPlain(json) || !Array.isArray(json.picks)) throw new Error('model returned an unusable JSON shape');
  return json.picks
    .slice(0, MAX_RAW_PICKS)
    .filter((p) => isPlain(p) && typeof p.symbol === 'string' && known.has(p.symbol) && (p.direction === 'long' || p.direction === 'short'))
    .map((p) => {
      const c = typeof p.confidence === 'number' || typeof p.confidence === 'string' ? Number(p.confidence) : NaN;
      return {
        symbol: p.symbol,
        direction: p.direction,
        confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0,
        reason: typeof p.reason === 'string' ? p.reason.slice(0, 300) : '',
      };
    });
}

export async function runScannerBot(data, { regime } = {}) {
  const known = new Map(data.map((d) => [d.symbol, d]));
  let picks;
  let source;
  let model = null;

  if (hasOpenRouterKey()) {
    try {
      const { json } = await chatJson({
        bot: 'scanner',
        model: config.openrouter.scannerModel,
        system: SYSTEM,
        user: JSON.stringify({ regime: regime?.line || 'unknown', rows: data.map((d) => d.row) }),
        maxTokens: 16000,
      });
      picks = sanitizePicks(json, known);
      if (!picks.length) throw new Error('model returned no valid picks');
      source = 'ai';
      model = config.openrouter.scannerModel;
    } catch (err) {
      store.addLog({ level: 'warn', message: `scanner bot AI failed (${err.message}) — using rule-based fallback` });
    }
  }
  if (!picks) {
    picks = heuristicPicks(data);
    source = 'rules';
  }

  picks = cleanPicks(picks, { limit: TOP_N }).map((p) => ({ ...p, price: known.get(p.symbol).price, atrPct: known.get(p.symbol).atrPct }));

  const result = {
    picks,
    updatedAt: new Date().toISOString(),
    source,
    model,
    regime: regime?.line || null,
    universe: UNIVERSE.length,
    scanned: data.length,
  };
  store.setAiPicks(result);
  insert('watchlists', {
    source: result.source,
    model: result.model,
    universe: result.universe,
    scanned: result.scanned,
    picks: result.picks,
  });
  return result;
}
