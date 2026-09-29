import { groupOf } from './universe.js';
import { assetClassOf } from './market.js';

/** Turn settings (percent values) into fractional limits. */
export function limitsFrom(s) {
  return {
    maxGross: (s.maxGrossPct ?? 80) / 100,
    maxClass: (s.maxClassPct ?? 60) / 100,
    maxPerGroup: s.maxPerGroup ?? 3,
    dailyLossHalt: (s.dailyLossHaltPct ?? 3) / 100,
  };
}

/** Realized P&L of positions closed since `since` plus current unrealized P&L. */
export function dailyPnl(positions, unrealized = 0, since = new Date().setUTCHours(0, 0, 0, 0)) {
  const realized = positions
    .filter((p) => p.status === 'closed' && new Date(p.closedAt).getTime() >= since)
    .reduce((s, p) => s + (p.pnl || 0), 0);
  return realized + unrealized;
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
