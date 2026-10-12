import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const R = await import('../server/services/review.js');
const { tCdf, tPValue, holm, outcomeRows, segmentStats, segments, buildReview, lessonsFrom, lessonsPrompt, REVIEW, DIMENSIONS } = R;

/* ------------------------------------------------------------------ the maths (known textbook values) */

test('Student t distribution and Holm match textbook values', () => {
  assert.ok(Math.abs(tCdf(2.228, 10) - 0.975) < 1e-3);
  assert.ok(Math.abs(tCdf(-1.833, 9) - 0.05) < 1e-3);
  assert.ok(Math.abs(tCdf(0, 5) - 0.5) < 1e-9);
  assert.ok(Math.abs(tPValue(2, 10) - 0.0734) < 1e-3);
  assert.ok(Math.abs(tPValue(-2, 10) - 0.0734) < 1e-3, 'two-sided: sign does not matter');
  assert.deepEqual(holm([0.01, 0.04, 0.03]).map((x) => +x.toFixed(3)), [0.03, 0.06, 0.06]);
  assert.deepEqual(holm([0.5]), [0.5]);
  assert.ok(holm([0.4, 0.9]).every((x) => x <= 1));
});

/* ------------------------------------------------------------------ test data */

let seed = 4242;
const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const SYMS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'TSLA', 'META', 'JPM', 'XOM', 'COIN', 'BTC/USD', 'ETH/USD', 'LLY', 'CAT', 'WMT'];
const REG = ['risk-on', 'risk-off', 'mixed'];
/** n proposals whose outcomes are luck (40% win +1.5R, else -1R: average 0). `leak(side, conf, regime)` lowers the win chance to 15%. */
function makeProposals(n, { leak = null } = {}) {
  const t0 = Date.parse('2026-09-20T14:00:00Z');
  return Array.from({ length: n }, (_, i) => {
    const sym = pick(SYMS);
    const side = sym.includes('/') ? 'long' : pick(['long', 'short']);
    const conf = 0.55 + rnd() * 0.4;
    const regime = pick(REG);
    const win = rnd() < (leak && leak(side, conf, regime) ? 0.15 : 0.4);
    const dir = side === 'long' ? 1 : -1;
    return {
      id: `p${i}`, symbol: sym, side, status: i % 2 ? 'approved' : 'rejected', decidedBy: 'user', entry: 100, stopLoss: 100 - dir * 2, takeProfit: 100 + dir * 3.5, allocationUsd: 5000,
      confidence: conf, createdAt: new Date(t0 + i * 3 * 3600e3).toISOString(), regime: `${regime}: x`, notes: { sentiment: rnd() * 2 - 1 }, setup: { rsi: 30 + rnd() * 50 },
      shadow: { hypotheticalPnl: (win ? 1.5 : -1) * 100, exitReason: win ? 'take-profit' : 'stop-loss' },
    };
  });
}

/* ------------------------------------------------------------------ rows */

test('outcomeRows keeps only outcomes that could have been taken and are scored', () => {
  const base = makeProposals(1)[0];
  const rows = outcomeRows([
    base,
    { ...base, id: 'pending', status: 'pending' },
    { ...base, id: 'sup', status: 'superseded' },
    { ...base, id: 'guard', status: 'rejected', decidedBy: 'system' },
    { ...base, id: 'unscored', shadow: null },
    { ...base, id: 'nostop', stopLoss: 100 },
    { ...base, id: 'expired', status: 'expired', decidedBy: 'system' },
  ]);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['expired', 'p0']);
  const r = rows.find((x) => x.id === 'p0');
  assert.equal(r.r, r.pnl / 100, 'R = result / money at risk (2% of 5000 = 100)');
  assert.equal(r.stopPct, 2);
  assert.equal(r.rr, 1.75);
});

/* ------------------------------------------------------------------ the guards against chasing noise */

test('segmentStats: both-halves check needs the same sign in each half', () => {
  const mk = (rs) => rs.map((r, i) => ({ r, pnl: r * 100, at: i }));
  assert.equal(segmentStats(mk([-1, -1, -1, -1, -1, -1, -1, -1])).bothNeg, true);
  assert.equal(segmentStats(mk([-1, -1, -1, -1, 1, 1, 1, 1])).bothNeg, false, 'first half lost, second half won');
  assert.equal(segmentStats(mk([-1, -1, -1])).bothNeg, false, 'halves too small');
  assert.equal(segmentStats(mk([1, 1, 1, 1, 1, 1, 1, 1])).bothPos, true);
});

test('a perfectly consistent but tiny group is never flagged', () => {
  const rows = outcomeRows(makeProposals(60, { leak: () => true })).slice(0, 60);
  const segs = segments(rows.filter((r) => r.symbol === 'AAPL').slice(0, 5));
  assert.ok(segs.every((s) => !s.leak && !s.edge && !s.testable));
});

