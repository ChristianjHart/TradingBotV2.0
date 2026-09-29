import './setup.js';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fake, resetFake, bar, ago, mkPos } from './helpers.js';

const { store } = await import('../server/db/store.js');
const { config } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const { asyncHandler, CSP } = await import('../server/middleware.js');
const { installProcessHandlers, flushAll } = await import('../server/lifecycle.js');
const { runTraderBot, sanitizeTrades } = await import('../server/services/traderBot.js');
const { sanitizePicks, runScannerBot } = await import('../server/services/aiScanner.js');
const { monitorPositions } = await import('../server/services/positions.js');
const { scorePicks, recordPicks } = await import('../server/services/pickScoring.js');
const { todaysPnl, startOfDayEquity, dailyPnlFromEquity } = await import('../server/services/risk.js');
const { etDayStart, isStale, usMarketOpen, sessionMinutesBetween } = await import('../server/services/market.js');
const { simulateExit } = await import('../server/services/exits.js');
const { reasonsFor } = await import('../server/services/predictor.js');

const pick = (symbol, direction, confidence = 0.8, price = 100) => ({ symbol, direction, confidence, price, atrPct: 2, reason: 'test' });
const realFetch = globalThis.fetch;
let server;
let base;
await new Promise((r) => (server = createApp().listen(0, '127.0.0.1', () => r((base = `http://127.0.0.1:${server.address().port}`)))));
after(() => {
  server.close();
  globalThis.fetch = realFetch;
  config.openrouter.key = '';
});
const get = (p, opts) => realFetch(`${base}${p}`, opts);

beforeEach(() => {
  resetFake();
  store.setPositions([]);
  store.setPickScores([]);
  store.setEquity([]);
  store.setDayStart(null);
  store.setWorker({ ...store.getWorker(), status: 'online' });
  store.setSettings({ ...store.getSettings(), slippageBps: 5, feeBps: 5, breakEven: true, trailR: 0 });
  globalThis.fetch = realFetch;
  config.openrouter.key = '';
  config.paperEquity = 100000;
});

// ---- 1. crash + async errors + security headers ----
test('malformed percent-escapes return 400 and the server keeps answering', async () => {
  for (const p of ['/api/market/quote/%25zz', '/api/market/quote/%zz', '/api/market/bars/%25zz', '/api/market/quotes?symbols=%25zz']) {
    const r = await get(p);
    assert.equal(r.status, 400, p);
  }
  assert.equal((await get('/api/health')).status, 200);
});

test('asyncHandler forwards rejections to next(); process handlers log and survive', async () => {
  let got;
  asyncHandler(async () => { throw new Error('async boom'); })({}, {}, (e) => (got = e));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(got.message, 'async boom');
  const logs = [];
  const h = installProcessHandlers({ log: (lvl, m) => logs.push([lvl, m]), exit: () => assert.fail('must not exit on one error') });
  h.onRejection(new Error('rejected'));
  assert.match(logs[0][1], /unhandledRejection: Error: rejected/);
  h.onException(new Error('thrown')); // survives
});

