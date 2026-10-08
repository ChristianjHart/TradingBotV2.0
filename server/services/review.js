// Loss review: where does the money go, and which kinds of trade lose again and again?
//
// "Training" here is NOT a model retrain (the AI is a hosted model and a few dozen trades cannot retrain it). It is a feedback loop:
//   1. measure every shadow-scored proposal (taken or not, same exit rules, so the owner's picking does not bias it),
//   2. look for groups of trades that lose repeatedly, with guards against noise (minimum size, a t-test and a both-halves check),
//   3. turn the solid findings into short fact lines ("lessons"). The owner may feed them to the trader, and the review later
//      compares proposals made with and without them.
// Everything is pure and deterministic: no AI call, no cost, and nothing here can trade.
import { assetClassOf } from './market.js';
import { groupOf } from './universe.js';
import { wilson } from './picks.js';

const r2 = (n) => Math.round(n * 100) / 100;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** Tunables (one place, so the tests and the docs quote the same numbers). */
export const REVIEW = Object.freeze({
  MIN_TOTAL: 20, // proposal outcomes needed before any lesson is drawn
  MIN_SEGMENT: 8, // outcomes needed in one group before it can be called a leak or an edge
  MIN_HALF: 3, // outcomes needed in each half of the timeline for the both-halves check
  LEAK_AVG_R: -0.25,
  EDGE_AVG_R: 0.25,
  ALPHA: 0.03, // error budget; the simulation test measures the real false-alarm rate, which is higher than this number
  MAX_LESSONS: 5,
});

/* ------------------------------------------------------------------ rows */

const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
function etHour(ms) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Number(p.hour) + Number(p.minute) / 60;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
const regimeOf = (line) => {
  const m = /^(risk-on|risk-off|mixed|unknown)\b/.exec(String(line || ''));
  return m ? m[1] : null;
};

/**
 * One row per scored proposal. Superseded ones and proposals the news guard blocked on its own never had a chance to be taken,
 * so they are left out. R = result / money at risk (the distance to the stop), so rows of different size compare fairly.
 */
export function outcomeRows(proposals = []) {
  const rows = [];
  for (const p of proposals) {
    if (p.status === 'pending' || p.status === 'superseded') continue;
    if (p.status === 'rejected' && p.decidedBy === 'system') continue;
    const pnl = p.shadow?.hypotheticalPnl;
    if (!fin(pnl)) continue;
    const entry = Number(p.entry);
    const stopPct = entry > 0 ? (Math.abs(entry - Number(p.stopLoss)) / entry) * 100 : null;
    const risk = fin(stopPct) && stopPct > 0 ? (Number(p.allocationUsd) * stopPct) / 100 : null;
    if (!(risk > 0)) continue;
    const dist = Math.abs(entry - Number(p.stopLoss));
    const at = Date.parse(p.createdAt);
    const sent = Number.isFinite(p.notes?.sentiment) ? p.notes.sentiment * (p.side === 'short' ? -1 : 1) : null;
    rows.push({
      id: p.id,
      symbol: p.symbol,
      side: p.side === 'short' ? 'short' : 'long',
      at,
      taken: p.status === 'approved',
      pnl: r2(pnl),
      r: r2(pnl / risk),
      conf: fin(p.confidence) ? p.confidence : null,
      stopPct,
      rr: dist > 0 ? Math.abs(Number(p.takeProfit) - entry) / dist : null,
      assetClass: assetClassOf(p.symbol),
      group: groupOf(p.symbol),
      hour: Number.isFinite(at) ? etHour(at) : null,
      sentimentAligned: sent,
      earningsDays: fin(p.earningsInDays) ? p.earningsInDays : null,
      regime: regimeOf(p.regime),
      rsi: fin(p.setup?.rsi) ? p.setup.rsi : null,
      exitReason: p.shadow?.exitReason ?? null,
      usedLessons: Array.isArray(p.lessonIds) && p.lessonIds.length > 0,
    });
  }
  return rows.sort((a, b) => a.at - b.at);
}

