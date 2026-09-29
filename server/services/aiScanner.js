import { alpaca } from './alpaca.js';
import { extractFeatures, atr } from './indicators.js';
import { predictFromBars, rankCandidates } from './predictor.js';
import { chatJson } from './openrouter.js';
import { UNIVERSE } from './universe.js';
import { config, hasOpenRouterKey } from '../config.js';
import { store } from '../db/store.js';

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

/** Pull bars for the whole universe and reduce each symbol to a compact feature row. */
export async function gatherMarketData() {
  const rows = await mapPool(UNIVERSE, 8, async (symbol) => {
    try {
      const { bars } = await alpaca.getSnapshot(symbol);
      if (!bars || bars.length < 30) return null;
      const f = extractFeatures(bars);
      const a = atr(bars);
      return {
        symbol,
        bars,
        price: f.price,
        atrPct: a ? +((a / f.price) * 100).toFixed(2) : null,
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
  return rows.filter(Boolean);
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

const SYSTEM = `You are a quantitative market screener. You receive a table of technical features for a universe of stocks/ETFs/crypto (hourly bars: mom5/mom20 = % momentum, rsi, macdHist, volRatio = volume vs average, volPct = volatility %, trend = EMA spread %).
Select up to ${TOP_N} symbols with the most potential for a meaningful move over the next ~24 hours, ranked best first. Each pick needs a direction ("long" or "short"), a confidence between 0 and 1, and a one-sentence reason grounded in the supplied numbers.
Reply with ONLY JSON: {"picks":[{"symbol":"...","direction":"long|short","confidence":0.0,"reason":"..."}]}. Use only symbols from the table.`;

export async function runScannerBot(data) {
  const known = new Map(data.map((d) => [d.symbol, d]));
  let picks;
  let source;
  let model = null;

  if (hasOpenRouterKey()) {
    try {
      const { json } = await chatJson({
        model: config.openrouter.scannerModel,
        system: SYSTEM,
        user: JSON.stringify(data.map((d) => d.row)),
        maxTokens: 16000,
      });
      picks = (json.picks || [])
        .filter((p) => known.has(p.symbol) && ['long', 'short'].includes(p.direction))
        .map((p) => ({
          symbol: p.symbol,
          direction: p.direction,
          confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0)),
          reason: String(p.reason || '').slice(0, 300),
        }));
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

  const seen = new Set();
  picks = picks
    .filter((p) => (seen.has(p.symbol) ? false : seen.add(p.symbol)))
    .slice(0, TOP_N)
    .map((p) => ({ ...p, price: known.get(p.symbol).price, atrPct: known.get(p.symbol).atrPct }));

  const result = {
    picks,
    updatedAt: new Date().toISOString(),
    source,
    model,
    universe: UNIVERSE.length,
    scanned: data.length,
  };
  store.setAiPicks(result);
  return result;
}