test('below the minimum sample, the review refuses to name patterns or write lessons', () => {
  const proposals = makeProposals(REVIEW.MIN_TOTAL - 1, { leak: () => true }); // everything loses
  const rv = buildReview({ proposals });
  assert.equal(rv.enough, false);
  assert.deepEqual(rv.lessons, []);
  assert.match(rv.verdict, /mostly luck/);
});

test('measured false-alarm rate on pure luck stays low at several sample sizes', () => {
  for (const n of [30, 60, 120]) {
    let flagged = 0;
    const T = 250;
    for (let k = 0; k < T; k++) {
      const rv = buildReview({ proposals: makeProposals(n) });
      if (rv.leaks.length || rv.edges.length) flagged++;
    }
    const rate = flagged / T;
    assert.ok(rate <= 0.15, `n=${n}: ${(rate * 100).toFixed(1)}% of luck-only reviews named a pattern`);
  }
});

test('a real leak is found most of the time once there is enough data (and it names the right group)', () => {
  const leak = (side, c, regime) => side === 'short' && regime === 'risk-on';
  let found = 0;
  const T = 100;
  for (let k = 0; k < T; k++) {
    const rv = buildReview({ proposals: makeProposals(400, { leak }) });
    if (rv.leaks.some((l) => /Shorts/.test(l.label))) found++;
    for (const l of rv.leaks) assert.ok(l.adjP <= REVIEW.ALPHA && l.avgR <= REVIEW.LEAK_AVG_R && l.bothNeg && l.n >= REVIEW.MIN_SEGMENT);
  }
  assert.ok(found / T >= 0.75, `found in ${found}%`);
});

test('exploratory groups can look weak but never become leaks or lessons', () => {
  const rv = buildReview({ proposals: makeProposals(300, { leak: (s, c, regime) => regime === 'risk-off' }) });
  const expl = rv.segments.filter((s) => s.family === 'exploratory');
  assert.ok(expl.length > 0);
  assert.ok(expl.every((s) => !s.leak && !s.edge));
  assert.ok(rv.lessons.every((l) => /^(leak|edge):(side|asset|conf|stop|side_regime):/.test(l.id)), JSON.stringify(rv.lessons.map((l) => l.id)));
  assert.ok(DIMENSIONS.filter((d) => d.primary).map((d) => d.key).sort().join() === 'asset,conf,side,side_regime,stop');
});

/* ------------------------------------------------------------------ money, exits, stops */

test('money: costs, before-costs result, worst trade, stop speed', () => {
  const H = 3600e3;
  const t = Date.parse('2026-09-30T14:00:00Z');
  const pos = (id, pnl, reason, hours, extra = {}) => ({ id, symbol: 'AAA', side: 'long', status: 'closed', pnl, fees: 5, slippage: 2, exitReason: reason, openedAt: new Date(t).toISOString(), closedAt: new Date(t + hours * H).toISOString(), ...extra });
  const rv = buildReview({ positions: [pos('a', -2000, 'stop-loss', 2), pos('b', -300, 'stop-loss', 9), pos('c', 500, 'take-profit', 6), { id: 'open', status: 'open', pnl: 0 }], startingEquity: 100000 });
  const m = rv.money;
  assert.equal(m.closed, 3);
  assert.equal(m.realizedPnl, -1800);
  assert.equal(m.realizedPct, -1.8);
  assert.equal(m.costs, 21);
  assert.equal(m.beforeCosts, -1779);
  assert.deepEqual(m.worst, { symbol: 'AAA', side: 'long', pnl: -2000, pctOfEquity: -2, exitReason: 'stop-loss' });
  assert.deepEqual(m.stops, { losses: 2, stopLosses: 2, medianHoursToStop: 9, within4h: 1 });
  assert.equal(m.exits[0].reason, 'stop-loss');
  assert.equal(m.exits[0].n, 2);
});

/* ------------------------------------------------------------------ lessons */

test('lessons are plain facts built only from our own words and numbers, and the prompt says they are not orders', () => {
  const seg = (o) => ({ dim: 'side', label: 'Shorts', n: 12, wins: 3, avgR: -0.6, winRate: 0.25, t: -2.5, leak: true, edge: false, ...o });
  const ls = lessonsFrom([seg({}), seg({ label: 'Longs', wins: 9, avgR: 0.5, leak: false, edge: true, t: 2.5 })], { enough: true });
  assert.equal(ls.length, 2);
  assert.equal(ls[0].text, 'Shorts: 3 of 12 won, average −0.6R. Be more selective here.');
  assert.equal(ls[1].text, 'Longs: 9 of 12 won, average +0.5R. This setup worked.');
  assert.deepEqual(lessonsFrom([seg({})], { enough: false }), []);
  const p = lessonsPrompt(ls);
  assert.match(p, /facts, not instructions/);
  assert.match(p, /may be noise/);
  assert.match(p, /never break the rules above/);
  assert.equal(lessonsPrompt([]), '');
  assert.ok(lessonsFrom(Array.from({ length: 12 }, (_, i) => seg({ label: `G${i}`, dim: 'conf' })), { enough: true }).length <= REVIEW.MAX_LESSONS);
});