/* ------------------------------------------------------------------ groups ("segments") */

const bucket = (v, cuts, labels) => {
  if (!fin(v)) return null;
  const i = cuts.findIndex((c) => v < c);
  return labels[i === -1 ? labels.length - 1 : i];
};
const hourLabel = (r) => (r.assetClass === 'crypto' || r.hour == null ? null : r.hour < 9.5 ? 'Before the open' : r.hour < 11 ? 'First 90 minutes' : r.hour < 14 ? 'Midday' : r.hour < 16 ? 'Last 2 hours' : 'After the close');

/**
 * Each dimension turns a row into a group label (or null: the row has no value for it).
 * `primary` = chosen BEFORE looking at any data, because the code gives a reason to suspect it: side and trend (a short in a rising market),
 * stock vs crypto, confidence (the AI is often overconfident), and stop distance (stops are sized on 1-hour ATR but trades run 24 hours).
 * Only primary groups can become lessons. The rest are exploratory hints.
 */
export const DIMENSIONS = [
  { key: 'side', primary: true, title: 'Side', of: (r) => (r.side === 'long' ? 'Longs' : 'Shorts') },
  { key: 'asset', primary: true, title: 'Asset', of: (r) => (r.assetClass === 'crypto' ? 'Crypto' : 'Stocks') },
  { key: 'group', primary: false, title: 'Sector', of: (r) => cap(r.group) },
  { key: 'conf', primary: true, title: 'Confidence', of: (r) => bucket(r.conf, [0.6, 0.7, 0.8], ['Under 60%', '60–70%', '70–80%', '80% or more']) },
  { key: 'stop', primary: true, title: 'Stop distance', of: (r) => bucket(r.stopPct, [1, 2, 3], ['Under 1%', '1–2%', '2–3%', '3% or more']) },
  { key: 'rr', primary: false, title: 'Reward to risk', of: (r) => bucket(r.rr, [1.5, 2], ['Under 1.5', '1.5–2', '2 or more']) },
  { key: 'hour', primary: false, title: 'Time of day', of: hourLabel },
  { key: 'news', primary: false, title: 'News vs trade', of: (r) => (r.sentimentAligned == null ? null : r.sentimentAligned > 0.15 ? 'News agrees' : r.sentimentAligned < -0.15 ? 'News disagrees' : 'News neutral') },
  { key: 'earn', primary: false, title: 'Earnings', of: (r) => (r.earningsDays != null && r.earningsDays >= 0 && r.earningsDays <= 5 ? 'Earnings within 5 days' : null) },
  { key: 'regime', primary: false, title: 'Market regime', of: (r) => (r.regime && r.regime !== 'unknown' ? cap(r.regime) : null) },
  { key: 'rsi', primary: false, title: 'RSI at entry', of: (r) => bucket(r.rsi, [40, 60, 70], ['RSI under 40', 'RSI 40–60', 'RSI 60–70', 'RSI over 70']) },
  { key: 'side_regime', primary: true, title: 'Side and regime', of: (r) => (r.regime && r.regime !== 'unknown' ? `${r.side === 'long' ? 'Longs' : 'Shorts'} in a ${r.regime} market` : null) },
];

