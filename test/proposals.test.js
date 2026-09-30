import './setup.js';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake, bar, ago, mkPos, stubOpenRouter, realFetch } from './helpers.js';

const { store } = await import('../server/db/store.js');
const { config } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const P = await import('../server/services/proposals.js');
const { runTraderBot } = await import('../server/services/traderBot.js');

let server;
let base;
await new Promise((r) => (server = createApp().listen(0, '127.0.0.1', () => r((base = `http://127.0.0.1:${server.address().port}`)))));
after(() => {
  server.close();
  globalThis.fetch = realFetch;
  config.openrouter.key = '';
});
const api = async (p, method = 'GET', body) => {
  const r = await realFetch(`${base}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

const flat = (sym, price) => fake.bars.set(sym, [bar(1, price, price, price, price)]);
/** A sized trade as the trader would hand to createProposals. */
const item = (symbol, over = {}) => {
  const quoted = over.quoted ?? 100;
  const side = over.side ?? 'long';
  const dir = side === 'long' ? 1 : -1;
  return {
    symbol, side, quoted, entry: quoted * 1.0005, stop: quoted - dir * 4, target: quoted + dir * 7, alloc: over.alloc ?? 5000, atrPct: over.atrPct ?? 2,
    confidence: over.confidence ?? 0.7, reason: 'because', riskCheck: { ok: true, notes: [] }, ...over,
  };
};
const make = (items, runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, source = 'ai') => P.createProposals({ runId, items, source, models: { scanner: 'm/s', trader: 'm/t' } });
const openPositions = () => store.getPositions().filter((p) => p.status === 'open');
const fails = async (promise, code, status = 409) => {
  const err = await promise.then(() => assert.fail('expected a ProposalError'), (e) => e);
  assert.equal(err.code, code, err.message);
  assert.equal(err.status, status);
  return err;
};

beforeEach(() => {
  resetFake();
  globalThis.fetch = realFetch;
  config.openrouter.key = '';
  store.setPositions([]);
  store.setProposals([]);
  store.setSpend([]);
  store.setEquity([]);
  store.setDayStart(null);
  store.setWorker({ ...store.getWorker(), status: 'online' });
  store.setSettings({ ...store.getSettings(), slippageBps: 5, feeBps: 5, maxGrossPct: 80, maxClassPct: 60, maxPerGroup: 3, dailyLossHaltPct: 3, autoApprove: false, autoApproveMaxAllocPct: 5, proposalTtlHours: 6 });
  config.maxOpenPositions = 10;
  config.paperEquity = 100000;
});

test('createProposals: full record, pending, TTL from settings, riskCheck snapshot, persisted to disk', () => {
  const [p] = make([item('AAPL')], 'run_a');
  assert.equal(p.id, 'prop_run_a_AAPL');
  for (const k of ['runId', 'symbol', 'side', 'allocationUsd', 'entry', 'stopLoss', 'takeProfit', 'qty', 'confidence', 'reason', 'models', 'status', 'createdAt', 'expiresAt', 'decidedAt', 'decidedBy', 'rejectReason', 'riskCheck', 'shadow']) assert.ok(k in p, k);
  assert.equal(p.status, 'pending');
  assert.equal(p.entry, 100);
  assert.deepEqual(p.models, { scanner: 'm/s', trader: 'm/t' });
  assert.equal(Date.parse(p.expiresAt) - Date.parse(p.createdAt), 6 * 3600_000);
  assert.equal(p.shadow, null);
  assert.equal(store.getProposals()[0].id, p.id);
  store.setSettings({ ...store.getSettings(), proposalTtlHours: 2 });
  assert.equal(Date.parse(make([item('MSFT')])[0].expiresAt) - Date.now() < 2.01 * 3600_000, true);
});

test('approve opens exactly ONE simulated position through openPosition; a second approve is refused (already_decided)', async () => {
  flat('AAPL', 100);
  const [p] = make([item('AAPL')]);
  const r = await P.approveProposal(p.id);
  assert.equal(r.proposal.status, 'approved');
  assert.equal(r.proposal.decidedBy, 'user');
  assert.equal(r.proposal.positionId, r.position.id);
  assert.ok(r.proposal.decidedAt);
  assert.equal(openPositions().length, 1);
  const pos = openPositions()[0];
  assert.deepEqual([pos.symbol, pos.side, pos.source, pos.model, pos.proposalId], ['AAPL', 'long', 'ai', 'm/t', p.id]);
  assert.ok(pos.fees > 0 && pos.expiresAt && pos.initialStop === pos.stopLoss);
  assert.ok(Math.abs(pos.entry - 100 * 1.0005) < 1e-6); // fresh quote + slippage
  await fails(P.approveProposal(p.id), 'already_decided');
  assert.equal(openPositions().length, 1);
});

test('double-click: two concurrent approvals of the same proposal share one result and open one position', async () => {
  flat('AAPL', 100);
  const [p] = make([item('AAPL')]);
  const [a, b] = await Promise.all([P.approveProposal(p.id), P.approveProposal(p.id)]);
  assert.equal(a.position.id, b.position.id);
  assert.equal(openPositions().length, 1);
  // also over HTTP
  flat('MSFT', 100);
  const [q] = make([item('MSFT')]);
  const [h1, h2] = await Promise.all([api(`/proposals/${q.id}/approve`, 'POST'), api(`/proposals/${q.id}/approve`, 'POST')]);
  assert.ok([h1.status, h2.status].includes(200));
  assert.ok([h1, h2].every((h) => h.status === 200 || h.body.code === 'already_decided'));
  assert.equal(openPositions().filter((x) => x.symbol === 'MSFT').length, 1);
  const again = await api(`/proposals/${q.id}/approve`, 'POST');
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'already_decided');
});

test('approvals are serialised: two proposals that together break a cap cannot both pass a stale check', async () => {
  store.setSettings({ ...store.getSettings(), maxGrossPct: 15 }); // room for one $10k trade, not two
  flat('AAPL', 100);
  flat('XOM', 100);
  const [a, b] = make([item('AAPL', { alloc: 10000 }), item('XOM', { alloc: 10000 })]);
  const res = await Promise.allSettled([P.approveProposal(a.id), P.approveProposal(b.id)]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 2);
  // without serialisation both would see 15% of room and open $10k each (20% gross); serialised, the second is cut to the room left
  const total = openPositions().reduce((s, x) => s + x.allocation, 0);
  assert.ok(total <= 15_000 + 0.01, `gross ${total}`);
  assert.ok(Math.min(...openPositions().map((x) => x.allocation)) < 6000);
});

test('price_moved: drift above max(1 x ATR%, 1.5%) is refused with the fresh numbers; within the limit it opens', async () => {
  const [p] = make([item('AAPL', { atrPct: 2 })]); // threshold 2%
  flat('AAPL', 103);
  const err = await fails(P.approveProposal(p.id), 'price_moved');
  assert.deepEqual([err.details.proposalEntry, err.details.freshPrice, err.details.thresholdPct], [100, 103, 2]);
  assert.ok(err.details.driftPct > 2.9 && err.details.driftPct < 3.1);
  assert.equal(openPositions().length, 0);
  assert.equal(store.getProposals()[0].status, 'pending'); // the owner can reject or let it expire
  flat('AAPL', 101.9);
  assert.equal((await P.approveProposal(p.id)).proposal.status, 'approved');
  // the floor is 1.5% when ATR is tiny
  const [q] = make([item('MSFT', { atrPct: 0.5 })]);
  flat('MSFT', 101.6);
  assert.equal((await fails(P.approveProposal(q.id), 'price_moved')).details.thresholdPct, 1.5);
  flat('MSFT', 101.4);
  await P.approveProposal(q.id);
  // price through the stop -> price_moved (levels no longer make sense)
  const [s] = make([item('XOM', { atrPct: 10, stop: 99 })]); // 10% ATR threshold, stop 1% below
  flat('XOM', 98);
  await fails(P.approveProposal(s.id), 'price_moved');
});

test('expired: past expiry the approve is refused and the status is persisted; the expiry job marks them', async () => {
  flat('AAPL', 100);
  const [a] = make([item('AAPL')]);
  const [b] = make([item('MSFT')]);
  const all = store.getProposals();
  all.find((p) => p.id === a.id).expiresAt = ago(1);
  all.find((p) => p.id === b.id).expiresAt = ago(2);
  store.setProposals(all);
  await fails(P.approveProposal(a.id), 'expired');
  assert.equal(store.getProposals().find((p) => p.id === a.id).status, 'expired');
  assert.equal(P.expireProposals(), 1); // the job catches the other one
  const b2 = store.getProposals().find((p) => p.id === b.id);
  assert.deepEqual([b2.status, b2.decidedBy], ['expired', 'system']);
  assert.equal(openPositions().length, 0);
  assert.equal(P.expireProposals(), 0);
});

test('a new run supersedes older pending proposals for the SAME symbol only', () => {
  const [a1, b1] = make([item('AAPL'), item('MSFT')], 'run_1');
  make([item('AAPL', { quoted: 101 })], 'run_2');
  const by = Object.fromEntries(store.getProposals().map((p) => [p.id, p]));
  assert.equal(by[a1.id].status, 'superseded');
  assert.equal(by[a1.id].supersededBy, 'prop_run_2_AAPL');
  assert.equal(by[b1.id].status, 'pending');
  assert.equal(by.prop_run_2_AAPL.status, 'pending');
  const c = P.listProposals();
  assert.equal(c.counts.superseded, 1);
  assert.equal(c.counts.pending, 2);
});

test('reject: marks rejected with a sanitised reason; afterwards neither approve nor reject works', async () => {
  const [a, b] = make([item('AAPL'), item('MSFT')]);
  const r = P.rejectProposal(a.id, { reason: '  too\u0000 risky\n here  ' });
  assert.equal(r.proposal.status, 'rejected');
  assert.equal(r.proposal.rejectReason, 'too  risky  here');
  assert.equal(r.proposal.decidedBy, 'user');
  await fails(P.approveProposal(a.id), 'already_decided');
  assert.throws(() => P.rejectProposal(a.id), (e) => e.code === 'already_decided');
  assert.throws(() => P.rejectProposal('nope'), (e) => e.code === 'not_found' && e.status === 404);
  assert.equal(P.rejectProposal(b.id, { reason: 123 }).proposal.rejectReason, null);
  assert.equal(openPositions().length, 0);
  // HTTP
  const [c] = make([item('XOM')]);
  const h = await api(`/proposals/${c.id}/reject`, 'POST', { reason: 'nah' });
  assert.equal(h.status, 200);
  assert.equal(h.body.proposal.status, 'rejected');
  assert.equal((await api(`/proposals/${c.id}/reject`, 'POST', {})).body.code, 'already_decided');
  assert.equal((await api('/proposals/bad%20id/reject', 'POST', {})).status, 404);
});

test('approve-all: only proposals that pass their re-checks open; the rest are reported with codes', async () => {
  const [ok, moved, stale, expired] = make([item('AAPL', { confidence: 0.9 }), item('MSFT', { confidence: 0.8 }), item('XOM', { confidence: 0.7 }), item('JPM', { confidence: 0.6 })]);
  flat('AAPL', 100);
  flat('MSFT', 110); // moved 10%
  flat('XOM', 100);
  fake.stale.add('XOM');
  flat('JPM', 100);
  const all = store.getProposals();
  all.find((p) => p.id === expired.id).expiresAt = ago(1);
  store.setProposals(all);
  const r = await P.approveAll();
  assert.deepEqual(r.approved.map((a) => a.id), [ok.id]);
  assert.equal(r.approved[0].symbol, 'AAPL');
  assert.ok(r.approved[0].positionId);
  assert.deepEqual(Object.fromEntries(r.failed.map((f) => [f.id, f.code])), { [moved.id]: 'price_moved', [stale.id]: 'stale_quote' });
  assert.equal(store.getProposals().find((p) => p.id === expired.id).status, 'expired'); // swept before approving
  assert.ok(r.failed.every((f) => f.error));
  assert.equal(openPositions().length, 1);
  const http = await api('/proposals/approve-all', 'POST');
  assert.equal(http.status, 200);
  assert.deepEqual(http.body.approved, []);
  assert.equal(http.body.failed.length, 2); // moved + stale are still pending and fail again
});

test('risk re-check at approval: slots, open symbol, caps, halt, worker, crypto short, stale/unavailable quote', async () => {
  flat('AAPL', 100);
  const [p] = make([item('AAPL')]);
  // no_slots
  config.maxOpenPositions = 1;
  mkPos(store, { symbol: 'ZZZ' });
  await fails(P.approveProposal(p.id), 'no_slots');
  config.maxOpenPositions = 10;
  store.setPositions([]);
  // symbol already open
  mkPos(store, { symbol: 'AAPL' });
  await fails(P.approveProposal(p.id), 'risk_blocked');
  store.setPositions([]);
  // exposure caps: existing exposure leaves < $100 of room
  mkPos(store, { symbol: 'BBB', allocation: 79_950 });
  const e = await fails(P.approveProposal(p.id), 'risk_blocked');
  assert.match(e.message, /exposure cap/);
  store.setPositions([]);
  // daily loss halt: equity fell 5% today
  store.setDayStart({ day: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), equity: 105000 });
  const halt = await fails(P.approveProposal(p.id), 'risk_blocked');
  assert.equal(halt.details.reason, 'daily_loss_halt');
  store.setDayStart(null);
  // worker stopped
  store.setWorker({ ...store.getWorker(), status: 'stopped' });
  await fails(P.approveProposal(p.id), 'worker_not_running');
  store.setWorker({ ...store.getWorker(), status: 'online' });
  // quote unavailable
  fake.fail.add('AAPL');
  const na = await fails(P.approveProposal(p.id), 'stale_quote');
  assert.equal(na.details.unavailable, true);
  fake.fail.clear();
  // crypto short
  const [c] = make([item('BTC/USD', { side: 'short', quoted: 100 })]);
  flat('BTC/USD', 100);
  await fails(P.approveProposal(c.id), 'risk_blocked');
  assert.equal(openPositions().length, 0);
  // everything cleared: it opens (allocation is re-sized against the fresh account, never raised)
  const ok = await P.approveProposal(p.id);
  assert.ok(ok.position.allocation <= 5000 + 1e-6);
});

test('approval re-runs the per-trade risk cap with the fresh account (allocation is cut, not trusted)', async () => {
  flat('AAPL', 100);
  const [p] = make([item('AAPL', { alloc: 50_000, stop: 96 })]); // proposal carried an oversized allocation
  const r = await P.approveProposal(p.id);
  assert.ok(r.position.allocation <= 100_000 * 0.2 + 1e-6);
  const lossFrac = 0.04 + (5 + 10) / 10_000;
  assert.ok(r.position.allocation * lossFrac <= 100_000 * 0.02 + 0.5);
  assert.ok(r.proposal.approval.riskCheck.riskPct <= 2.01);
});

test('GET /api/proposals: filters, limit, counts, secondsLeft; bad status is a 400', async () => {
  const [a, b, c] = make([item('AAPL'), item('MSFT'), item('XOM')]);
  P.rejectProposal(b.id);
  const all = await api('/proposals');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.counts, { total: 3, pending: 2, approved: 0, rejected: 1, expired: 0, superseded: 0 });
  const pend = await api('/proposals?status=pending&limit=1');
  assert.equal(pend.body.proposals.length, 1);
  assert.ok(pend.body.proposals[0].secondsLeft > 5 * 3600);
  assert.equal((await api('/proposals?status=rejected')).body.proposals[0].id, b.id);
  assert.equal((await api('/proposals?status=nonsense')).status, 400);
  void a;
  void c;
});

test('HTTP approve maps errors to 409 + code + details; 404 for unknown ids', async () => {
  const [p] = make([item('AAPL')]);
  flat('AAPL', 120);
  const r = await api(`/proposals/${p.id}/approve`, 'POST');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'price_moved');
  assert.equal(r.body.details.freshPrice, 120);
  assert.ok(r.body.error);
  const nf = await api('/proposals/prop_nope/approve', 'POST');
  assert.equal(nf.status, 404);
  assert.equal(nf.body.code, 'not_found');
});

// ---- trader -> proposals, and the auto-approve switch ----
const run = (picks = [{ symbol: 'AAPL', direction: 'long', confidence: 0.8, price: 100, atrPct: 2, reason: 't' }, { symbol: 'XOM', direction: 'short', confidence: 0.7, price: 100, atrPct: 2, reason: 't' }]) => runTraderBot(picks, { runId: `run_${Date.now()}` });

test('auto-approve is OFF by default: a run proposes and opens NOTHING', async () => {
  stubOpenRouter();
  assert.equal(store.getSettings().autoApprove, false);
  const r = await run();
  assert.equal(r.proposals.length, 2);
  assert.deepEqual(r.autoApproved, []);
  assert.equal(openPositions().length, 0);
  assert.ok(store.getProposals().every((p) => p.status === 'pending'));
});

test('auto-approve only when exactly true; guard rails: size limit, risk re-check, stale quote, demo, logging', async () => {
  stubOpenRouter();
  for (const v of ['true', 1, 'yes', null, undefined]) {
    store.setSettings({ ...store.getSettings(), autoApprove: v });
    const r = await run();
    assert.equal(openPositions().length, 0, `autoApprove=${String(v)}`);
    assert.deepEqual(r.autoApproved, []);
    store.setProposals([]);
  }
  // ON but the allocation cap per trade is tiny: stays pending
  store.setSettings({ ...store.getSettings(), autoApprove: true, autoApproveMaxAllocPct: 0.1 });
  let r = await run();
  assert.equal(openPositions().length, 0);
  assert.equal(r.proposals.length, 2);
  assert.ok(store.getLogs().some((l) => /AUTO-APPROVE skipped AAPL/.test(l.message)));
  store.setProposals([]);
  // ON with room: opens through the full approval path, marked decidedBy 'auto' and logged loudly
  store.setSettings({ ...store.getSettings(), autoApprove: true, autoApproveMaxAllocPct: 25 });
  r = await run();
  assert.equal(r.autoApproved.length, 2);
  assert.equal(openPositions().length, 2);
  assert.ok(store.getProposals().every((p) => p.status === 'approved' && p.decidedBy === 'auto'));
  assert.ok(store.getLogs().some((l) => /AUTO-APPROVED LONG AAPL/.test(l.message)));
  // ON but the quote is stale: nothing opens, proposals stay pending
  store.setPositions([]);
  store.setProposals([]);
  fake.stale.add('AAPL');
  fake.stale.add('XOM');
  r = await run();
  assert.equal(r.proposals.length, 0); // stale quotes are refused at proposal time already
  fake.stale.clear();
  // ON but the worker is stopped: the trader creates no proposals at all
  store.setWorker({ ...store.getWorker(), status: 'stopped' });
  r = await run();
  assert.equal(r.proposals.length, 0);
  store.setWorker({ ...store.getWorker(), status: 'online' });
  // ON but the caps leave no room at approval time: the proposal remains pending, nothing is forced
  store.setSettings({ ...store.getSettings(), autoApprove: true, autoApproveMaxAllocPct: 25 });
  flat('AAPL', 100);
  const [full] = make([item('AAPL', { alloc: 1000 })], 'run_full');
  mkPos(store, { symbol: 'BBB', allocation: 79_950 });
  const blocked = await P.autoApproveProposals([full]);
  assert.deepEqual(blocked.approved, []);
  assert.match(blocked.skipped[0].reason, /^risk_blocked/);
  assert.equal(store.getProposals().find((p) => p.id === full.id).status, 'pending');
  assert.equal(openPositions().length, 1); // only the BBB fixture
  store.setPositions([]);
  // demo proposals are never auto-approved
  const [d] = make([item('AAPL', { alloc: 1000 })], 'run_demo', 'demo');
  const auto = await P.autoApproveProposals([d]);
  assert.deepEqual(auto.approved, []);
  assert.equal(auto.skipped[0].reason, 'demo proposal');
});

test('trader proposals carry the risk engine: caps apply across the run, stale quotes and crypto shorts are refused at proposal time', async () => {
  stubOpenRouter();
  store.setSettings({ ...store.getSettings(), maxPerGroup: 1 });
  fake.stale.add('MSFT');
  const picks = [
    { symbol: 'AAPL', direction: 'long', confidence: 0.9, price: 100, atrPct: 2, reason: 't' },
    { symbol: 'GOOGL', direction: 'long', confidence: 0.85, price: 100, atrPct: 2, reason: 't' }, // same group as AAPL
    { symbol: 'MSFT', direction: 'long', confidence: 0.8, price: 100, atrPct: 2, reason: 't' }, // stale
    { symbol: 'BTC/USD', direction: 'short', confidence: 0.7, price: 100, atrPct: 2, reason: 't' }, // filtered before the model
  ];
  const r = await runTraderBot(picks, { runId: 'run_rc' });
  assert.deepEqual(r.proposals.map((p) => p.symbol), ['AAPL']);
  assert.ok(r.skippedList.some((s) => /GOOGL \(group limit/.test(s)));
  assert.ok(r.skippedList.some((s) => /MSFT \(stale quote/.test(s)));
  const p = r.proposals[0];
  assert.ok(p.riskCheck.grossExposureAfterUsd >= p.allocationUsd);
  assert.ok(p.riskCheck.riskPct <= 2.001);
  assert.equal(p.riskCheck.assetClass, 'equity');
  assert.ok(Array.isArray(p.riskCheck.notes));
});
