import test from 'node:test';
import assert from 'node:assert/strict';
import { luckText, reviewSummary, weakRows, moneyTiles, ideaRows, impactText, usd, rText, pctText, exitLabel } from '../public/js/review-logic.js';
import { SECTION_KEYS, isSectionOpen, sectionSummary } from '../public/js/collapse-logic.js';

test('number formats use a real minus sign and keep zero plain', () => {
  assert.equal(usd(-1800), '−$1,800');
  assert.equal(usd(236.5, 2), '+$236.50');
  assert.equal(usd(0), '$0');
  assert.equal(rText(-0.6), '−0.60R');
  assert.equal(rText(null), '—');
  assert.equal(pctText(-1.8), '−1.8%');
});

test('luckText speaks in plain odds and never claims certainty from a small sample', () => {
  assert.equal(luckText(null), 'not enough outcomes');
  assert.equal(luckText(0.004), 'under 1 in 100');
  assert.equal(luckText(0.38), 'about 38 in 100');
  assert.equal(luckText(1), 'almost certain');
});

const rv = (over = {}) => ({
  enough: true, minTotal: 20, verdict: 'v', note: 'n', useLessons: false, lessons: [], edges: [], leaks: [], spy: { pct: 0.24, n: 14 }, lessonsImpact: null,
  sample: { outcomes: 60 },
  money: { closed: 20, wins: 9, realizedPnl: -2000, realizedPct: -2, fees: 20, slippage: 8, costs: 28, beforeCosts: -1972, worst: { symbol: 'NVDA', side: 'long', pnl: -1000, pctOfEquity: -1, exitReason: 'stop-loss' }, exits: [], stops: { losses: 11, stopLosses: 9, medianHoursToStop: 3.5, within4h: 6 } },
  weakest: [{ dim: 'side', label: 'Shorts', family: 'primary', n: 12, wins: 3, avgR: -0.6, adjP: 0.01, leak: true }, { dim: 'rr', label: 'Under 1.5', family: 'exploratory', n: 9, wins: 3, avgR: -0.4, adjP: 0.5, leak: false }],
  ...over,
});

test('summary line for the collapsed header: needs data, no pattern, or weak groups', () => {
  assert.equal(reviewSummary(null), '');
  assert.equal(reviewSummary(rv({ enough: false, sample: { outcomes: 14 } })), '−2.0% · 14 of 20 outcomes needed');
  assert.equal(reviewSummary(rv()), '−2.0% · no clear pattern');
  assert.equal(reviewSummary(rv({ leaks: [{}, {}] })), '−2.0% · 2 weak groups');
  assert.equal(reviewSummary(rv({ leaks: [{}] })), '−2.0% · 1 weak group');
  assert.equal(reviewSummary(rv({ money: { ...rv().money, closed: 0, realizedPct: 0 } })), 'no clear pattern');
});

test('weak rows mark lessons and hints differently', () => {
  const rows = weakRows(rv());
  assert.deepEqual(rows.map((r) => [r.label, r.flagged, r.hint]), [['Shorts', true, false], ['Under 1.5', false, true]]);
  assert.equal(rows[0].won, '3 of 12');
  assert.equal(rows[0].avgR, '−0.60R');
  assert.equal(rows[1].luck, 'about 50 in 100');
  assert.equal(weakRows({ weakest: [{ dim: 'asset', label: 'Stocks', family: 'primary', n: 20, wins: 5, avgR: -0.4, adjP: 0.2, leak: false, absorbedBy: 'Shorts' }] })[0].absorbedBy, 'Shorts');
});

test('money tiles explain the 2% risk cap and the stop-out speed', () => {
  const t = Object.fromEntries(moneyTiles(rv()).map((x) => [x.id, x]));
  assert.equal(t.result.value, '−$2,000');
  assert.match(t.result.sub, /−2\.0% of equity · 9 of 20 trades won · SPY hold \+0\.24%/);
  assert.equal(t.costs.value, '$28.00');
  assert.match(t.costs.sub, /Before costs: −\$1,972/);
  assert.match(t.worst.sub, /One full stop-out can cost up to 2%/);
  assert.equal(t.stops.value, '9 of 11 losses');
  assert.match(t.stops.sub, /Median 3\.5h to hit the stop · 6 within 4h/);
  const none = Object.fromEntries(moneyTiles(rv({ money: { ...rv().money, closed: 0, worst: null, stops: { losses: 0, stopLosses: 0 } } })).map((x) => [x.id, x]));
  assert.equal(none.result.value, '—');
  assert.equal(none.worst.value, '—');
  assert.equal(none.stops.value, '—');
});

test('idea rows and the lessons comparison sentence', () => {
  const ex = { results: [{ id: 'a', title: 'Wider', why: 'w', replayed: 20, delta: 120, worstDipReal: 300, worstDipNew: 410, holds: true }, { id: 'b', title: 'Closer', why: 'c', replayed: 20, delta: -40, worstDipReal: 300, worstDipNew: 280, holds: false }] };
  const rows = ideaRows(ex);
  assert.deepEqual(rows.map((r) => [r.deltaText, r.tone, r.dip, r.holds]), [['+$120', 'pos', '$300 → $410', true], ['−$40', 'neg', '$300 → $280', false]]);
  assert.deepEqual(ideaRows(null), []);
  assert.equal(impactText(null), '');
  assert.match(impactText({ ready: false, withN: 3, withoutN: 40 }), /Collecting data: 3 proposals/);
  assert.match(impactText({ ready: true, withN: 20, withoutN: 40, withAvgR: 0.1, withoutAvgR: -0.2, better: true }), /With lessons: \+0\.10R on average over 20 outcomes\. Without: −0\.20R over 40\. That is better, but it may still be luck\./);
  assert.equal(exitLabel('stop-loss'), 'Stop-loss');
  assert.equal(exitLabel('weird'), 'weird');
});

test('the Loss review section is registered, collapsed by default and summarised', () => {
  assert.ok(SECTION_KEYS.includes('review'));
  assert.equal(isSectionOpen({}, 'review'), false);
  assert.equal(sectionSummary('review', { text: '−2.0% · no clear pattern' }), '−2.0% · no clear pattern');
});
