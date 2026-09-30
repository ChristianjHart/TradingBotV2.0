import './setup.js';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake, bar, ago, HOUR, realFetch } from './helpers.js';

const { store } = await import('../server/db/store.js');
const { config } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const S = await import('../server/services/shadow.js');
const { computePerformance, maxDrawdownUsd } = await import('../server/services/performance.js');
const { scorePicks } = await import('../server/services/pickScoring.js');

let server;
let base;
await new Promise((r) => (server = createApp().listen(0, '127.0.0.1', () => r((base = `http://127.0.0.1:${server.address().port}`)))));
after(() => server.close());

const close = (a, b, eps = 0.011) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
const T0 = '2026-01-05T15:00:00Z';
const tAt = (h) => new Date(Date.parse(T0) + h * HOUR).toISOString();
const hb = (h, o, hi, l, c) => ({ t: tAt(h), o, h: hi, l, c, v: 1000 });
const base5 = { entryQuote: 100, allocation: 10000, openedAt: T0, horizonHours: 24, slippageBps: 5, feeBps: 5 };

beforeEach(() => {
  resetFake();
  store.setProposals([]);
  store.setPickScores([]);
  store.setPositions([]);
  store.setEquity([]);
  store.setSettings({ ...store.getSettings(), slippageBps: 5, feeBps: 5, breakEven: true, trailR: 0, horizonHours: 24, maxGrossPct: 80, netEdgeDrawdownWeight: 0.5, netEdgeAvoidedWeight: 1 });
  config.paperEquity = 100000;
});

test('hypotheticalTrade: take-profit is a limit fill (no exit slippage); fees and entry slippage are charged', () => {
  const r = S.hypotheticalTrade({ ...base5, side: 'long', stopLoss: 96, takeProfit: 107, bars: [hb(0, 100, 101, 99, 100), hb(1, 100, 108, 99.5, 107)] });
  const entry = 100 * 1.0005;
  const qty = 10000 / entry;
  const expected = (107 - entry) * qty - 10000 * 0.0005 - 107 * qty * 0.0005;
  close(r.pnl, expected);
  assert.equal(r.exitReason, 'take-profit');
  assert.equal(r.exitPrice, 107);
  close(r.pct, (expected / 10000) * 100, 0.02);
});

test('hypotheticalTrade: stop-loss fills at the stop (gap-aware) with exit slippage; shorts mirror', () => {
  const l = S.hypotheticalTrade({ ...base5, side: 'long', stopLoss: 96, takeProfit: 110, bars: [hb(0, 100, 101, 99, 100), hb(1, 99, 99.5, 95, 96)] });
  const entry = 100 * 1.0005;
  const qty = 10000 / entry;
  const exit = 96 * (1 - 0.0005);
  close(l.pnl, (exit - entry) * qty - 10000 * 0.0005 - exit * qty * 0.0005);
  assert.equal(l.exitReason, 'stop-loss');
  assert.ok(l.pnl < -400);
  const gap = S.hypotheticalTrade({ ...base5, side: 'long', stopLoss: 96, takeProfit: 110, bars: [hb(0, 100, 101, 99, 100), hb(1, 92, 93, 90, 91)] });
  assert.ok(gap.exitPrice < 92.1 && gap.exitPrice < 96, 'gap through the stop fills at the open');
  const s = S.hypotheticalTrade({ ...base5, side: 'short', stopLoss: 104, takeProfit: 93, bars: [hb(0, 100, 101, 99, 100), hb(1, 100, 100, 92, 93)] });
  assert.equal(s.exitReason, 'take-profit');
  assert.ok(s.pnl > 600);
});