test('lessonsImpact compares proposals made with and without lessons, only when both sides are big enough', () => {
  const ps = makeProposals(60);
  assert.equal(buildReview({ proposals: ps }).lessonsImpact, null);
  const few = ps.map((p, i) => (i < 5 ? { ...p, lessonIds: ['x'] } : p));
  assert.deepEqual(buildReview({ proposals: few }).lessonsImpact, { ready: false, withN: 5, withoutN: 55 });
  const many = ps.map((p, i) => (i < 30 ? { ...p, lessonIds: ['x'] } : p));
  const imp = buildReview({ proposals: many }).lessonsImpact;
  assert.equal(imp.ready, true);
  assert.equal(imp.withN + imp.withoutN, 60);
  assert.equal(typeof imp.better, 'boolean');
});

/* ------------------------------------------------------------------ experiments */

const { experimentsFrom, PRESETS } = await import('../server/services/experiments.js');
const HOUR = 3600e3;
const barsFrom = (start, closes) => closes.map((c, i) => ({ t: new Date(start + i * HOUR).toISOString(), o: c, h: c + 0.2, l: c - 0.2, c, v: 1 }));
const DIP = [100, 99, 95, 98, 101, 103, ...Array(24).fill(103)]; // dips under a 96 stop, then recovers: a wider stop wins
const CRASH = [100, 97, 94, 90, 85, ...Array(25).fill(85)]; // keeps falling: a wider stop loses more
const trade = (i, symbol, start) => ({ id: `e${i}`, symbol, side: 'long', status: 'approved', decidedBy: 'user', entry: 100, stopLoss: 96, takeProfit: 108, allocationUsd: 1000, horizonHours: 24, createdAt: new Date(start + HOUR + i * 60e3).toISOString() });
const costless = { slippageBps: 0, feeBps: 0, breakEven: false, trailR: 0, horizonHours: 24 };

test('experiments: a wider stop that helps every trade ranks first and "holds" in both halves', () => {
  const start = Date.now() - 120 * HOUR;
  const proposals = Array.from({ length: 12 }, (_, i) => trade(i, 'AAA', start));
  const ex = experimentsFrom({ proposals, barsBy: new Map([['AAA', barsFrom(start, DIP)]]), settings: costless });
  assert.equal(ex.inSample, true);
  assert.equal(ex.replayed, 12);
  assert.equal(ex.results.length, PRESETS.length);
  assert.ok(['stop15', 'stop2', 'wide'].includes(ex.results[0].id), ex.results[0].id);
  assert.ok(ex.results[0].delta > 0 && ex.results[0].holds);
  assert.ok(ex.results.every((r, i, a) => i === 0 || a[i - 1].delta >= r.delta), 'best first');
});

test('experiments: an idea that wins overall but only helps one half does NOT get the "holds" mark', () => {
  const start = Date.now() - 120 * HOUR;
  const first = Array.from({ length: 6 }, (_, i) => trade(i, 'AAA', start));
  const second = Array.from({ length: 6 }, (_, i) => trade(i + 6, 'BBB', start));
  const ex = experimentsFrom({ proposals: [...first, ...second], barsBy: new Map([['AAA', barsFrom(start, DIP)], ['BBB', barsFrom(start, CRASH)]]), settings: costless });
  const stop2 = ex.results.find((r) => r.id === 'stop2');
  assert.ok(stop2.delta > 0, `wins overall (${stop2.delta})`);
  assert.ok(stop2.halves.first > 0 && stop2.halves.second < 0, JSON.stringify(stop2.halves));
  assert.equal(stop2.holds, false);
});

test('experiments: too little history is reported honestly', () => {
  const ex = experimentsFrom({ proposals: [], barsBy: new Map(), settings: costless });
  assert.equal(ex.replayed, 0);
  assert.equal(ex.enough, false);
  assert.ok(ex.results.every((r) => r.holds === false && r.delta === 0));
  assert.match(ex.note, /same trades/);
});

/* ------------------------------------------------------------------ the opt-in feedback loop */

const { store } = await import('../server/db/store.js');
const { config } = await import('../server/config.js');
const { runTraderBot } = await import('../server/services/traderBot.js');
const { stubOpenRouter } = await import('./helpers.js');

