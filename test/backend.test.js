import './setup.js';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fake, resetFake, bar, ago, mkPos, stubOpenRouter } from './helpers.js';

const { store, MAX_POSITIONS } = await import('../server/db/store.js');
const { runTraderBot } = await import('../server/services/traderBot.js');
const { approveAll } = await import('../server/services/proposals.js');
const { getAccount, closeAll } = await import('../server/services/positions.js');
const { usMarketOpen, etDayStart } = await import('../server/services/market.js');
const { dailyPnl } = await import('../server/services/risk.js');
const { rateLimit, clientKey, warnIfProxyMisconfigured } = await import('../server/middleware.js');
const { guarded } = await import('../server/services/jobs.js');
const { config } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const { feeFor } = await import('../server/services/fills.js');

const START = config.paperEquity;
const pick = (symbol, direction, price = 100) => ({ symbol, direction, confidence: 0.8, price, atrPct: 2, reason: 'test' });
beforeEach(() => {
  resetFake();
  stubOpenRouter();
  store.setPositions([]);
  store.setProposals([]);
  store.setSettings({ ...store.getSettings(), slippageBps: 5, feeBps: 5, breakEven: true, trailR: 0 });
});

test('trader refetches a fresh quote for entry (not the scanner price)', async () => {
  fake.bars.set('AAPL', [bar(1, 120, 121, 119, 120)]);
  const r = await runTraderBot([pick('AAPL', 'long', 100)]); // scanner said 100, market is 120
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].entry, 120); // fresh quote, not the scanner's 100
  assert.ok(Math.abs(r.proposals[0].entryFill - 120 * 1.0005) < 0.01);
  assert.ok(r.proposals[0].stopLoss < 120 && r.proposals[0].stopLoss > 100);
});

test('trader skips stale or unavailable quotes and records "stale quote"', async () => {
  fake.stale.add('AAPL');
  fake.fail.add('MSFT');
  const r = await runTraderBot([pick('AAPL', 'long'), pick('MSFT', 'long')]);
  assert.equal(r.proposals.length, 0);
  assert.equal(r.skippedList.length, 2);
  assert.ok(r.skippedList.every((s) => /stale quote/.test(s)));
});

test('trader records replaced (out-of-range / wrong-side) stops in notes and adjustedList', async () => {
  fake.bars.set('AAPL', [bar(1, 120, 121, 119, 120)]); // scanner price 100 -> rule stop 96 is 20% below the real entry
  const r = await runTraderBot([pick('AAPL', 'long', 100)]);
  assert.equal(r.proposals.length, 1);
  assert.equal(r.adjustedList.length >= 1, true);
  assert.ok(r.adjustedList.some((a) => /AAPL: stop .*out of range.*2 ATR/.test(a)));
  assert.match(r.note, /levels replaced/);
  assert.ok(store.getLogs().some((l) => /replaced levels/.test(l.message)));
});

test('account math: fees and slippage are deducted exactly once (open and closed)', async () => {
  const r = await runTraderBot([pick('AAPL', 'long'), pick('XOM', 'short')]);
  assert.equal(r.proposals.length, 2);
  assert.equal((await approveAll()).approved.length, 2);
  const px = 100; // mark price for the fake
  const open = store.getPositions();
  const fees = open.reduce((s, p) => s + p.fees, 0);
  const alloc = open.reduce((s, p) => s + p.allocation, 0);
  assert.ok(fees > 0);
  const acct = getAccount({ AAPL: px, XOM: px });
  const gross = open.reduce((s, p) => s + (p.side === 'long' ? px - p.entry : p.entry - px) * p.qty, 0);
  assert.ok(Math.abs(acct.cash - (START - alloc - fees)) < 0.02, `cash ${acct.cash}`);
  assert.ok(Math.abs(acct.equity - (START + gross - fees)) < 0.03, `equity ${acct.equity}`);
  assert.ok(Math.abs(acct.equity - (acct.cash + acct.allocated + gross)) < 0.03);
  // close at the same mark: realized = gross P&L - entry fee - exit fee (each once)
  fake.bars.set('AAPL', [bar(1, px, px, px, px)]);
  fake.bars.set('XOM', [bar(1, px, px, px, px)]);
  const res = await closeAll();
  assert.equal(res.closed, 2);
  const closed = store.getPositions();
  for (const p of closed) {
    const exitFee = feeFor(p.exitPrice * p.qty, 5);
    const entryFee = feeFor(p.allocation, 5);
    assert.ok(Math.abs(p.fees - (entryFee + exitFee)) < 0.02);
    const g = (p.side === 'long' ? p.exitPrice - p.entry : p.entry - p.exitPrice) * p.qty;
    assert.ok(Math.abs(p.pnl - (g - p.fees)) < 0.02);
  }
  const after = getAccount();
  assert.ok(Math.abs(after.equity - after.cash) < 0.01);
  assert.ok(Math.abs(after.realizedPnl - closed.reduce((s, p) => s + p.pnl, 0)) < 0.02);
});