test('hypotheticalTrade: time exit at the horizon; bars after the horizon are ignored; empty window is null', () => {
  const bars = Array.from({ length: 24 }, (_, i) => hb(i, 100, 100.5, 99.5, 100 + i * 0.01));
  bars.push(hb(25, 100, 101, 80, 85)); // after the horizon: a stop breach here must not count
  const r = S.hypotheticalTrade({ ...base5, side: 'long', stopLoss: 96, takeProfit: 110, bars });
  assert.equal(r.exitReason, 'time-exit');
  assert.equal(r.exitPrice > 99.9, true);
  assert.equal(S.hypotheticalTrade({ ...base5, side: 'long', stopLoss: 96, takeProfit: 110, bars: [hb(30, 1, 1, 1, 1)] }), null);
  assert.equal(S.hypotheticalTrade({ ...base5, side: 'long', stopLoss: 96, takeProfit: 110, bars: [] }), null);
});

test('holdPnl: buy-and-hold over the same window, costs included', () => {
  const bars = [hb(0, 100, 101, 99, 100), hb(12, 101, 102, 100, 101), hb(24, 102, 103, 101, 102.5)];
  const p = S.holdPnl({ allocation: 10000, openedAt: T0, horizonHours: 24, bars, slippageBps: 5, feeBps: 5 });
  const entry = 100 * 1.0005;
  const exit = 102 * 0.9995;
  const qty = 10000 / entry;
  close(p, (exit - entry) * qty - 5 - exit * qty * 0.0005);
  assert.equal(S.holdPnl({ allocation: 1, openedAt: T0, horizonHours: 24, bars: [] }), null);
});

test('defaultAllocation / defaultLevels: the documented sizing for unsized picks', () => {
  assert.equal(S.defaultAllocation(100000, 2, { slippageBps: 5, feeBps: 5, maxGrossPct: 80 }, 10), 8000); // gross share binds
  assert.equal(S.defaultAllocation(100000, 2, { slippageBps: 5, feeBps: 5, maxGrossPct: 80 }, 2), 20000); // 20% per-trade cap binds
  assert.ok(S.defaultAllocation(100000, 8, { slippageBps: 5, feeBps: 5, maxGrossPct: 80 }, 2) < 13500); // 2% risk cap binds for wide stops
  assert.deepEqual(S.defaultLevels(100, 'long', 2), { stopLoss: 96, takeProfit: 107 });
  assert.deepEqual(S.defaultLevels(100, 'short', 2), { stopLoss: 104, takeProfit: 93 });
});

const prop = (id, status, pnl, over = {}) => ({ id, runId: 'r1', symbol: id, side: 'long', status, allocationUsd: 1000, createdAt: tAt(0), horizonHours: 24, shadow: pnl === null ? null : { hypotheticalPnl: pnl, allocation: 1000, spyPnl: 5 }, ...over });

test('shadowStats: approvedNet vs rejectedNet, avoidedLoss, missedGain, counts; superseded/pending never judged', () => {
  const proposals = [
    prop('A', 'approved', 50),
    prop('B', 'rejected', -100),
    prop('C', 'expired', -30),
    prop('D', 'rejected', 20),
    prop('E', 'superseded', -999),
    prop('F', 'pending', null),
    prop('G', 'approved', null), // not scored yet
  ];
  const s = S.shadowStats({ proposals, pickRecords: [] });
  assert.deepEqual(s.proposals, { total: 7, pending: 1, approved: 2, rejected: 2, expired: 1, superseded: 1 });
  assert.equal(s.approval.approvedNet, 50);
  assert.equal(s.approval.rejectedNet, -110);
  assert.equal(s.avoidedLoss, 130);
  assert.equal(s.missedGain, 20);
  assert.deepEqual([s.approval.approvedCount, s.approval.rejectedCount], [1, 3]);
});

