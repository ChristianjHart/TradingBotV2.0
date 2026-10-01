/* Pure helpers for the "fun" widgets: badges & streaks, trade of the week, what-if chart, reliability diagram, calendar, market mood. No DOM. */

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n, d = 0) => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const signedMoney = (n, d = 0) => (n > 0 ? '+' : '') + money(n, d);

/* ------------------------------------------------------------------ streaks & badges */

export const BADGES_SEEN_KEY = 'tb_badges_seen';

/** Parse the stored list of seen badge ids. null = never stored (first visit: seed silently, no toast storm). */
export function parseSeen(raw) {
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 100) : null;
  } catch {
    return null;
  }
}

/** Badges earned that the owner has not been told about yet. `seen === null` => first visit => nothing to announce. */
export function newlyEarned(seen, badges) {
  if (seen === null) return [];
  const had = new Set(seen);
  return (badges || []).filter((b) => b.earned && !had.has(b.id));
}

export function streakText(n, what = 'in a row') {
  return n >= 2 ? `${n} ${what}` : n === 1 ? '1 so far' : 'none yet';
}

/** "🔥 3 wins in a row" style headline for the widget summary. */
export function gamifySummary(g) {
  if (!g) return '';
  const w = g.streaks?.win?.current ?? 0;
  const base = `${g.earnedCount ?? 0}/${g.total ?? 0} badges`;
  return w >= 2 ? `${base} · 🔥 ${w} wins in a row` : base;
}

/** Next badge to chase: the unearned one closest to done (by fraction). */
export function nextBadge(badges) {
  const todo = (badges || []).filter((b) => !b.earned);
  if (!todo.length) return null;
  return todo.reduce((a, b) => (b.progress.value / b.progress.target > a.progress.value / a.progress.target ? b : a));
}

export function progressText(b) {
  const f = (n) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1));
  return b.id === 'four_figures' ? `${money(b.progress.value)} / ${money(b.progress.target)}` : b.id === 'home_run' ? `${f(b.progress.value)}R / ${f(b.progress.target)}R` : `${f(b.progress.value)} / ${f(b.progress.target)}`;
}

/* ------------------------------------------------------------------ trade of the week / share card */

/** Lines drawn on the share image (kept here so they can be tested). */
export function shareLines(t) {
  const long = t.side !== 'short';
  return {
    title: `${t.symbol} ${long ? 'LONG' : 'SHORT'}`,
    big: `${signedMoney(t.pnl, 2)}`,
    sub: `${t.pnlPct >= 0 ? '+' : '−'}${Math.abs(t.pnlPct).toFixed(2)}%${t.r != null ? ` · ${t.r.toFixed(1)}R` : ''} · held ${t.held}`,
    levels: `Entry $${Number(t.entry).toFixed(2)}  →  Exit $${Number(t.exitPrice).toFixed(2)}`,
    footer: 'Simulated trade · paper only · tradingbot',
  };
}

/** Where entry/stop/target/exit sit on a ruler from the worse of stop/exit to the better of target/exit (0..100). */
export function ruler(t) {
  const pts = [t.stopLoss, t.entry, t.takeProfit, t.exitPrice].filter(fin);
  if (pts.length < 3) return null;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const at = (v) => Math.round(((v - lo) / span) * 1000) / 10;
  return { stop: fin(t.stopLoss) ? at(t.stopLoss) : null, entry: at(t.entry), target: fin(t.takeProfit) ? at(t.takeProfit) : null, exit: at(t.exitPrice), win: t.pnl >= 0 };
}

/* ------------------------------------------------------------------ what-if replay */

export const WHATIF_DEFAULTS = { stopMult: 1, targetMult: 1, sizeMult: 1, horizonHours: null, breakEven: null, trailR: null, scope: 'all' };

