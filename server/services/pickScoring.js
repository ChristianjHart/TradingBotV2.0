import { alpaca } from './alpaca.js';
import { store } from '../db/store.js';
import { upsert } from '../db/supabase.js';
import { priceAt, scorePick } from './picks.js';

/** Remember a run's scanner picks so they can be scored once their horizon has passed. */
export function recordPicks(runId, picks) {
  const at = new Date();
  const horizon = store.getSettings().horizonHours || 24;
  const dueAt = new Date(at.getTime() + horizon * 3600_000).toISOString();
  const recs = picks.map((p) => ({
    id: `${runId}_${p.symbol.replace('/', '')}`,
    runId,
    symbol: p.symbol,
    direction: p.direction,
    confidence: p.confidence,
    price: p.price,
    reason: p.reason,
    at: at.toISOString(),
    dueAt,
    scored: false,
  }));
  store.setPickScores([...recs, ...store.getPickScores()]);
  for (const r of recs) upsert('pick_scores', { id: r.id, raw: r, updated_at: at.toISOString() });
  return recs.length;
}

/** Score every due pick against the price at its horizon (direction hit/miss). */
export async function scorePicks() {
  const all = store.getPickScores();
  const now = Date.now();
  const due = all.filter((r) => !r.scored && new Date(r.dueAt).getTime() <= now);
  if (!due.length) return { scored: 0, hits: 0 };
  const barsBy = new Map();
  let scored = 0;
  let hits = 0;
  for (const r of due) {
    try {
      if (!barsBy.has(r.symbol)) barsBy.set(r.symbol, await alpaca.getBars(r.symbol, { limit: 120 }));
      const px = priceAt(barsBy.get(r.symbol), new Date(r.dueAt).getTime());
      const next = px == null ? { ...r, scored: true, hit: null, unscorable: true } : scorePick(r, px);
      Object.assign(r, next);
      upsert('pick_scores', { id: r.id, raw: r, updated_at: new Date().toISOString() });
      scored += 1;
      if (r.hit) hits += 1;
    } catch {
      /* retry next time */
    }
  }
  if (scored) {
    store.setPickScores(all);
    store.setWorker({ ...store.getWorker(), lastEvaluateAt: new Date().toISOString() });
    store.addLog({ level: 'info', message: `scored ${scored} scanner picks (${hits} direction hits)` });
  }
  return { scored, hits };
}