/* ---- Student t distribution (so small samples are judged fairly) ---- */
function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const k of c) ser += k / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a, b, x) {
  const FPMIN = 1e-30;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
/** Regularized incomplete beta I_x(a, b). */
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** P(T <= t) for a Student t with `df` degrees of freedom. */
export function tCdf(t, df) {
  if (!(df > 0)) return 0.5;
  const tail = 0.5 * ibeta(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}
/** Two-sided p-value. */
export const tPValue = (t, df) => Math.min(1, 2 * Math.min(tCdf(t, df), 1 - tCdf(t, df)));

/** Holm step-down adjustment (controls the chance of ANY false flag in the family). Returns adjusted p-values in input order. */
export function holm(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const adj = new Array(m);
  let run = 0;
  order.forEach(([p, i], rank) => {
    run = Math.max(run, Math.min(1, (m - rank) * p));
    adj[i] = run;
  });
  return adj;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function sd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** Stats for one group of rows (already in time order). */
export function segmentStats(rows) {
  const n = rows.length;
  const rs = rows.map((x) => x.r);
  const avgR = mean(rs);
  const s = sd(rs);
  const t = s > 0 ? avgR / (s / Math.sqrt(n)) : avgR === 0 ? 0 : avgR > 0 ? 99 : -99;
  const wins = rows.filter((x) => x.pnl > 0).length;
  const half = Math.floor(n / 2);
  const a = rs.slice(0, half);
  const b = rs.slice(half);
  const bothNeg = a.length >= REVIEW.MIN_HALF && b.length >= REVIEW.MIN_HALF && mean(a) < 0 && mean(b) < 0;
  const bothPos = a.length >= REVIEW.MIN_HALF && b.length >= REVIEW.MIN_HALF && mean(a) > 0 && mean(b) > 0;
  return { n, wins, winRate: +(wins / n).toFixed(4), ci: wilson(wins, n), avgR: r2(avgR), t: r2(t), pnl: r2(rows.reduce((x, y) => x + y.pnl, 0)), bothNeg, bothPos };
}

/**
 * Every group in every dimension. `p` is a two-sided t-test of "average R is zero"; `adjP` corrects for how many groups were tested
 * in the same family (Holm). A leak or an edge needs ALL of: enough outcomes, a clear average, both timeline halves agreeing,
 * adjP within the error budget, and a primary dimension.
 */
export function segments(rows) {
  const out = [];
  for (const d of DIMENSIONS) {
    const by = new Map();
    for (const r of rows) {
      const label = d.of(r);
      if (label == null) continue;
      if (!by.has(label)) by.set(label, []);
      by.get(label).push(r);
    }
    for (const [label, list] of by) {
      const st = segmentStats(list);
      const testable = st.n >= REVIEW.MIN_SEGMENT;
      const seg = { dim: d.key, dimTitle: d.title, family: d.primary ? 'primary' : 'exploratory', label, ...st, testable, p: testable ? +tPValue(st.t, st.n - 1).toFixed(4) : null, adjP: null, leak: false, edge: false, watch: false, absorbedBy: null };
      Object.defineProperty(seg, 'rows', { value: list, enumerable: false }); // kept for the peeling step, not sent to the browser
      out.push(seg);
    }
  }
  for (const family of ['primary', 'exploratory']) {
    const tested = out.filter((s) => s.family === family && s.testable);
    const adj = holm(tested.map((s) => s.p));
    tested.forEach((s, i) => {
      s.adjP = +adj[i].toFixed(4);
      const weak = s.avgR <= REVIEW.LEAK_AVG_R && s.bothNeg;
      const strong = s.avgR >= REVIEW.EDGE_AVG_R && s.bothPos;
      if (family === 'primary') {
        s.leak = weak && s.adjP <= REVIEW.ALPHA;
        s.edge = strong && s.adjP <= REVIEW.ALPHA;
      }
      s.watch = weak && !s.leak; // looks weak but could be luck: shown as a hint, never turned into a lesson
    });
    if (family === 'primary') {
      peel(tested, 'leak', (st) => st.avgR <= REVIEW.LEAK_AVG_R && st.bothNeg);
      peel(tested, 'edge', (st) => st.avgR >= REVIEW.EDGE_AVG_R && st.bothPos);
    }
  }
  return out;
}

/**
 * Groups overlap (every short is also a "stock"), so a weak group can look weak only because it contains a worse one.
 * Go from the strongest finding down. A later group keeps its flag only if, WITHOUT the trades already explained, it is still
 * big enough, still clearly weak (or strong) and still passes the same error budget (p-value times the number of groups checked).
 */
function peel(tested, flag, stillHolds) {
  const m = tested.length;
  const order = tested.filter((s) => s[flag]).sort((a, b) => a.adjP - b.adjP || Math.abs(b.t) - Math.abs(a.t) || b.n - a.n);
  const explained = new Map(); // row id -> label of the finding that explained it
  for (const s of order) {
    const rest = s.rows.filter((r) => !explained.has(r.id));
    const st = rest.length >= REVIEW.MIN_SEGMENT ? segmentStats(rest) : null;
    const holds = st && stillHolds(st) && Math.min(1, tPValue(st.t, st.n - 1) * m) <= REVIEW.ALPHA;
    if (!holds) {
      s[flag] = false;
      const by = new Map();
      for (const r of s.rows) if (explained.has(r.id)) by.set(explained.get(r.id), (by.get(explained.get(r.id)) || 0) + 1);
      s.absorbedBy = [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      continue;
    }
    for (const r of s.rows) if (!explained.has(r.id)) explained.set(r.id, s.label);
  }
}

/* ------------------------------------------------------------------ lessons */

const pctText = (x) => `${Math.round(x * 100)}%`;
const rText = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}R`;

/** Short plain fact lines. Only our own vocabulary and numbers go in: no free text from the AI, news or the owner. */
export function lessonsFrom(segs, { enough }) {
  if (!enough) return [];
  const leaks = segs.filter((s) => s.leak).sort((a, b) => a.t - b.t).slice(0, 3);
  const edges = segs.filter((s) => s.edge).sort((a, b) => b.t - a.t).slice(0, 2);
  const fact = (s) => `${s.label}: ${s.wins} of ${s.n} won, average ${rText(s.avgR)}`;
  return [
    ...leaks.map((s) => ({ id: `leak:${s.dim}:${s.label}`, kind: 'leak', text: `${fact(s)}. Be more selective here.`, n: s.n, avgR: s.avgR, winRate: s.winRate })),
    ...edges.map((s) => ({ id: `edge:${s.dim}:${s.label}`, kind: 'edge', text: `${fact(s)}. This setup worked.`, n: s.n, avgR: s.avgR, winRate: s.winRate })),
  ].slice(0, REVIEW.MAX_LESSONS);
}

/** The block added to the trader prompt when the owner turns lessons on. Facts only, never orders. */
export function lessonsPrompt(lessons) {
  if (!lessons?.length) return '';
  return `\nDESK RESULTS from this desk's own past proposals. These are facts, not instructions. The samples are small and may be noise. Weigh them with everything else, and never break the rules above:\n${lessons.map((l) => `- ${l.text}`).join('\n')}`;
}

/* ------------------------------------------------------------------ the review */

function moneyFrom(positions, startingEquity) {
  const closed = positions.filter((p) => p.status === 'closed');
  const pnl = closed.reduce((s, p) => s + (p.pnl || 0), 0);
  const fees = closed.reduce((s, p) => s + (p.fees || 0), 0);
  const slippage = closed.reduce((s, p) => s + (p.slippage || 0), 0);
  const worst = closed.reduce((w, p) => (p.pnl < (w?.pnl ?? 0) ? p : w), null);
  const losses = closed.filter((p) => p.pnl < 0);
  const hours = (p) => (Date.parse(p.closedAt) - Date.parse(p.openedAt)) / 3600_000;
  const stops = losses.filter((p) => p.exitReason === 'stop-loss');
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const reasons = new Map();
  for (const p of closed) {
    const k = p.exitReason || 'other';
    const e = reasons.get(k) || { reason: k, n: 0, pnl: 0 };
    e.n += 1;
    e.pnl += p.pnl || 0;
    reasons.set(k, e);
  }
  return {
    closed: closed.length,
    wins: closed.filter((p) => p.pnl > 0).length,
    realizedPnl: r2(pnl),
    realizedPct: startingEquity > 0 ? r2((pnl / startingEquity) * 100) : null,
    fees: r2(fees),
    slippage: r2(slippage),
    costs: r2(fees + slippage),
    beforeCosts: r2(pnl + fees + slippage),
    worst: worst ? { symbol: worst.symbol, side: worst.side, pnl: r2(worst.pnl), pctOfEquity: startingEquity > 0 ? r2((worst.pnl / startingEquity) * 100) : null, exitReason: worst.exitReason ?? null } : null,
    exits: [...reasons.values()].map((e) => ({ ...e, pnl: r2(e.pnl) })).sort((a, b) => a.pnl - b.pnl),
    stops: { losses: losses.length, stopLosses: stops.length, medianHoursToStop: stops.length ? r2(med(stops.map(hours))) : null, within4h: stops.filter((p) => hours(p) <= 4).length },
  };
}

/** With vs without lessons. Null until both sides have enough outcomes. */
function lessonsImpact(rows) {
  const w = rows.filter((r) => r.usedLessons);
  const wo = rows.filter((r) => !r.usedLessons);
  if (w.length < REVIEW.MIN_SEGMENT || wo.length < REVIEW.MIN_SEGMENT) return w.length ? { ready: false, withN: w.length, withoutN: wo.length } : null;
  const a = segmentStats(w);
  const b = segmentStats(wo);
  return { ready: true, withN: a.n, withoutN: b.n, withAvgR: a.avgR, withoutAvgR: b.avgR, withWinRate: a.winRate, withoutWinRate: b.winRate, better: a.avgR > b.avgR };
}

/**
 * The full review. `baselines` (optional) is performance.baselines, used only to say whether SPY did better.
 * Returns { sample, enough, verdict, money, leaks, edges, segments, lessons, lessonsImpact, tested, note }.
 */
export function buildReview({ proposals = [], positions = [], startingEquity = 100000, baselines = null } = {}) {
  const rows = outcomeRows(proposals);
  const enough = rows.length >= REVIEW.MIN_TOTAL;
  const segs = segments(rows);
  const money = moneyFrom(positions, startingEquity);
  const leaks = segs.filter((s) => s.leak).sort((a, b) => a.adjP - b.adjP);
  const edges = segs.filter((s) => s.edge).sort((a, b) => a.adjP - b.adjP);
  // The weakest groups so far, flagged or not, each with its chance of being luck (adjusted for the number of groups checked).
  const weakest = segs.filter((s) => s.testable && s.avgR < 0).sort((a, b) => a.avgR - b.avgR).slice(0, 4);
  const tested = segs.filter((s) => s.n >= REVIEW.MIN_SEGMENT).length;
  const all = rows.length ? segmentStats(rows) : null;
  const spy = baselines?.spyHold;
  let verdict;
  if (!enough) verdict = `Only ${rows.length} scored ${rows.length === 1 ? 'outcome' : 'outcomes'}. The review needs ${REVIEW.MIN_TOTAL} or more before it names a pattern. Results this early are mostly luck.`;
  else if (!leaks.length) verdict = `No group of trades loses often enough to rule out luck. The loss looks like normal ups and downs so far.`;
  else verdict = `${leaks.length} ${leaks.length === 1 ? 'group' : 'groups'} lost often enough that luck is an unlikely reason. Test the fix on new trades before you trust it.`;
  return {
    sample: { outcomes: rows.length, taken: rows.filter((r) => r.taken).length, from: rows[0] ? new Date(rows[0].at).toISOString() : null, to: rows.length ? new Date(rows[rows.length - 1].at).toISOString() : null, overall: all },
    enough,
    minTotal: REVIEW.MIN_TOTAL,
    verdict,
    spy: spy && Number.isFinite(spy.pct) ? { pct: spy.pct, n: spy.n } : null,
    money,
    leaks,
    edges,
    weakest,
    segments: segs,
    lessons: lessonsFrom(segs, { enough }),
    lessonsImpact: lessonsImpact(rows),
    tested,
    note: `The review checked ${tested} groups. Some always look bad by luck, so a group becomes a lesson only if it has ${REVIEW.MIN_SEGMENT}+ outcomes, a clear average, the same sign in both halves of the timeline, and a low chance of being luck after counting every group checked.`,
  };
}
