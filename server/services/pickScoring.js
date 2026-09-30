import { alpaca } from './alpaca.js';
import { store } from '../db/store.js';
import { upsert } from '../db/supabase.js';
import { priceAt, scorePick } from './picks.js';
import { shadowForPick } from './shadow.js';

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
    atrPct: p.atrPct ?? null,
    reason: p.reason,
    at: at.toISOString(),
    dueAt,
    scored: false,
  }));
  store.setPickScores([...recs, ...store.getPickScores()]);
  for (const r of recs) upsert('pick_scores', { id: r.id, raw: r, updated_at: at.toISOString() });
  return recs.length;
}

/**
 * Score every due pick against the price at its horizon (direction hit/miss).
 * Bars are fetched on a snapshot (awaits); the results are then merged by id onto the LATEST store contents in one
 * synchronous section, so picks recorded (recordPicks) while we were awaiting are never overwritten.
 * A pick whose bars cannot be fetched (live data failure) is skipped and retried next time; the reason is logged once.
 */
export async function scorePicks() {
  const now = Date.now();
  const due = store.getPickScores().filter((r) => !r.scored && new Date(r.dueAt).getTime() <= now);
  if (!due.length) return { scored: 0, hits: 0 };
  const settings = store.getSettings();
  const barsBy = new Map();
  const failed = new Map(); // symbol -> reason
  const results = new Map(); // id -> scored record
  for (const r of due) {
    if (failed.has(r.symbol)) continue;
    try {
      if (!barsBy.has(r.symbol)) barsBy.set(r.symbol, await alpaca.getBars(r.symbol, { limit: 120 }));
      const px = priceAt(barsBy.get(r.symbol), new Date(r.dueAt).getTime());
      if (px == null) results.set(r.id, { ...r, scored: true, hit: null, unscorable: true });
      else {
        // Counterfactual for the SAME pick (default ATR levels + default sizing): feeds the seeded-random baseline and "passed on" stats.
        const shadow = shadowForPick(r, barsBy.get(r.symbol), settings);
        results.set(r.id, { ...scorePick(r, px), ...(shadow ? { shadow } : {}) });
      }
    } catch (err) {
      failed.set(r.symbol, err.message);
    }
  }
  if (failed.size) {
    store.addLog({ level: 'warn', message: `pick scoring: skipped ${failed.size} symbol(s), market data unavailable: ${[...failed].map(([s, m]) => `${s} (${m})`).join('; ').slice(0, 500)}` });
  }
  if (!results.size) return { scored: 0, hits: 0 };
  const latest = store.getPickScores(); // re-read after the awaits
  let scored = 0;
  let hits = 0;
  const merged = latest.map((r) => {
    const next = results.get(r.id);
    if (!next || r.scored) return r; // already scored elsewhere: keep as is
    scored += 1;
    if (next.hit) hits += 1;
    upsert('pick_scores', { id: next.id, raw: next, updated_at: new Date().toISOString() });
    return next;
  });
  if (scored) {
    store.setPickScores(merged);
    store.setWorker({ ...store.getWorker(), lastEvaluateAt: new Date().toISOString() });
    store.addLog({ level: 'info', message: `scored ${scored} scanner picks (${hits} direction hits)` });
  }
  return { scored, hits };
}
