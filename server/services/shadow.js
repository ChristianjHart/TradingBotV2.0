// Shadow / counterfactual scoring: what WOULD every proposal (approved, rejected, expired, superseded) and every scanner pick have
// done by its horizon, using the same exit simulation as real positions (stop / target / break-even / time exit, slippage + fees)?
// This is how "avoided loss" and the baselines (SPY buy-and-hold, seeded random picks) are computed.
import { alpaca } from './alpaca.js';
import { store } from '../db/store.js';
import { config } from '../config.js';
import { simulateExit } from './exits.js';
import { applySlippage, feeFor } from './fills.js';
import { priceAt } from './picks.js';
import { MAX_POSITION_PCT, MAX_RISK_PCT } from './sizing.js';
import { syncRow as syncProposalRow } from './proposals.js';

const HOUR = 3600_000;
const isoMs = (ms) => new Date(ms).toISOString();
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Pure. Simulate one trade opened at `openedAt` at quote `entryQuote` and closed by stop / target / time exit at the horizon.
 * Returns { pnl, pct, exitReason, exitPrice, partial } (net of slippage + fees) or null when there are no bars inside the window.
 */
export function hypotheticalTrade({ side, entryQuote, stopLoss, takeProfit, allocation, openedAt, horizonHours = 24, bars, slippageBps = 5, feeBps = 5, breakEven = true, trailR = 0 }) {
  const opened = Date.parse(openedAt);
  const expires = opened + horizonHours * HOUR;
  const win = (bars || []).filter((b) => Date.parse(b.t) < expires);
  if (!win.length || !(allocation > 0) || !(entryQuote > 0)) return null;
  const entry = applySlippage(entryQuote, side, 'entry', slippageBps);
  const qty = allocation / entry;
  const p = { side, entry, stopLoss, initialStop: stopLoss, takeProfit, qty, openedAt: isoMs(opened), expiresAt: isoMs(expires), trailing: false };
  const r = simulateExit(p, win, { now: expires, breakEven, trailR, fresh: true });
  if (!r.exit) return null;
  const exitPrice = r.exit.market ? applySlippage(r.exit.price, side, 'exit', slippageBps) : r.exit.price;
  const move = side === 'long' ? exitPrice - entry : entry - exitPrice;
  const fees = feeFor(allocation, feeBps) + feeFor(exitPrice * qty, feeBps);
  const pnl = r2(move * qty - fees);
  return { pnl, pct: r2((pnl / allocation) * 100), exitReason: r.exit.reason, exitPrice: +exitPrice.toFixed(4), partial: win.length >= 120 && Date.parse(win[0].t) > opened };
}

/** Pure. Buy-and-hold of `symbol` bars (SPY) over the same window with the same allocation, net of costs. Null when bars do not cover it. */
export function holdPnl({ allocation, openedAt, horizonHours = 24, bars, slippageBps = 5, feeBps = 5 }) {
  const opened = Date.parse(openedAt);
  const expires = opened + horizonHours * HOUR;
  const a = priceAt(bars || [], opened);
  const b = priceAt(bars || [], expires);
  if (!(a > 0) || !(b > 0)) return null;
  const entry = applySlippage(a, 'long', 'entry', slippageBps);
  const exit = applySlippage(b, 'long', 'exit', slippageBps);
  const qty = allocation / entry;
  return r2((exit - entry) * qty - feeFor(allocation, feeBps) - feeFor(exit * qty, feeBps));
}

/** Levels for a scanner pick nobody sized: 2 ATR stop, 3.5 ATR target (same defaults as the trader's level repair). */
export function defaultLevels(price, direction, atrPct) {
  const atrAbs = price * ((atrPct || 1.5) / 100);
  const dir = direction === 'long' ? 1 : -1;
  return { stopLoss: price - dir * atrAbs * 2, takeProfit: price + dir * atrAbs * 3.5 };
}

/**
 * Sizing rule for hypothetical trades that were never sized (scanner picks, random baseline): the trader's per-trade caps
 * (20% of equity, 2% risk at the stop incl. costs) and an equal share of the gross-exposure cap across all position slots.
 */
export function defaultAllocation(equity, atrPct, settings, maxSlots = config.maxOpenPositions) {
  const stopDist = Math.min(0.15, Math.max(0.003, 2 * ((atrPct || 1.5) / 100)));
  const lossFrac = stopDist + ((settings.slippageBps ?? 5) + 2 * (settings.feeBps ?? 5)) / 10_000;
  const grossShare = (equity * (settings.maxGrossPct ?? 80)) / 100 / Math.max(1, maxSlots);
  return r2(Math.min(equity * MAX_POSITION_PCT, (equity * MAX_RISK_PCT) / lossFrac, grossShare));
}