test('security headers on API and page; CSP allows tradingview + google fonts only', async () => {
  for (const p of ['/', '/api/health']) {
    const r = await get(p);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.ok(r.headers.get('referrer-policy'));
    const csp = r.headers.get('content-security-policy');
    assert.equal(csp, CSP);
    assert.match(csp, /script-src 'self' https:\/\/s3\.tradingview\.com https:\/\/\*\.tradingview\.com/);
    assert.match(csp, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
    assert.doesNotMatch(csp, /(^|; )script-src '[^;]*unsafe-inline/);
  }
});

test('flushAll writes debounced logs to disk even with Supabase disabled', async () => {
  store.addLog({ message: 'flush-me-on-sigterm' });
  await flushAll();
  assert.match(fs.readFileSync(path.join(config.dataDir, 'logs.json'), 'utf8'), /flush-me-on-sigterm/);
});

// ---- 7. market endpoints restricted ----
test('market endpoints only serve the universe or open-position symbols', async () => {
  assert.equal((await get('/api/market/quote/AAPL')).status, 200);
  assert.equal((await get('/api/market/quote/BTC%2FUSD')).status, 200);
  assert.equal((await get('/api/market/quote/NOTREAL')).status, 400);
  assert.equal((await get('/api/market/quotes?symbols=AAPL,NOTREAL')).status, 400);
  mkPos(store, { symbol: 'ZZOPEN' });
  assert.equal((await get('/api/market/quote/ZZOPEN')).status, 200);
});

// ---- 2. failed data: callers skip ----
test('monitor skips positions whose data failed and logs ONE line per cycle; nothing is closed', async () => {
  const a = mkPos(store, { symbol: 'AAA' });
  const b = mkPos(store, { symbol: 'BBB' });
  fake.fail.add('AAA');
  fake.fail.add('BBB');
  const before = store.getLogs().length;
  await monitorPositions();
  const lines = store.getLogs().slice(0, store.getLogs().length - before).filter((l) => /monitor: skipped/.test(l.message));
  assert.equal(lines.length, 1);
  assert.ok(/AAA/.test(lines[0].message) && /BBB/.test(lines[0].message));
  assert.ok([a, b].every((id) => store.getPositions().find((p) => p.id === id).status === 'open'));
});

test('trader rejects candidates whose quote fails; scoring skips and retries later', async () => {
  fake.fail.add('AAPL');
  const r = await runTraderBot([pick('AAPL', 'long')]);
  assert.equal(r.opened.length, 0);
  assert.equal(r.skippedList.length, 1);
  store.setPickScores([{ id: 'p1', runId: 'r', symbol: 'AAPL', direction: 'long', confidence: 0.7, price: 100, at: ago(30), dueAt: ago(3), scored: false }]);
  const s = await scorePicks();
  assert.equal(s.scored, 0);
  assert.equal(store.getPickScores()[0].scored, false);
  assert.ok(store.getLogs().some((l) => /pick scoring: skipped 1 symbol/.test(l.message)));
});

// ---- 3. hostile LLM shapes ----
test('sanitizeTrades drops bad entries and rejects bad overall shapes', () => {
  for (const bad of [null, 'text', 5, [], { trades: 'x' }, { trades: {} }, { trades: null }, { trades: [null, 5, 'a', [], {}, { symbol: 7 }, { symbol: 'AAPL' }] }]) {
    assert.equal(sanitizeTrades(bad), null, JSON.stringify(bad));
  }
  const ok = sanitizeTrades({ summary: 9, trades: [null, { symbol: 'AAPL', side: 'LONG', allocationUsd: '500', stopLoss: 'NaN', takeProfit: 'abc', reason: {} }, 'x', { symbol: 'bad sym!', side: 'long' }] });
  assert.equal(ok.trades.length, 1);
  assert.equal(ok.dropped, 3);
  assert.deepEqual([ok.trades[0].side, ok.trades[0].allocationUsd, ok.trades[0].stopLoss, ok.trades[0].takeProfit, ok.trades[0].reason], ['long', 500, undefined, undefined, '']);
  assert.equal(ok.summary, '');
  assert.deepEqual(sanitizeTrades({ trades: [] }).trades, []); // a legitimate "no trades"
  const huge = sanitizeTrades({ trades: Array.from({ length: 50_000 }, () => ({ symbol: 'AAPL', side: 'long' })) });
  assert.equal(huge.trades.length, 100);
});

test('sanitizePicks handles hostile shapes', () => {
  const known = new Map([['AAPL', {}], ['MSFT', {}]]);
  for (const bad of [null, 'x', 3, [], { picks: 'x' }, { picks: { a: 1 } }]) assert.throws(() => sanitizePicks(bad, known), /unusable/);
  const out = sanitizePicks({ picks: [null, 1, 'AAPL', [], { symbol: 'AAPL', direction: 'long', confidence: 'NaN' }, { symbol: 'MSFT', direction: 'short', confidence: '0.7', reason: 42 }, { symbol: 'ZZZ', direction: 'long' }, { symbol: { x: 1 }, direction: 'long' }, { symbol: 'MSFT', direction: 'sideways' }] }, known);
  assert.deepEqual(out.map((p) => [p.symbol, p.confidence, p.reason]), [['AAPL', 0, ''], ['MSFT', 0.7, '']]);
  assert.equal(sanitizePicks({ picks: Array.from({ length: 100_000 }, () => ({ symbol: 'AAPL', direction: 'long', confidence: 2 })) }, known).length, 500);
});

function stubLlm(content) {
  config.openrouter.key = 'k';
  globalThis.fetch = (url, opts) =>
    String(url).startsWith('http://127.0.0.1') ? realFetch(url, opts) : Promise.resolve(Response.json({ choices: [{ message: { content } }] }));
}

test('trader falls back to the rules trader (and logs) on a garbage LLM shape', async () => {
  for (const content of ['"just a string"', '{"trades":"AAPL"}', '{"trades":[null,7,"x"]}']) {
    store.setPositions([]);
    stubLlm(content);
    const r = await runTraderBot([pick('AAPL', 'long')]);
    assert.equal(r.source, 'rules', content);
    assert.equal(r.opened.length, 1);
  }
  assert.ok(store.getLogs().some((l) => /trader bot AI failed .*unusable JSON shape/.test(l.message)));
});

test('scanner falls back to rules on a hostile picks shape', async () => {
  const data = ['AAPL', 'MSFT'].map((symbol) => ({ symbol, price: 100, atrPct: 2, bars: fake.bars.get(symbol) || Array.from({ length: 60 }, (_, i) => ({ t: ago(60 - i), o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1000 })) }));
  stubLlm('{"picks":{"AAPL":1}}');
  const r = await runScannerBot(data, {});
  assert.equal(r.source, 'rules');
});

// ---- 5. scorePicks race ----
test('scorePicks does not lose picks recorded while it awaits bar data', async () => {
  store.setPickScores([{ id: 'old1', runId: 'r0', symbol: 'AAA', direction: 'long', confidence: 0.7, price: 100, at: ago(30), dueAt: ago(3), scored: false }]);
  fake.bars.set('AAA', [bar(2, 101, 102, 100, 101)]);
  fake.delayMs.set('AAA', 60);
  const scoring = scorePicks();
  await new Promise((r) => setTimeout(r, 15));
  recordPicks('run_new', [pick('BBB', 'short')]);
  const res = await scoring;
  assert.equal(res.scored, 1);
  const all = store.getPickScores();
  assert.equal(all.length, 2);
  assert.equal(all.find((p) => p.id === 'old1').scored, true);
  assert.ok(all.some((p) => p.id === 'run_new_BBB' && !p.scored));
});

// ---- 8. daily P&L from equity ----
test('daily P&L = equity now - start-of-ET-day equity; carried unrealized loss is not counted again', () => {
  const now = new Date('2026-09-29T15:00:00Z');
  const since = etDayStart(now);
  store.setEquity([{ t: '2026-09-28T20:00:00Z', equity: 97500 }]); // yesterday's close: already down 2.5%
  assert.equal(todaysPnl(97500, { now }), 0); // old formula would have reported the whole unrealized -2500
  assert.equal(store.getDayStart().day, '2026-09-29');
  assert.equal(store.getDayStart().equity, 97500);
  assert.equal(todaysPnl(94000, { now }), -3500);
  store.setEquity([]); // persisted snapshot wins over any later history
  assert.equal(todaysPnl(97000, { now }), -500);
  assert.equal(dailyPnlFromEquity(101, 100), 1);
  // first day, no snapshots: starting equity + realized before the day started
  const first = startOfDayEquity({ saved: null, snapshots: [], positions: [{ status: 'closed', closedAt: '2026-09-27T10:00:00Z', pnl: -400 }, { status: 'closed', closedAt: '2026-09-29T14:00:00Z', pnl: -100 }], since, startingEquity: 100000 });
  assert.equal(first, 99600);
  // stale saved day is ignored
  assert.equal(startOfDayEquity({ saved: { day: '2026-09-28', equity: 1 }, snapshots: [], positions: [], since, startingEquity: 5 }), 5);
});

// ---- 9. risk cap includes exit costs; worker status ----
test('per-trade risk cap includes exit slippage and both fees', async () => {
  store.setSettings({ ...store.getSettings(), slippageBps: 50, feeBps: 50 });
  const r = await runTraderBot([{ ...pick('AAPL', 'long'), atrPct: 7 }]); // rules stop = 2 ATR = 14% below entry
  const p = r.opened[0];
  const stopDist = (p.entry - p.stopLoss) / p.entry;
  assert.ok(Math.abs(stopDist - 0.14) < 0.01);
  const worstLoss = p.allocation * (stopDist + 0.005 + 0.01);
  assert.ok(worstLoss <= 100000 * 0.02 + 0.5, `worst-case loss ${worstLoss}`);
  assert.ok(p.allocation > 12000 && p.allocation < 13500, `alloc ${p.allocation}`); // 2000/0.155 = 12903 (was 14286 without exit costs)
});

test('stopped/killed worker: /run is 409 and the trader opens nothing; monitor still closes on a stop', async () => {
  const id = mkPos(store, { symbol: 'AAA' });
  for (const status of ['stopped', 'killed']) {
    store.setWorker({ ...store.getWorker(), status });
    const r = await get('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.code, 'worker_not_running');
    assert.match(body.error, new RegExp(status));
    const t = await runTraderBot([pick('AAPL', 'long')]);
    assert.equal(t.opened.length, 0);
    assert.equal(t.workerStatus, status);
  }
  fake.bars.set('AAA', [bar(3, 100, 101, 90, 92)]);
  await monitorPositions(); // exits are still managed
  assert.equal(store.getPositions().find((p) => p.id === id).status, 'closed');
});

// ---- 10. staleness + entry bar ----
test('equity staleness: closed = stale; open = stale only after >2 missed session hours', () => {
  const t = (bar, now) => isStale('AAPL', bar, new Date(now));
  assert.equal(t('2026-09-28T19:00:00Z', '2026-09-29T13:45:00Z'), false); // 09:45 ET, last bar = yesterday 15:00: not stale at the open
  assert.equal(t('2026-09-29T15:00:00Z', '2026-09-29T17:31:00Z'), false); // recent
  assert.equal(t('2026-09-29T14:00:00Z', '2026-09-29T16:31:00Z'), false); // thin symbol missed ~1.5 bars
  assert.equal(t('2026-09-29T13:30:00Z', '2026-09-29T17:31:00Z'), true); // >2 missed
  assert.equal(t('2026-09-29T19:00:00Z', '2026-09-29T21:00:00Z'), true); // closed
  assert.equal(isStale('BTC/USD', '2026-09-29T09:00:00Z', new Date('2026-09-29T14:00:00Z')), true);
  assert.equal(isStale('BTC/USD', '2026-09-29T12:00:00Z', new Date('2026-09-29T14:00:00Z')), false);
  assert.equal(sessionMinutesBetween(Date.parse('2026-09-25T20:00:00Z'), Date.parse('2026-09-28T13:45:00Z')), 15); // weekend skipped
});

test('exits still work on the last known bar when the quote is stale; time-exit waits', async () => {
  const id = mkPos(store, { symbol: 'AAA', openedAt: ago(30), expiresAt: ago(6) });
  fake.bars.set('AAA', [bar(3, 100, 101, 90, 92)]);
  fake.stale.add('AAA');
  await monitorPositions();
  const p = store.getPositions().find((x) => x.id === id);
  assert.equal(p.status, 'closed');
  assert.equal(p.exitReason, 'stop-loss');
});

test('entry bar counts only through its close (no pre-entry lows); close beyond the stop exits at the stop', () => {
  const T = Date.parse('2026-01-05T15:30:00Z'); // opened mid-bar
  const p = { side: 'long', entry: 100, stopLoss: 95, initialStop: 95, takeProfit: 110, qty: 1, openedAt: new Date(T).toISOString(), expiresAt: new Date(T + 24 * 3600_000).toISOString() };
  const entryBar = (l, c) => ({ t: '2026-01-05T15:00:00Z', o: 101, h: 102, l, c, v: 1 });
  const lowBeforeEntry = simulateExit(p, [entryBar(90, 99)], { now: T + 1800_000 }); // low 90 may pre-date our entry
  assert.equal(lowBeforeEntry.exit, null);
  const closeThroughStop = simulateExit(p, [entryBar(90, 94)], { now: T + 1800_000 });
  assert.equal(closeThroughStop.exit.reason, 'stop-loss');
  assert.equal(closeThroughStop.exit.price, 95);
  const closeThroughTarget = simulateExit(p, [entryBar(99, 111)], { now: T + 1800_000 });
  assert.equal(closeThroughTarget.exit.reason, 'take-profit');
});

test('NYSE 2028 calendar: closed on the real holidays, open on 2027-12-31 (New Year observed does not apply)', () => {
  const open = (iso) => usMarketOpen(new Date(iso));
  assert.equal(open('2027-12-31T15:00:00Z'), true);
  assert.equal(open('2028-01-03T15:00:00Z'), true); // Monday after the Saturday holiday
  for (const d of ['2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25']) assert.equal(open(`${d}T15:00:00Z`), false, d);
  assert.equal(open('2028-07-03T16:30:00Z'), true); // half day: open at 12:30 ET
  assert.equal(open('2028-07-03T17:30:00Z'), false); // closed after the 13:00 ET early close
  assert.equal(open('2028-11-24T18:30:00Z'), false);
  assert.equal(open('2028-11-24T17:30:00Z'), true); // 12:30 EST, before the early close
});

// ---- 11. rules fallback ----
test('rule reasons agree with direction', () => {
  const f = { rsi: 25, volumeRatio: 1 };
  const c = { momentum: 0.6, macdScore: 0.4, trend: 0.5 };
  const long = reasonsFor('long', f, c);
  assert.ok(long.includes('RSI oversold (bounce setup)') && long.includes('strong short-term momentum'));
  const short = reasonsFor('short', { rsi: 25, volumeRatio: 1 }, { momentum: -0.6, macdScore: -0.4, trend: -0.5 });
  assert.ok(short.includes('fading momentum'));
  assert.ok(!short.some((r) => /oversold/.test(r)), 'a short must not cite RSI oversold');
  assert.ok(!reasonsFor('long', { rsi: 80, volumeRatio: 1 }, { momentum: 0.5, macdScore: 0, trend: 0 }).some((r) => /overbought/.test(r)));
  assert.deepEqual(reasonsFor('short', { rsi: 50, volumeRatio: 1 }, { momentum: 0, macdScore: 0, trend: 0 }), ['composite score favours short']);
});

test('rules allocation is weighted by confidence within the caps', async () => {
  const r = await runTraderBot([pick('AAPL', 'long', 0.95), pick('XOM', 'long', 0.8), pick('JPM', 'long', 0.65), pick('UNH', 'long', 0.5)]);
  assert.equal(r.source, 'rules');
  const a = Object.fromEntries(r.opened.map((p) => [p.symbol, p.allocation]));
  assert.ok(a.AAPL >= a.XOM && a.XOM >= a.JPM && a.JPM > a.UNH, JSON.stringify(a));
  assert.ok(a.UNH < 95000 / 4, 'lowest confidence gets less than an equal split');
  assert.ok(Math.max(...Object.values(a)) <= 100000 * 0.2 + 0.01);
});
