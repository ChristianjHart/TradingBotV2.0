import { calibration, calibrationDetail, pickAccuracy } from './picks.js';
import { shadowStats } from './shadow.js';

export function maxDrawdownPct(curve) {
  let peak = -Infinity;
  let worst = 0;
  for (const { equity } of curve) {
    peak = Math.max(peak, equity);
    if (peak > 0) worst = Math.max(worst, ((peak - equity) / peak) * 100);
  }
  return +worst.toFixed(2);
}

/** Largest peak-to-trough fall of the equity curve in dollars. */
export function maxDrawdownUsd(curve) {
  let peak = -Infinity;
  let worst = 0;
  for (const { equity } of curve) {
    peak = Math.max(peak, equity);
    worst = Math.max(worst, peak - equity);
  }
  return +worst.toFixed(2);
}

/** R multiple = net P&L / initial risk (distance to the original stop x qty). */
export function rMultiple(p) {
  const risk = Math.abs(p.entry - (p.initialStop ?? p.stopLoss)) * p.qty;
  return risk > 0 ? p.pnl / risk : null;
}

function botStats(list) {
  return {
    closed: list.length,
    winRate: list.length ? +(list.filter((p) => p.pnl > 0).length / list.length).toFixed(4) : null,
    pnl: +list.reduce((s, p) => s + (p.pnl || 0), 0).toFixed(2),
  };
}

/** Equity snapshots when we have them, otherwise rebuilt from closed trades. */
export function equityCurve(closed, snapshots, startingEquity) {
  if (snapshots.length) return snapshots;
  let eq = startingEquity;
  const pts = [...closed]
    .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt))
    .map((p) => ({ t: p.closedAt, equity: +(eq += p.pnl || 0).toFixed(2) }));
  return pts.length ? [{ t: closed.reduce((m, p) => (p.openedAt < m ? p.openedAt : m), pts[0].t), equity: startingEquity }, ...pts] : [];
}

export function computePerformance({ positions, snapshots = [], pickRecords = [], proposals = [], settings = {}, startingEquity }) {
  const closed = positions.filter((p) => p.status === 'closed');
  const wins = closed.filter((p) => p.pnl > 0).length;
  const rs = closed.map(rMultiple).filter((r) => r != null);
  const curve = equityCurve(closed, snapshots, startingEquity);
  const realizedPnl = +closed.reduce((s, p) => s + (p.pnl || 0), 0).toFixed(2);
  const ddUsd = maxDrawdownUsd(curve);
  const sh = shadowStats({ proposals, pickRecords });
  const w = { drawdown: Number.isFinite(settings.netEdgeDrawdownWeight) ? settings.netEdgeDrawdownWeight : 0.5, avoided: Number.isFinite(settings.netEdgeAvoidedWeight) ? settings.netEdgeAvoidedWeight : 1 };
  return {
    equityCurve: curve,
    winRate: closed.length ? +(wins / closed.length).toFixed(4) : null,
    closed: closed.length,
    wins,
    avgR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2) : null,
    maxDrawdownPct: maxDrawdownPct(curve),
    realizedPnl,
    maxDrawdownUsd: ddUsd,
    ...sh,
    // netEdge = realized P&L after costs - drawdownWeight x max drawdown $ + avoidedWeight x avoided loss (weights are settings)
    netEdge: +(realizedPnl - w.drawdown * ddUsd + w.avoided * sh.avoidedLoss).toFixed(2),
    netEdgeParts: { realizedPnl, maxDrawdownUsd: ddUsd, avoidedLoss: sh.avoidedLoss, weights: w, formula: 'realizedPnl - drawdown x maxDrawdownUsd + avoided x avoidedLoss' },
    calibration: calibration(pickRecords),
    calibrationChart: calibrationDetail(pickRecords), // every bucket + Wilson intervals + Brier/gap summary (reliability diagram)
    pickAccuracy: pickAccuracy(pickRecords),
    byBot: {
      ai: botStats(closed.filter((p) => p.source === 'ai')),
      demo: botStats(closed.filter((p) => p.source === 'demo')),
    },
  };
}