/** Shadow result for a scanner pick record (default levels + default sizing). Null when not computable. */
export function shadowForPick(pick, bars, settings, equity = config.paperEquity) {
  if (!(pick.price > 0)) return null;
  const lv = defaultLevels(pick.price, pick.direction, pick.atrPct);
  const allocation = defaultAllocation(equity, pick.atrPct, settings);
  const r = hypotheticalTrade({ side: pick.direction, entryQuote: pick.price, ...lv, allocation, openedAt: pick.at, horizonHours: settings.horizonHours || 24, bars, ...settingsCosts(settings) });
  return r && { scoredAt: new Date().toISOString(), hypotheticalPnl: r.pnl, hypotheticalPct: r.pct, exitReason: r.exitReason, exitPrice: r.exitPrice, allocation, sizing: 'default' };
}

const settingsCosts = (s) => ({ slippageBps: s.slippageBps ?? 5, feeBps: s.feeBps ?? 5, breakEven: s.breakEven !== false, trailR: s.trailR || 0 });

const STALE_GIVE_UP_MS = 10 * 24 * HOUR;

/**
 * Score every decided proposal whose horizon has passed. Bars are fetched on a snapshot; results are merged by id onto the LATEST
 * store contents in one synchronous section (proposals created/decided meanwhile are never overwritten). A symbol whose bars
 * cannot be fetched is skipped and retried next time (logged once per pass).
 */
export async function scoreShadows({ now = Date.now() } = {}) {
  const settings = store.getSettings();
  const due = store.getProposals().filter((p) => p.status !== 'pending' && !p.shadow && Date.parse(p.createdAt) + (p.horizonHours || settings.horizonHours || 24) * HOUR <= now);
  if (!due.length) return { scored: 0 };
  const barsBy = new Map();
  const failed = new Map();
  const getBars = async (sym) => {
    if (!barsBy.has(sym)) barsBy.set(sym, await alpaca.getBars(sym, { limit: 120 }));
    return barsBy.get(sym);
  };
  let spy = null;
  try {
    spy = await getBars('SPY');
  } catch {
    spy = null; // baseline only; never blocks the proposal's own score
  }
  const results = new Map();
  for (const p of due) {
    if (failed.has(p.symbol)) continue;
    try {
      const bars = await getBars(p.symbol);
      const horizonHours = p.horizonHours || settings.horizonHours || 24;
      const r = hypotheticalTrade({ side: p.side, entryQuote: p.entry, stopLoss: p.stopLoss, takeProfit: p.takeProfit, allocation: p.allocationUsd, openedAt: p.createdAt, horizonHours, bars, ...settingsCosts(settings) });
      const spyPnl = spy ? holdPnl({ allocation: p.allocationUsd, openedAt: p.createdAt, horizonHours, bars: spy, ...settingsCosts(settings) }) : null;
      if (r) {
        results.set(p.id, { scoredAt: new Date(now).toISOString(), hypotheticalPnl: r.pnl, hypotheticalPct: r.pct, exitReason: r.exitReason, exitPrice: r.exitPrice, allocation: p.allocationUsd, spyPnl, ...(r.partial ? { partial: true } : {}) });
      } else if (now - Date.parse(p.createdAt) > STALE_GIVE_UP_MS) {
        results.set(p.id, { scoredAt: new Date(now).toISOString(), unscorable: true, hypotheticalPnl: null, hypotheticalPct: null, exitReason: null });
      }
    } catch (err) {
      failed.set(p.symbol, err.message);
    }
  }
  if (failed.size) {
    store.addLog({ level: 'warn', message: `shadow scoring: skipped ${failed.size} symbol(s), market data unavailable: ${[...failed].map(([s, m]) => `${s} (${m})`).join('; ').slice(0, 400)}` });
  }
  if (!results.size) return { scored: 0 };
  const all = store.getProposals(); // re-read after the awaits
  let scored = 0;
  const changed = [];
  for (const p of all) {
    const sh = results.get(p.id);
    if (!sh || p.shadow) continue;
    p.shadow = sh;
    scored += 1;
    changed.push(p);
  }
  if (scored) {
    store.setProposals(all);
    for (const p of changed) syncProposalRow(p);
    store.addLog({ level: 'info', message: `shadow-scored ${scored} proposal(s)` });
  }
  return { scored };
}

