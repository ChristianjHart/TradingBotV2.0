// What-if replay: re-run PAST proposals through the same exit simulation the app already uses (stop / target / break-even / trailing /
// time exit, with slippage + fees) under different rules, and compare with the rules as they were. Nothing is persisted and nothing is
// traded. Honest limits, reported back to the caller: proposals still inside their horizon are skipped, and so are proposals whose price
// history is no longer available (only the most recent hourly bars are fetched).
import { alpaca } from './alpaca.js';
import { store } from '../db/store.js';
import { config } from '../config.js';
import { hypotheticalTrade } from './shadow.js';
import { maxDrawdownUsd } from './performance.js';

const HOUR = 3600_000;
const r2 = (n) => Math.round(n * 100) / 100;
export const MAX_REPLAY = 80; // newest proposals considered per request (bounds bar fetches)
export const SCOPES = ['all', 'approved', 'declined'];

export const DEFAULTS = Object.freeze({ stopMult: 1, targetMult: 1, sizeMult: 1, horizonHours: null, breakEven: null, trailR: null, scope: 'all' });

const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Validate a request body. `null` for horizonHours/breakEven/trailR means "same as the real rules". */
export function validateWhatIf(body) {
  if (body === undefined || body === null) return { value: { ...DEFAULTS } };
  if (typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(body)) {
    if (!Object.hasOwn(DEFAULTS, k)) return { error: `unknown parameter: ${k}` };
    if (v === null || v === undefined) continue;
    if (k === 'stopMult' || k === 'targetMult') {
      if (!inRange(v, 0.25, 4)) return { error: `${k} must be between 0.25 and 4` };
    } else if (k === 'sizeMult') {
      if (!inRange(v, 0.1, 3)) return { error: 'sizeMult must be between 0.1 and 3' };
    } else if (k === 'horizonHours') {
      if (!inRange(v, 1, 168)) return { error: 'horizonHours must be between 1 and 168' };
    } else if (k === 'trailR') {
      if (!inRange(v, 0, 10)) return { error: 'trailR must be between 0 and 10' };
    } else if (k === 'breakEven') {
      if (typeof v !== 'boolean') return { error: 'breakEven must be true or false' };
    } else if (k === 'scope') {
      if (!SCOPES.includes(v)) return { error: `scope must be one of ${SCOPES.join(', ')}` };
    }
    out[k] = v;
  }
  return { value: out };
}

/** Stats for a list of {pnl} in time order; the curve is cumulative P&L starting at 0. */
function summarize(rows, startEquity) {
  let cum = 0;
  const curve = rows.map((r) => ({ t: r.at, v: (cum = r2(cum + r.pnl)) }));
  const wins = rows.filter((r) => r.pnl > 0).length;
  return {
    stats: {
      n: rows.length,
      pnl: r2(rows.reduce((s, r) => s + r.pnl, 0)),
      wins,
      winRate: rows.length ? +(wins / rows.length).toFixed(4) : null,
      maxDrawdownUsd: maxDrawdownUsd([{ equity: startEquity }, ...curve.map((c) => ({ equity: startEquity + c.v }))]),
    },
    curve,
  };
}

/**
 * Pure core. `proposals` newest-first as stored; `barsBy` Map(symbol -> hourly bars). Returns the full response (see below).
 */