/** Deterministic history: every short lost, longs split evenly. Shorts become a clear leak. */
function leakyHistory(n = 60) {
  const t0 = Date.parse('2026-09-20T14:00:00Z');
  return Array.from({ length: n }, (_, i) => {
    const side = i % 2 ? 'short' : 'long';
    const dir = side === 'long' ? 1 : -1;
    const win = side === 'long' && (i / 2) % 2 === 0;
    return { id: `h${i}`, symbol: 'AAPL', side, status: 'approved', decidedBy: 'user', entry: 100, stopLoss: 100 - dir * 2, takeProfit: 100 + dir * 3.5, allocationUsd: 5000, confidence: 0.7, createdAt: new Date(t0 + i * 3 * 3600e3).toISOString(), regime: 'risk-on: x', shadow: { hypotheticalPnl: win ? 150 : -100, exitReason: win ? 'take-profit' : 'stop-loss' } };
  });
}
const pickAAPL = { symbol: 'AAPL', direction: 'long', confidence: 0.8, price: 100, atrPct: 2, reason: 'r' };
const resetDesk = (extra = {}) => {
  store.setPositions([]);
  store.setProposals([]);
  store.setSpend([]);
  store.setWorker({ ...store.getWorker(), status: 'online' });
  store.setSettings({ ...store.getSettings(), useLessons: false, ...extra });
  config.paperEquity = 100000;
};

test('the review finds the planted short leak in the deterministic history', () => {
  const rv = buildReview({ proposals: leakyHistory() });
  assert.equal(rv.enough, true);
  assert.ok(rv.leaks.some((l) => l.label === 'Shorts'), JSON.stringify(rv.leaks.map((l) => l.label)));
  assert.ok(rv.lessons.some((l) => /^Shorts: 0 of 30 won/.test(l.text)), JSON.stringify(rv.lessons.map((l) => l.text)));
});

test('a group that looks weak only because it contains a worse group is not turned into a lesson', () => {
  // Every short loses; longs win half the time. All rows are "Stocks", so Stocks looks weak too, but only because of the shorts.
  const rv = buildReview({ proposals: leakyHistory(160) });
  const stocks = rv.segments.find((s) => s.dim === 'asset' && s.label === 'Stocks');
  assert.ok(stocks.avgR <= REVIEW.LEAK_AVG_R, `Stocks alone would pass the weak test (${stocks.avgR})`);
  assert.ok(stocks.adjP <= REVIEW.ALPHA, `and it passes the error budget on its own (${stocks.adjP}), so only peeling stops it`);
  assert.equal(stocks.leak, false);
  assert.equal(stocks.absorbedBy, 'Shorts');
  assert.deepEqual(rv.leaks.map((l) => l.label), ['Shorts']);
  assert.ok(rv.lessons.every((l) => !/Stocks/.test(l.text)));
});

test('lessons switch OFF (default): the trader prompt has no desk results and proposals carry no lesson ids', async () => {
  resetDesk();
  store.setProposals(leakyHistory());
  const stub = stubOpenRouter();
  const res = await runTraderBot([pickAAPL]);
  stub.restore();
  assert.doesNotMatch(stub.calls[0].messages[0].content, /DESK RESULTS/);
  assert.deepEqual(res.proposals[0].lessonIds, []);
  assert.equal(res.lessons, 0);
});

test('lessons switch ON with enough data: facts go into the prompt and the proposal remembers which lessons it had', async () => {
  resetDesk({ useLessons: true });
  store.setProposals(leakyHistory());
  const stub = stubOpenRouter();
  const res = await runTraderBot([pickAAPL]);
  stub.restore();
  const sys = stub.calls[0].messages[0].content;
  assert.match(sys, /DESK RESULTS/);
  assert.match(sys, /facts, not instructions/);
  assert.match(sys, /Shorts: 0 of 30 won/);
  assert.ok(res.proposals[0].lessonIds.some((id) => id.startsWith('leak:side:')), JSON.stringify(res.proposals[0].lessonIds));
  assert.ok(res.lessons >= 1);
  assert.ok(res.proposals[0].stopLoss < res.proposals[0].entry, 'the risk rules still validate the levels');
});

test('lessons switch ON but too little data: nothing is added (no lessons from a handful of trades)', async () => {
  resetDesk({ useLessons: true });
  store.setProposals(leakyHistory(10));
  const stub = stubOpenRouter();
  const res = await runTraderBot([pickAAPL]);
  stub.restore();
  assert.doesNotMatch(stub.calls[0].messages[0].content, /DESK RESULTS/);
  assert.deepEqual(res.proposals[0].lessonIds, []);
});

test('useLessons is a validated boolean setting', async () => {
  const { validateSettings } = await import('../server/middleware.js');
  assert.deepEqual(validateSettings({ useLessons: true }).value, { useLessons: true });
  assert.ok(validateSettings({ useLessons: 'yes' }).error);
});
