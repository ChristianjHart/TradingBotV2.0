/* Pure view helpers for the Loss review section (no DOM). */

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
export const usd = (n, d = 0) => `${n < 0 ? '−' : n > 0 ? '+' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const plainUsd = (n, d = 0) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const rText = (x) => (fin(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}R` : '—');
export const pctText = (x, d = 1) => (fin(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}%` : '—');

/** "Chance this is luck" as plain words. `adjP` already counts every group the review checked. */
export function luckText(adjP) {
  if (!fin(adjP)) return 'not enough outcomes';
  if (adjP >= 0.99) return 'almost certain';
  if (adjP < 0.01) return 'under 1 in 100';
  return `about ${Math.round(adjP * 100)} in 100`;
}

/** One-line summary for the collapsed section header. */
export function reviewSummary(rv) {
  if (!rv || !rv.money) return '';
  const pct = rv.money.realizedPct;
  const head = fin(pct) && rv.money.closed ? pctText(pct) : '';
  if (!rv.enough) return [head, `${rv.sample.outcomes} of ${rv.minTotal ?? 20} outcomes needed`].filter(Boolean).join(' · ');
  const n = rv.leaks.length;
  return [head, n ? `${n} weak ${n === 1 ? 'group' : 'groups'}` : 'no clear pattern'].filter(Boolean).join(' · ');
}

/** Rows for the "weakest groups" table. */
export function weakRows(rv) {
  return (rv?.weakest || []).map((s) => ({
    key: `${s.dim}:${s.label}`,
    label: s.label,
    family: s.family,
    n: s.n,
    won: `${s.wins} of ${s.n}`,
    avgR: rText(s.avgR),
    luck: luckText(s.adjP),
    flagged: Boolean(s.leak),
    hint: !s.leak,
    absorbedBy: s.absorbedBy || null,
  }));
}

/** The four headline tiles. */
export function moneyTiles(rv) {
  const m = rv.money;
  const tiles = [];
  tiles.push({ id: 'result', label: 'RESULT', value: m.closed ? usd(m.realizedPnl) : '—', tone: m.realizedPnl < 0 ? 'neg' : m.realizedPnl > 0 ? 'pos' : '', sub: m.closed ? `${pctText(m.realizedPct)} of equity · ${m.wins} of ${m.closed} trades won${rv.spy ? ` · SPY hold ${pctText(rv.spy.pct, 2)}` : ''}` : 'No closed trades yet' });
  tiles.push({ id: 'costs', label: 'COSTS', value: plainUsd(m.costs, 2), tone: '', sub: m.closed ? `Before costs: ${usd(m.beforeCosts)}` : 'Fees and slippage' });
  tiles.push({ id: 'worst', label: 'BIGGEST LOSS', value: m.worst ? usd(m.worst.pnl) : '—', tone: m.worst ? 'neg' : '', sub: m.worst ? `${m.worst.symbol} · ${pctText(m.worst.pctOfEquity)} of equity. One full stop-out can cost up to 2%.` : 'No losing trade yet' });
  const st = m.stops;
  tiles.push({ id: 'stops', label: 'STOP-OUTS', value: st.losses ? `${st.stopLosses} of ${st.losses} losses` : '—', tone: '', sub: st.stopLosses ? `Median ${st.medianHoursToStop}h to hit the stop · ${st.within4h} within 4h` : 'No stop-outs yet' });
  return tiles;
}

const EXIT_LABEL = { 'stop-loss': 'Stop-loss', 'take-profit': 'Take-profit', 'time-exit': 'Time exit', manual: 'Manual', 'trailing-stop': 'Trailing stop', other: 'Other' };
export const exitLabel = (r) => EXIT_LABEL[r] || r;

/** Rows for the ideas table. */
export function ideaRows(ex) {
  return (ex?.results || []).map((r) => ({ id: r.id, title: r.title, why: r.why, delta: r.delta, deltaText: r.replayed ? usd(r.delta) : '—', tone: r.delta > 0 ? 'pos' : r.delta < 0 ? 'neg' : '', dip: r.replayed ? `${plainUsd(r.worstDipReal)} → ${plainUsd(r.worstDipNew)}` : '—', holds: r.holds }));
}

/** Sentence about the with/without-lessons comparison. */
export function impactText(imp) {
  if (!imp) return '';
  if (!imp.ready) return `Collecting data: ${imp.withN} proposal${imp.withN === 1 ? '' : 's'} made with lessons so far. The app compares them with the others after 8 outcomes on each side.`;
  const dir = imp.better ? 'better' : 'worse';
  return `With lessons: ${rText(imp.withAvgR)} on average over ${imp.withN} outcomes. Without: ${rText(imp.withoutAvgR)} over ${imp.withoutN}. That is ${dir}, but it may still be luck.`;
}