export function replayTrades({ proposals, barsBy, params, settings, now = Date.now(), startEquity = config.paperEquity }) {
  const p = { ...DEFAULTS, ...params };
  const costs = { slippageBps: settings.slippageBps ?? 5, feeBps: settings.feeBps ?? 5 };
  const realBE = settings.breakEven !== false;
  const realTrail = settings.trailR || 0;
  const skipped = { superseded: 0, tooRecent: 0, noPriceHistory: 0 };
  const rows = [];
  for (const x of proposals.filter((y) => y.status !== 'pending')) {
    if (x.status === 'superseded') {
      skipped.superseded++;
      continue;
    }
    if (p.scope === 'approved' && x.status !== 'approved') continue;
    if (p.scope === 'declined' && x.status === 'approved') continue;
    const realH = x.horizonHours || settings.horizonHours || 24;
    const scenH = p.horizonHours ?? realH;
    const opened = Date.parse(x.createdAt);
    if (!Number.isFinite(opened) || opened + Math.max(realH, scenH) * HOUR > now) {
      skipped.tooRecent++;
      continue;
    }
    const bars = barsBy.get(x.symbol);
    const dir = x.side === 'long' ? 1 : -1;
    const stopD = Math.abs(x.entry - x.stopLoss);
    const tgtD = Math.abs(x.takeProfit - x.entry);
    const base = bars && hypotheticalTrade({ side: x.side, entryQuote: x.entry, stopLoss: x.stopLoss, takeProfit: x.takeProfit, allocation: x.allocationUsd, openedAt: x.createdAt, horizonHours: realH, bars, ...costs, breakEven: realBE, trailR: realTrail });
    const scen =
      bars &&
      hypotheticalTrade({
        side: x.side,
        entryQuote: x.entry,
        stopLoss: x.entry - dir * stopD * p.stopMult,
        takeProfit: x.entry + dir * tgtD * p.targetMult,
        allocation: x.allocationUsd * p.sizeMult,
        openedAt: x.createdAt,
        horizonHours: scenH,
        bars,
        ...costs,
        breakEven: p.breakEven ?? realBE,
        trailR: p.trailR ?? realTrail,
      });
    if (!base || !scen) {
      skipped.noPriceHistory++;
      continue;
    }
    rows.push({ id: x.id, symbol: x.symbol, side: x.side, status: x.status, at: x.createdAt, basePnl: base.pnl, scenPnl: scen.pnl, baseExit: base.exitReason, scenExit: scen.exitReason });
  }
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const b = summarize(rows.map((r) => ({ at: r.at, pnl: r.basePnl })), startEquity);
  const s = summarize(rows.map((r) => ({ at: r.at, pnl: r.scenPnl })), startEquity);
  const movers = [...rows].map((r) => ({ ...r, delta: r2(r.scenPnl - r.basePnl) })).sort((a, c) => Math.abs(c.delta) - Math.abs(a.delta)).slice(0, 8);
  return {
    params: p,
    replayed: rows.length,
    skipped,
    baseline: b.stats,
    scenario: s.stats,
    delta: { pnl: r2(s.stats.pnl - b.stats.pnl), winRate: s.stats.winRate !== null && b.stats.winRate !== null ? +(s.stats.winRate - b.stats.winRate).toFixed(4) : null },
    unchanged: p.stopMult === 1 && p.targetMult === 1 && p.sizeMult === 1 && p.horizonHours === null && p.breakEven === null && p.trailR === null,
    curves: { baseline: b.curve, scenario: s.curve },
    movers,
    note: 'Both lines are re-simulated from hourly bars with the same costs, so they are comparable. Hourly bars hide what happened inside an hour, and the real stored scores can differ slightly.',
  };
}

async function fetchBars(symbols) {
  const barsBy = new Map();
  const list = [...symbols];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, list.length) }, async () => {
      while (i < list.length) {
        const sym = list[i++];
        try {
          barsBy.set(sym, await alpaca.getBars(sym, { limit: 500 }));
        } catch {
          /* no history for this symbol: its proposals count as noPriceHistory */
        }
      }
    }),
  );
  return barsBy;
}

export async function runWhatIf(params) {
  const settings = store.getSettings();
  const proposals = store.getProposals().filter((x) => x.status !== 'pending').slice(0, MAX_REPLAY);
  const barsBy = await fetchBars(new Set(proposals.map((x) => x.symbol)));
  return replayTrades({ proposals, barsBy, params, settings });
}