test('seeded random baseline is deterministic (same runId, any input order) and uses the same scanner list', () => {
  const picks = Array.from({ length: 12 }, (_, i) => ({ id: `r1_P${i}`, runId: 'r1', symbol: `P${i}`, shadow: { hypotheticalPnl: (i - 5) * 10, allocation: 8000 } }));
  const a = S.seededSample(picks, 3, 'r1');
  const b = S.seededSample([...picks].reverse(), 3, 'r1');
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
  assert.equal(new Set(a.map((x) => x.id)).size, 3);
  assert.notDeepEqual(S.seededSample(picks, 3, 'r2').map((x) => x.id), a.map((x) => x.id));
  assert.equal(S.seededSample(picks, 99, 'r1').length, 12);
  const proposals = [prop('AA', 'approved', 40), prop('BB', 'rejected', -10), prop('CC', 'expired', 5)];
  const s1 = S.shadowStats({ proposals, pickRecords: picks });
  const s2 = S.shadowStats({ proposals, pickRecords: [...picks].reverse() });
  assert.deepEqual(s1.baselines.randomPicks, s2.baselines.randomPicks);
  assert.equal(s1.baselines.randomPicks.n, 3);
  assert.equal(s1.baselines.randomPicks.seeded, true);
  assert.equal(s1.baselines.randomPicks.pnl, a.reduce((t, x) => t + x.shadow.hypotheticalPnl, 0));
  assert.equal(s1.baselines.randomPicks.pct, +((s1.baselines.randomPicks.pnl / 24000) * 100).toFixed(2));
  // AI vs baselines over the same window
  assert.equal(s1.baselines.ai.pnl, 35);
  assert.equal(s1.baselines.ai.n, 3);
  assert.equal(s1.baselines.spyHold.pnl, 15);
  assert.equal(s1.baselines.beats.spyHold, true);
  assert.equal(s1.baselines.window.from, tAt(0));
});

test('passed-on picks (AI skipped them) are valued separately and need a run that produced proposals', () => {
  const picks = [
    { id: 'r1_AA', runId: 'r1', symbol: 'AA', shadow: { hypotheticalPnl: 30, allocation: 8000 } }, // proposed -> not "passed on"
    { id: 'r1_ZZ', runId: 'r1', symbol: 'ZZ', shadow: { hypotheticalPnl: -70, allocation: 8000 } },
    { id: 'r9_QQ', runId: 'r9', symbol: 'QQ', shadow: { hypotheticalPnl: 500, allocation: 8000 } }, // run with no proposals: ignored
  ];
  const s = S.shadowStats({ proposals: [prop('AA', 'approved', 10)], pickRecords: picks });
  assert.deepEqual([s.approval.passedOnNet, s.approval.passedOnCount], [-70, 1]);
});

test('netEdge = realized P&L - 0.5 x max drawdown $ + avoided loss (weights come from settings)', () => {
  assert.equal(maxDrawdownUsd([{ equity: 1000 }, { equity: 1200 }, { equity: 900 }, { equity: 1100 }]), 300);
  const positions = [{ status: 'closed', pnl: 100, source: 'ai', entry: 100, stopLoss: 95, initialStop: 95, qty: 10, openedAt: T0, closedAt: T0 }];
  const snapshots = [{ t: tAt(0), equity: 1000 }, { t: tAt(1), equity: 1200 }, { t: tAt(2), equity: 900 }, { t: tAt(3), equity: 1100 }];
  const proposals = [prop('B', 'rejected', -100), prop('C', 'expired', -30), prop('D', 'rejected', 20)];
  const perf = computePerformance({ positions, snapshots, proposals, settings: store.getSettings(), startingEquity: 1000 });
  assert.equal(perf.avoidedLoss, 130);
  assert.equal(perf.maxDrawdownUsd, 300);
  assert.equal(perf.netEdge, 100 - 0.5 * 300 + 130);
  assert.equal(perf.netEdgeParts.weights.drawdown, 0.5);
  const w = computePerformance({ positions, snapshots, proposals, settings: { netEdgeDrawdownWeight: 1, netEdgeAvoidedWeight: 2 }, startingEquity: 1000 });
  assert.equal(w.netEdge, 100 - 300 + 260);
});