test('NYSE holidays and half-days', () => {
  assert.equal(usMarketOpen(new Date('2026-07-02T15:00:00Z')), true); // Thu 11:00 ET
  assert.equal(usMarketOpen(new Date('2026-07-03T15:00:00Z')), false); // Independence Day observed
  assert.equal(usMarketOpen(new Date('2025-12-25T15:00:00Z')), false);
  assert.equal(usMarketOpen(new Date('2027-01-18T15:00:00Z')), false); // MLK
  assert.equal(usMarketOpen(new Date('2026-11-27T17:30:00Z')), true); // half-day 12:30 ET
  assert.equal(usMarketOpen(new Date('2026-11-27T18:30:00Z')), false); // after the 13:00 early close
  assert.equal(usMarketOpen(new Date('2026-11-25T18:30:00Z')), true); // normal day
  assert.equal(usMarketOpen(new Date('2026-01-10T15:00:00Z')), false); // Saturday
});

test('dailyPnl uses the US/Eastern trading day, not UTC midnight', () => {
  const now = new Date('2026-01-15T03:00:00Z'); // 22:00 ET on Jan 14
  assert.equal(new Date(etDayStart(now)).toISOString(), '2026-01-14T05:00:00.000Z');
  assert.equal(new Date(etDayStart(new Date('2026-07-15T03:00:00Z'))).toISOString(), '2026-07-14T04:00:00.000Z'); // EDT
  const closed = (at, pnl) => ({ status: 'closed', closedAt: at, pnl });
  const ps = [closed('2026-01-14T20:00:00Z', -100), closed('2026-01-14T02:00:00Z', -999)];
  assert.equal(dailyPnl(ps, 0, etDayStart(now)), -100);
});

test('rate limiter: refunds no-op responses, keys on X-Forwarded-For only with TRUST_PROXY', () => {
  const lim = rateLimit({ windowMs: 60_000, max: 2, name: 't', refundWhen: (res) => res.statusCode === 200 });
  const call = (ip, status) => {
    const res = new EventEmitter();
    res.statusCode = status;
    res.set = () => {};
    let code = null;
    res.status = (c) => ((code = c), { json() {} });
    lim({ ip, get: () => undefined }, res, () => res.emit('finish'));
    return code;
  };
  for (let i = 0; i < 5; i++) assert.equal(call('1.1.1.1', 200), null); // 200s are refunded
  assert.equal(call('1.1.1.1', 202), null);
  assert.equal(call('1.1.1.1', 202), null);
  assert.equal(call('1.1.1.1', 202), 429);
  assert.equal(call('2.2.2.2', 202), null); // separate bucket
  const req = { ip: '10.0.0.1', get: (h) => (h === 'x-forwarded-for' ? '9.9.9.9, 5.5.5.5' : undefined) };
  assert.equal(clientKey(req), '10.0.0.1');
  config.trustProxy = true;
  assert.equal(clientKey(req), '5.5.5.5');
  assert.equal(warnIfProxyMisconfigured(), false);
  config.trustProxy = false;
  const prev = process.env.RENDER;
  process.env.RENDER = 'true';
  const warn = console.warn;
  console.warn = () => {};
  let logged = '';
  assert.equal(warnIfProxyMisconfigured((m) => (logged = m)), true);
  console.warn = warn;
  assert.match(logged, /TRUST_PROXY/);
  if (prev === undefined) delete process.env.RENDER;
});

test('cron guard logs errors and prevents overlap', async () => {
  let runs = 0;
  let release;
  const slow = guarded('slow', () => new Promise((r) => { runs++; release = r; }));
  const a = slow();
  assert.equal(await slow(), false); // skipped while running
  release();
  assert.equal(await a, true);
  assert.equal(runs, 1);
  const bad = guarded('bad', async () => { throw new Error('kaboom'); });
  const origErr = console.error;
  console.error = () => {};
  assert.equal(await bad(), false);
  console.error = origErr;
  assert.ok(store.getLogs().some((l) => /cron bad failed: kaboom/.test(l.message)));
  assert.equal(await bad(), false); // guard released after failure
});

test('store: cached reads are isolated clones; positions beyond the cap are archived, never dropped', () => {
  const a = store.getSettings();
  a.horizonHours = 999;
  assert.notEqual(store.getSettings().horizonHours, 999);
  const many = Array.from({ length: MAX_POSITIONS + 5 }, (_, i) => ({ id: `c${i}`, status: 'closed', symbol: 'X' }));
  many.push({ id: 'open1', status: 'open', symbol: 'Y' });
  store.setPositions(many);
  const kept = store.getPositions();
  assert.equal(kept.length, MAX_POSITIONS);
  assert.ok(kept.some((p) => p.id === 'open1'));
  const arch = store.getPositionsArchive();
  assert.equal(arch.length, 6);
  assert.ok(arch.every((p) => p.status === 'closed'));
});