/** Request body from the control state: only changed values are sent (null/undefined = "as it really was"). */
export function whatifBody(ui) {
  const b = {};
  for (const k of Object.keys(WHATIF_DEFAULTS)) if (ui[k] !== undefined && ui[k] !== WHATIF_DEFAULTS[k]) b[k] = ui[k];
  return b;
}

export function whatifVerdict(res) {
  if (!res || !res.replayed) return { tone: 'none', text: 'Nothing to replay yet. The replay needs decided proposals that already ended and still have price history.' };
  if (res.unchanged) return { tone: 'neutral', text: 'These are the real rules. Move a slider to see what would have changed.' };
  const d = res.delta.pnl;
  const n = res.replayed;
  if (Math.abs(d) < 0.5) return { tone: 'neutral', text: `Those settings would have made about the same money over ${n} trade${n === 1 ? '' : 's'}.` };
  return { tone: d > 0 ? 'good' : 'bad', text: `Those settings would have made about ${money(Math.abs(d))} ${d > 0 ? 'more' : 'less'} over ${n} trade${n === 1 ? '' : 's'}.` };
}

/** Two-line SVG (baseline grey, scenario blue) over trade index. Returns '' when there is nothing to draw. */
export function whatifSvg(curves, { w = 560, h = 190 } = {}) {
  const b = curves?.baseline || [];
  const s = curves?.scenario || [];
  const n = Math.max(b.length, s.length);
  if (n < 1) return '';
  const vals = [0, ...b.map((p) => p.v), ...s.map((p) => p.v)];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const padL = 52;
  const padR = 10;
  const padT = 10;
  const padB = 22;
  const X = (i) => padL + (n === 1 ? (w - padL - padR) / 2 : (i / (n - 1)) * (w - padL - padR));
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const path = (list) => list.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ');
  const last = (list) => (list.length ? list[list.length - 1].v : 0);
  const ticks = [lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i);
  return `<svg class="wi-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Cumulative profit and loss by trade: real rules ${esc(signedMoney(last(b)))}, with your changes ${esc(signedMoney(last(s)))}" preserveAspectRatio="xMidYMid meet">
    ${ticks.map((v) => `<line class="wi-grid${v === 0 ? ' wi-zero' : ''}" x1="${padL}" x2="${w - padR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="wi-tick" x="${padL - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${esc(signedMoney(v))}</text>`).join('')}
    <path class="wi-line wi-base" d="${path(b)}" fill="none"/>
    <path class="wi-line wi-scen" d="${path(s)}" fill="none"/>
    <text class="wi-tick" x="${padL}" y="${h - 5}">first trade</text><text class="wi-tick" x="${w - padR}" y="${h - 5}" text-anchor="end">latest (${n} trade${n === 1 ? '' : 's'})</text>
  </svg>`;
}

/* ------------------------------------------------------------------ calibration reliability diagram */

/** Geometry-free SVG string. `chart` is performance.calibrationChart. Both axes share one range so the diagonal is true calibration. */
export function reliabilitySvg(chart, { size = 280 } = {}) {
  const bk = (chart?.buckets || []).filter((b) => b.n > 0);
  if (!bk.length) return '';
  const lows = bk.flatMap((b) => [b.mid, b.ci ? b.ci[0] : b.hitRate]);
  const lo = Math.max(0, Math.min(0.5, Math.floor(Math.min(...lows) * 10) / 10));
  const padL = 36;
  const padB = 30;
  const padT = 10;
  const padR = 12;
  const plot = size - padL - padR;
  const X = (v) => padL + ((Math.min(1, Math.max(lo, v)) - lo) / (1 - lo)) * plot;
  const Y = (v) => padT + (1 - (Math.min(1, Math.max(lo, v)) - lo) / (1 - lo)) * (size - padT - padB);
  const grid = [];
  for (let v = Math.ceil(lo * 10) / 10; v <= 1.0001; v += 0.1) grid.push(Math.round(v * 10) / 10);
  const maxN = Math.max(...bk.map((b) => b.n));
  const pts = bk.map((b) => {
    const over = b.hitRate < b.mid - 0.0001;
    const r = 4 + 7 * Math.sqrt(b.n / maxN);
    return `${b.ci ? `<line class="rel-ci" x1="${X(b.mid).toFixed(1)}" x2="${X(b.mid).toFixed(1)}" y1="${Y(b.ci[0]).toFixed(1)}" y2="${Y(b.ci[1]).toFixed(1)}"/>` : ''}<circle class="rel-dot ${over ? 'rel-over' : 'rel-under'}" cx="${X(b.mid).toFixed(1)}" cy="${Y(b.hitRate).toFixed(1)}" r="${r.toFixed(1)}"><title>${esc(b.bucket)}: says ${Math.round(b.mid * 100)}%, right ${Math.round(b.hitRate * 100)}% of the time (n=${b.n})</title></circle>`;
  });
  const line = bk.map((b, i) => `${i ? 'L' : 'M'}${X(b.mid).toFixed(1)} ${Y(b.hitRate).toFixed(1)}`).join(' ');
  return `<svg class="rel-svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Reliability diagram: stated confidence on the horizontal axis, actual hit rate on the vertical axis. Dots on the diagonal mean perfectly calibrated." preserveAspectRatio="xMidYMid meet">
    ${grid.map((v) => `<line class="rel-grid" x1="${padL}" x2="${size - padR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><line class="rel-grid" y1="${padT}" y2="${size - padB}" x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}"/><text class="rel-tick" x="${padL - 5}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v * 100)}</text><text class="rel-tick" x="${X(v).toFixed(1)}" y="${size - padB + 14}" text-anchor="middle">${Math.round(v * 100)}</text>`).join('')}
    <line class="rel-diag" x1="${X(lo).toFixed(1)}" y1="${Y(lo).toFixed(1)}" x2="${X(1).toFixed(1)}" y2="${Y(1).toFixed(1)}"/>
    <path class="rel-path" d="${line}" fill="none"/>${pts.join('')}
    <text class="rel-axis" x="${(padL + plot / 2).toFixed(1)}" y="${size - 3}" text-anchor="middle">stated confidence %</text>
    <text class="rel-axis" transform="translate(9 ${(padT + (size - padT - padB) / 2).toFixed(1)}) rotate(-90)" text-anchor="middle">actual hit rate %</text>
  </svg>`;
}

/* ------------------------------------------------------------------ calendar */

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
export const dateLabel = (ymd) => WEEKDAY.format(new Date(`${ymd}T12:00:00Z`));
const dayN = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const relDay = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);

/** Days that have events (with labels), in order. */
export function calendarGroups(cal) {
  const days = cal?.days;
  if (!Array.isArray(days) || !days.length) return [];
  const today = days[0].date;
  return days.filter((d) => d.events.length).map((d) => ({ date: d.date, label: dateLabel(d.date), rel: relDay(dayN(today, d.date)), today: d.date === today, events: d.events }));
}

export function calendarSummary(cal) {
  if (!cal) return '';
  const e = cal.counts?.earnings ?? 0;
  const m = cal.counts?.macro ?? 0;
  const bits = [m ? `${m} macro` : '', e ? `${e} earnings` : ''].filter(Boolean);
  return bits.length ? bits.join(' · ') : 'quiet';
}

/* ------------------------------------------------------------------ market mood */

export const moodClass = (score) => (score == null ? 'none' : score < 20 ? 'xfear' : score < 40 ? 'fear' : score < 60 ? 'neutral' : score < 80 ? 'greed' : 'xgreed');

/** Quote chip text: "SPY 565.20 +0.4%". */
export function quoteChip(q) {
  const p = Number(q.price);
  const c = Number(q.changePct);
  return { symbol: q.symbol.replace('/USD', ''), price: p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p.toFixed(2), change: `${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(c).toFixed(2)}%`, tone: c > 0 ? 'pos' : c < 0 ? 'neg' : '', stale: Boolean(q.stale) };
}