test('scoreShadows scores decided proposals whose horizon passed (idempotent), incl. the SPY baseline; pending/too-young are left alone', async () => {
  const mk = (id, status, createdH, sym) => ({ ...prop(id, status, null), symbol: sym, createdAt: ago(createdH), entry: 100, stopLoss: 96, takeProfit: 107, allocationUsd: 5000, horizonHours: 24 });
  store.setProposals([mk('P1', 'rejected', 30, 'AAPL'), mk('P2', 'approved', 30, 'XOM'), mk('P3', 'pending', 30, 'MSFT'), mk('P4', 'rejected', 5, 'JPM')]);
  // AAPL hits the target 20h after the proposal; XOM drops through the stop
  fake.bars.set('AAPL', Array.from({ length: 29 }, (_, i) => bar(29 - i, 100, i === 9 ? 108 : 101, 99.5, 100.5)));
  fake.bars.set('XOM', Array.from({ length: 29 }, (_, i) => bar(29 - i, 100, 100.5, i === 3 ? 94 : 99.5, 99.5)));
  fake.bars.set('SPY', Array.from({ length: 29 }, (_, i) => bar(29 - i, 500 + i, 501 + i, 499 + i, 500 + i)));
  const r = await S.scoreShadows();
  assert.equal(r.scored, 2);
  const by = Object.fromEntries(store.getProposals().map((p) => [p.id, p]));
  assert.equal(by.P1.shadow.exitReason, 'take-profit');
  assert.ok(by.P1.shadow.hypotheticalPnl > 200);
  assert.equal(by.P2.shadow.exitReason, 'stop-loss');
  assert.ok(by.P2.shadow.hypotheticalPnl < -100);
  assert.ok(Number.isFinite(by.P1.shadow.spyPnl));
  assert.equal(by.P3.shadow, null);
  assert.equal(by.P4.shadow, null);
  assert.equal((await S.scoreShadows()).scored, 0);
  // market data failure: skipped and retried, never scored from nothing
  store.setProposals([mk('P5', 'expired', 30, 'FAILSYM')]);
  fake.fail.add('FAILSYM');
  assert.equal((await S.scoreShadows()).scored, 0);
  assert.equal(store.getProposals()[0].shadow, null);
  assert.ok(store.getLogs().some((l) => /shadow scoring: skipped 1 symbol/.test(l.message)));
  fake.fail.clear();
});

test('scorePicks also stores a counterfactual (default levels + default sizing) on every scored pick', async () => {
  store.setPickScores([{ id: 'r_AAPL', runId: 'r', symbol: 'AAPL', direction: 'long', confidence: 0.7, price: 100, atrPct: 2, reason: 't', at: ago(30), dueAt: ago(6), scored: false }]);
  fake.bars.set('AAPL', Array.from({ length: 29 }, (_, i) => bar(29 - i, 100, i === 9 ? 108 : 101, 99.5, 100.5)));
  assert.equal((await scorePicks()).scored, 1);
  const rec = store.getPickScores()[0];
  assert.equal(rec.scored, true);
  assert.equal(rec.shadow.allocation, 8000);
  assert.equal(rec.shadow.exitReason, 'take-profit');
  assert.ok(rec.shadow.hypotheticalPnl > 300);
});

test('GET /api/performance exposes proposals, approval, avoidedLoss, missedGain, baselines and netEdge', async () => {
  store.setProposals([prop('A', 'approved', 50), prop('B', 'rejected', -100), prop('C', 'expired', -30), prop('D', 'rejected', 20)]);
  const r = await realFetch(`${base}/api/performance`);
  const p = await r.json();
  assert.deepEqual(p.proposals, { total: 4, pending: 0, approved: 1, rejected: 2, expired: 1, superseded: 0 });
  assert.equal(p.approval.approvedNet, 50);
  assert.equal(p.approval.rejectedNet, -110);
  assert.equal(p.avoidedLoss, 130);
  assert.equal(p.missedGain, 20);
  assert.ok('spyHold' in p.baselines && 'randomPicks' in p.baselines);
  assert.equal(p.netEdge, 130); // no closed trades, no drawdown
  assert.ok(p.netEdgeParts.formula);
  assert.ok(p.byBot.ai && p.byBot.demo && !('rules' in p.byBot));
});