// ---------- HTTP ----------
let server;
let base;
const started = new Promise((resolve) => {
  server = createApp().listen(0, '127.0.0.1', () => resolve((base = `http://127.0.0.1:${server.address().port}`)));
});
after(() => server.close());
const api = async (path, opts = {}) => {
  await started;
  const res = await fetch(`${base}/api${path}`, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { html: true };
  }
  return { status: res.status, body };
};

test('routes: close errors map to 404 / 502 / 409, force closes', async () => {
  assert.equal((await api('/positions/nope/close', { method: 'POST' })).status, 404);
  const id = mkPos(store, { symbol: 'AAA' });
  fake.fail.add('AAA');
  const noQuote = await api(`/positions/${id}/close`, { method: 'POST' });
  assert.equal(noQuote.status, 502);
  assert.equal(noQuote.body.code, 'no_quote');
  fake.fail.clear();
  fake.bars.set('AAA', [bar(1, 100, 102, 99, 101)]);
  fake.stale.add('AAA');
  const stale = await api(`/positions/${id}/close`, { method: 'POST' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale_quote');
  const forced = await api(`/positions/${id}/close?force=1`, { method: 'POST' });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.exitReason, 'manual');
  assert.equal(forced.body.exitPrice > 0, true);
});

test('routes: close-all reports closed + failed; all-failed maps to 409/502', async () => {
  const a = mkPos(store, { symbol: 'AAA' });
  mkPos(store, { symbol: 'BBB' });
  fake.stale.add('BBB');
  const partial = await api('/positions/close-all', { method: 'POST' });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.closed, 1);
  assert.equal(partial.body.failed[0].symbol, 'BBB');
  const none = await api('/positions/close-all', { method: 'POST' });
  assert.equal(none.status, 409);
  assert.equal(none.body.closed, 0);
  fake.stale.clear();
  fake.fail.add('BBB');
  assert.equal((await api('/positions/close-all', { method: 'POST' })).status, 502);
  fake.fail.clear();
  assert.equal((await api('/positions/close-all', { method: 'POST', body: { force: true } })).body.closed, 1);
  void a;
});

test('routes: retired legacy endpoints are gone; status/settings stay', async () => {
  for (const p of ['/train', '/model', '/evaluate', '/watchlist', '/predictions', '/predictions/open', '/accuracy', '/scan']) {
    const r = await api(p, { method: p === '/train' || p === '/evaluate' || p === '/scan' ? 'POST' : 'GET' });
    assert.equal(r.status, 404, `${p} should be a JSON 404 (never an API handler, never the SPA page)`);
    assert.equal(r.body.error, 'not found');
  }
  const s = await api('/status');
  assert.equal(s.status, 200);
  assert.equal(typeof s.body.marketOpen, 'boolean');
  assert.equal((await api('/market/quote/bad%20sym')).status, 400);
  assert.equal((await api('/dashboard')).status, 200);
});

test('run flow with fake alpaca: POST /run -> positions, performance, status', async () => {
  const r = await api('/run', { method: 'POST' });
  assert.ok([200, 202].includes(r.status));
  for (let i = 0; i < 200; i++) {
    if (!(await api('/run/status')).body.running) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const st = await api('/run/status');
  assert.equal(st.body.running, false);
  assert.equal(st.body.error, null, st.body.error);
  const summary = (await api('/ai/summary')).body;
  assert.ok(summary.runId && !summary.error);
  assert.ok(Array.isArray(summary.rejected) && Array.isArray(summary.adjusted));
  assert.ok(summary.proposalCount > 0 && summary.proposals.length === summary.proposalCount);
  assert.equal(st.body.proposals, summary.proposalCount);
  // the trader only proposes: nothing is open until the owner approves
  assert.equal((await api('/positions')).body.open.length, 0);
  const props = (await api('/proposals?status=pending')).body;
  assert.equal(props.proposals.length, summary.proposalCount);
  const one = await api(`/proposals/${props.proposals[0].id}/approve`, { method: 'POST' });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const positions = (await api('/positions')).body;
  assert.equal(positions.open.length, 1);
  assert.ok(positions.open.every((p) => p.expired === false && p.stale === false));
  assert.equal(positions.account.openCount, positions.open.length);
  const perf = (await api('/performance')).body;
  assert.ok(Array.isArray(perf.equityCurve));
  assert.equal((await api('/status')).status, 200);
});