// ---- aggregation (pure) ----
/** Deterministic PRNG (mulberry32) seeded from a string. */
export function seededRng(seedStr) {
  let h = 1779033703 ^ String(seedStr).length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic sample of n items (seeded partial Fisher-Yates over an id-sorted copy). */
export function seededSample(items, n, seed) {
  const pool = [...items].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const rng = seededRng(seed);
  const k = Math.min(n, pool.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, k);
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const sum = (list, f) => r2(list.reduce((s, x) => s + f(x), 0));
const agg = (pnl, alloc, n) => ({ pnl: r2(pnl), pct: alloc > 0 ? r2((pnl / alloc) * 100) : null, n });

/**
 * Proposal outcome stats for /api/performance. `approvedNet`/`rejectedNet` are HYPOTHETICAL net P&L (same simulation for both, so
 * they are comparable); rejected = rejected + expired (the owner's "no"); superseded proposals are counted but not judged.
 * avoidedLoss = sum |loss| of the rejected/expired that would have lost; missedGain = sum of the ones that would have won.
 */
export function shadowStats({ proposals = [], pickRecords = [] }) {
  const counts = { total: proposals.length, pending: 0, approved: 0, rejected: 0, expired: 0, superseded: 0 };
  for (const p of proposals) if (p.status in counts) counts[p.status] += 1;
  const scored = proposals.filter((p) => p.shadow && fin(p.shadow.hypotheticalPnl));
  const pnl = (p) => p.shadow.hypotheticalPnl;
  const approved = scored.filter((p) => p.status === 'approved');
  const declined = scored.filter((p) => p.status === 'rejected' || p.status === 'expired');
  const avoidedLoss = r2(declined.filter((p) => pnl(p) < 0).reduce((s, p) => s + Math.abs(pnl(p)), 0));
  const missedGain = r2(declined.filter((p) => pnl(p) > 0).reduce((s, p) => s + pnl(p), 0));

  const proposed = new Set(proposals.map((p) => `${p.runId}|${p.symbol}`));
  const runsWithProposals = new Set(proposals.map((p) => p.runId));
  const passedOn = pickRecords.filter((r) => r.shadow && fin(r.shadow.hypotheticalPnl) && !proposed.has(`${r.runId}|${r.symbol}`) && runsWithProposals.has(r.runId));

  // Baselines over the same window: everything the AI proposed and that could be scored (superseded excluded).
  const base = scored.filter((p) => p.status !== 'superseded');
  const aiAlloc = sum(base, (p) => p.allocationUsd);
  const spyRows = base.filter((p) => fin(p.shadow.spyPnl));
  const byRun = new Map();
  for (const p of base) byRun.set(p.runId, (byRun.get(p.runId) || 0) + 1);
  const sampled = [];
  for (const [runId, n] of byRun) {
    const pool = pickRecords.filter((r) => r.runId === runId && r.shadow && fin(r.shadow.hypotheticalPnl));
    sampled.push(...seededSample(pool, n, runId));
  }
  const ai = agg(sum(base, pnl), aiAlloc, base.length);
  const spyHold = agg(sum(spyRows, (p) => p.shadow.spyPnl), sum(spyRows, (p) => p.allocationUsd), spyRows.length);
  const randomPicks = { ...agg(sum(sampled, (r) => r.shadow.hypotheticalPnl), sum(sampled, (r) => r.shadow.allocation), sampled.length), seeded: true };
  return {
    proposals: counts,
    approval: {
      approvedNet: sum(approved, pnl),
      rejectedNet: sum(declined, pnl),
      approvedCount: approved.length,
      rejectedCount: declined.length,
      passedOnNet: sum(passedOn, (r) => r.shadow.hypotheticalPnl),
      passedOnCount: passedOn.length,
    },
    avoidedLoss,
    missedGain,
    baselines: {
      window: base.length ? { from: base.reduce((m, p) => (p.createdAt < m ? p.createdAt : m), base[0].createdAt), to: isoMs(Math.max(...base.map((p) => Date.parse(p.createdAt) + (p.horizonHours || 24) * HOUR))) } : null,
      ai,
      spyHold,
      randomPicks,
      beats: {
        spyHold: ai.pct !== null && spyHold.pct !== null ? ai.pct > spyHold.pct : null,
        randomPicks: ai.pct !== null && randomPicks.pct !== null ? ai.pct > randomPicks.pct : null,
      },
    },
  };
}
