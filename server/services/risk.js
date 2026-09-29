import { groupOf } from './universe.js';
import { assetClassOf, etDayStart } from './market.js';
import { store } from '../db/store.js';
import { config } from '../config.js';

/** Turn settings (percent values) into fractional limits. */
export function limitsFrom(s) {
  return {
    maxGross: (s.maxGrossPct ?? 80) / 100,
    maxClass: (s.maxClassPct ?? 60) / 100,
    maxPerGroup: s.maxPerGroup ?? 3,
    dailyLossHalt: (s.dailyLossHaltPct ?? 3) / 100,
  };
}

/**
 * (Legacy, no longer used by the halt; see todaysPnl.) Realized P&L of positions closed since `since` plus ALL current unrealized P&L.
 * The trading day is the US/Eastern calendar day (midnight America/New_York), not UTC midnight.
 */
export function dailyPnl(positions, unrealized = 0, since = etDayStart()) {
  const realized = positions
    .filter((p) => p.status === 'closed' && new Date(p.closedAt).getTime() >= since)
    .reduce((s, p) => s + (p.pnl || 0), 0);
  return realized + unrealized;
}

const etDayKey = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/**
 * Equity at the start of the ET trading day, for `dailyPnlFromEquity`. Pure.
 * Preference: the persisted snapshot for today; else the last equity-curve point before today's start;
 * else (first day / no history) paper starting equity + P&L realized before today's start.
 */
export function startOfDayEquity({ saved, snapshots = [], positions = [], since, startingEquity }) {
  if (saved && saved.day === etDayKey(since + 12 * 3600_000) && Number.isFinite(saved.equity)) return saved.equity;
  const prior = [...snapshots].reverse().find((s) => new Date(s.t).getTime() < since && Number.isFinite(s.equity));
  if (prior) return prior.equity;
  const realizedBefore = positions.filter((p) => p.status === 'closed' && new Date(p.closedAt).getTime() < since).reduce((s, p) => s + (p.pnl || 0), 0);
  return startingEquity + realizedBefore;
}

/** Today's P&L = equity now minus start-of-day equity (captures realized + unrealized change since the day began). */
export function dailyPnlFromEquity(equityNow, startEquity) {
  return +(equityNow - startEquity).toFixed(2);
}

/** Store-backed daily P&L: persists today's start-equity snapshot on first use each ET day. */
export function todaysPnl(equityNow, { now = new Date() } = {}) {
  const since = etDayStart(now);
  const saved = store.getDayStart();
  const start = startOfDayEquity({ saved, snapshots: store.getEquity(), positions: store.getPositions(), since, startingEquity: config.paperEquity });
  const day = etDayKey(since + 12 * 3600_000);
  if (!saved || saved.day !== day) store.setDayStart({ day, equity: +start.toFixed(2) });
  return dailyPnlFromEquity(equityNow, start);
}

export function isHalted(pnlToday, equity, limits) {
  return limits.dailyLossHalt > 0 && pnlToday <= -limits.dailyLossHalt * equity;
}

/**
 * Portfolio-level gate for a new position. Returns { ok:true, alloc } (alloc possibly
 * reduced to fit exposure headroom) or { ok:false, reason }.
 */
export function checkEntry({ open, equity, symbol, alloc, limits }) {
  const grp = groupOf(symbol);
  if (open.filter((p) => groupOf(p.symbol) === grp).length >= limits.maxPerGroup) {
    return { ok: false, reason: `group limit (${grp} has ${limits.maxPerGroup})` };
  }
  const cls = assetClassOf(symbol);
  const gross = open.reduce((s, p) => s + p.allocation, 0);
  const classExp = open.filter((p) => assetClassOf(p.symbol) === cls).reduce((s, p) => s + p.allocation, 0);
  const grossRoom = limits.maxGross * equity - gross;
  const classRoom = limits.maxClass * equity - classExp;
  const room = Math.min(grossRoom, classRoom);
  if (room < 100) return { ok: false, reason: grossRoom <= classRoom ? 'gross exposure cap' : `${cls} exposure cap` };
  return { ok: true, alloc: Math.min(alloc, room) };
}
