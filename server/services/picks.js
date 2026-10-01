import { assetClassOf } from './market.js';

/**
 * Enforce scanner-pick hygiene: known symbols only, de-duplicated, no crypto shorts,
 * and no more than `maxShare` of picks in one direction (lowest confidence dropped first).
 */
export function cleanPicks(picks, { maxShare = 0.7, limit = 100 } = {}) {
  const seen = new Set();
  let out = picks
    .filter((p) => !(p.direction === 'short' && assetClassOf(p.symbol) === 'crypto'))
    .filter((p) => (seen.has(p.symbol) ? false : seen.add(p.symbol)))
    .sort((a, b) => b.confidence - a.confidence);
  if (out.length >= 6) {
    const cap = Math.ceil(out.length * maxShare);
    const kept = { long: 0, short: 0 };
    out = out.filter((p) => ++kept[p.direction] <= cap);
  }
  return out.slice(0, limit);
}

const HOUR = 3600_000;

/** Price at `ts` from ascending hourly bars: open of the first bar starting at/after ts, else the last close if ts is within the last bar. */
export function priceAt(bars, ts) {
  const b = bars.find((x) => new Date(x.t).getTime() >= ts);
  if (b) return b.o;
  const last = bars[bars.length - 1];
  return last && ts <= new Date(last.t).getTime() + HOUR ? last.c : null;
}

/** Turn a stored pick record into a scored one given price-at-horizon. */
export function scorePick(pick, priceThen, now = new Date()) {
  const movePct = ((priceThen - pick.price) / pick.price) * 100;
  const hit = pick.direction === 'long' ? movePct > 0 : movePct < 0;
  return { ...pick, scored: true, hit, priceThen: +priceThen.toFixed(4), movePct: +movePct.toFixed(3), scoredAt: now.toISOString() };
}

export const BUCKETS = [
  [0, 0.5, '<50%'],
  [0.5, 0.6, '50-60%'],
  [0.6, 0.7, '60-70%'],
  [0.7, 0.8, '70-80%'],
  [0.8, 0.9, '80-90%'],
  [0.9, 1.01, '90-100%'],
];

const scoredOnly = (records) => records.filter((r) => r.scored && typeof r.hit === 'boolean');

/** Hit rate per confidence bucket (only buckets that have data). */
export function calibration(records) {
  const rows = scoredOnly(records);
  return BUCKETS.map(([lo, hi, bucket]) => {
    const inB = rows.filter((r) => r.confidence >= lo && r.confidence < hi);
    return { bucket, n: inB.length, hitRate: inB.length ? +(inB.filter((r) => r.hit).length / inB.length).toFixed(4) : null };
  }).filter((b) => b.n > 0);
}

export function pickAccuracy(records) {
  const rows = scoredOnly(records);
  return { hits: rows.filter((r) => r.hit).length, total: rows.length };
}

/** Legacy /api/accuracy shape, now backed by scored scanner picks. */
export function pickStats(records, openCount = 0) {
  const rows = scoredOnly(records);
  const rate = (list) => (list.length ? list.filter((p) => p.hit).length / list.length : null);
  const byAsset = { equity: { total: 0, hits: 0 }, crypto: { total: 0, hits: 0 } };
  const byDay = {};
  for (const p of rows) {
    const a = byAsset[assetClassOf(p.symbol)];
    a.total += 1;
    if (p.hit) a.hits += 1;
    const day = (p.scoredAt || p.at).slice(0, 10);
    byDay[day] ||= { total: 0, hits: 0 };
    byDay[day].total += 1;
    if (p.hit) byDay[day].hits += 1;
  }
  const hits = rows.filter((p) => p.hit).length;
  return {
    total: rows.length,
    hits,
    misses: rows.length - hits,
    accuracy: rate(rows),
    longAccuracy: rate(rows.filter((p) => p.direction === 'long')),
    shortAccuracy: rate(rows.filter((p) => p.direction === 'short')),
    byAsset,
    series: Object.keys(byDay).sort().slice(-14).map((day) => ({ day, accuracy: byDay[day].hits / byDay[day].total, total: byDay[day].total, hits: byDay[day].hits })),
    open: openCount,
    source: 'scanner-picks',
  };
}

/** Wilson 95% interval for a hit rate (stays inside 0..1 and is honest about tiny samples). */
export function wilson(hits, n, z = 1.96) {
  if (!n) return null;
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [+Math.max(0, centre - half).toFixed(4), +Math.min(1, centre + half).toFixed(4)];
}

/**
 * Data for the reliability diagram: every confidence bucket (including empty ones, so the axis is stable) with its midpoint, hit rate
 * and Wilson interval, plus an overall summary (avg stated confidence vs actual hit rate, Brier score, verdict).
 * gap > 0 means the model is OVERconfident (says more than it delivers).
 */
export function calibrationDetail(records, { minForVerdict = 30 } = {}) {
  const rows = scoredOnly(records);
  const buckets = BUCKETS.map(([lo, hi, bucket]) => {
    const inB = rows.filter((r) => r.confidence >= lo && r.confidence < hi);
    const hits = inB.filter((r) => r.hit).length;
    return { bucket, lo, hi: Math.min(hi, 1), mid: +((lo + Math.min(hi, 1)) / 2).toFixed(3), n: inB.length, hits, hitRate: inB.length ? +(hits / inB.length).toFixed(4) : null, ci: wilson(hits, inB.length) };
  });
  const n = rows.length;
  if (!n) return { buckets, summary: { n: 0, avgConfidence: null, hitRate: null, gap: null, brier: null, brierBaseline: null, verdict: 'none', verdictText: 'No scored picks yet.' } };
  const avgConfidence = rows.reduce((s, r) => s + r.confidence, 0) / n;
  const hits = rows.filter((r) => r.hit).length;
  const hitRate = hits / n;
  const gap = avgConfidence - hitRate;
  const brier = rows.reduce((s, r) => s + (r.confidence - (r.hit ? 1 : 0)) ** 2, 0) / n;
  const brierBaseline = hitRate * (1 - hitRate); // Brier of always saying "the base rate": the score to beat
  let verdict = 'calibrated';
  if (n < minForVerdict) verdict = 'small';
  else if (gap > 0.08) verdict = 'overconfident';
  else if (gap < -0.08) verdict = 'underconfident';
  const pct = (x) => `${Math.round(x * 100)}%`;
  const verdictText = {
    small: `Only ${n} scored pick${n === 1 ? '' : 's'}: treat this as anecdotal until there are ${minForVerdict}+.`,
    overconfident: `Overconfident: it claims ${pct(avgConfidence)} on average but is right ${pct(hitRate)} of the time.`,
    underconfident: `Underconfident: it claims ${pct(avgConfidence)} on average but is right ${pct(hitRate)} of the time.`,
    calibrated: `Well calibrated: it claims ${pct(avgConfidence)} on average and is right ${pct(hitRate)} of the time.`,
  }[verdict];
  return { buckets, summary: { n, avgConfidence: +avgConfidence.toFixed(4), hitRate: +hitRate.toFixed(4), gap: +gap.toFixed(4), brier: +brier.toFixed(4), brierBaseline: +brierBaseline.toFixed(4), verdict, verdictText } };
}
