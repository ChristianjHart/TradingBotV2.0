import './setup.js';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { realFetch } from './helpers.js';

const { store } = await import('../server/db/store.js');
const { config } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const K = await import('../server/services/kronos.js');
const { createProposals } = await import('../server/services/proposals.js');

let server;
let base;
await new Promise((r) => (server = createApp().listen(0, '127.0.0.1', () => r((base = `http://127.0.0.1:${server.address().port}`)))));

// A stand-in forecast service. `mode` decides what it sends back; `calls` counts requests.
let mode = 'up';
let calls = 0;
let lastBody = null;
let lastAuth = '';
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    calls += 1;
    lastAuth = req.headers.authorization || '';
    lastBody = JSON.parse(b);
    if (mode === 'deny') return res.writeHead(401).end('{}');
    if (mode === 'down') return res.writeHead(500).end('{}');
    if (mode === 'junk') return res.writeHead(200).end(JSON.stringify({ paths: [[{ h: -1, l: 2, c: 3 }]] }));
    const last = lastBody.bars[lastBody.bars.length - 1].c;
    const drift = mode === 'up' ? 1.01 : 0.99;
    const paths = Array.from({ length: lastBody.samples }, () => Array.from({ length: lastBody.horizon }, (_, i) => { const c = last * drift ** (i + 1); return { o: c, h: c * 1.001, l: c * 0.999, c }; }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'fake-kronos', paths }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
after(() => {
  server.close();
  fake.close();
  process.env.KRONOS_URL = '';
});
const api = async (p, method = 'GET') => {
  const r = await realFetch(`${base}/api${p}`, { method, headers: { 'content-type': 'application/json' } });
  return { status: r.status, body: await r.json() };
};
beforeEach(() => {
  process.env.KRONOS_URL = `http://127.0.0.1:${fake.address().port}/`;
  mode = 'up';
  calls = 0;
  store.setPositions([]);
  store.setProposals([]);
});
const make = (symbol = 'NVDA') => createProposals({ runId: `run_k_${symbol}`, items: [{ symbol, side: 'long', quoted: 100, entry: 100.05, stop: 96, target: 107, alloc: 5000, atrPct: 2, confidence: 0.7, reason: 'r', scannerReason: 's', setup: {}, riskCheck: { ok: true, notes: [] } }], source: 'ai', models: { scanner: 'a', trader: 'b' } })[0];

const candle = (c, h = c, l = c) => ({ h, l, c });
const longTrade = { side: 'long', entry: 100, stopLoss: 96, takeProfit: 107 };

test('replayPath: target, stop, same-hour tie counts as stop, time exit uses costs', () => {
  assert.deepEqual(K.replayPath([candle(101), candle(108, 108, 101)], longTrade), { exit: 'target', win: true });
  assert.deepEqual(K.replayPath([candle(97, 98, 95)], longTrade), { exit: 'stop', win: false });
  assert.equal(K.replayPath([candle(100, 108, 95)], longTrade).exit, 'stop');
  assert.deepEqual(K.replayPath([candle(100.1)], longTrade), { exit: 'time', win: false }); // +0.1% does not cover 0.2% costs
  assert.equal(K.replayPath([candle(101)], longTrade).win, true);
  assert.equal(K.replayPath([candle(95, 105, 92)], { side: 'short', entry: 100, stopLoss: 104, takeProfit: 93 }).exit, 'stop');
});

test('summarizePaths: shares add up and the call follows break-even', () => {
  const paths = [[candle(108, 108, 100)], [candle(108, 108, 100)], [candle(95, 100, 95)], [candle(100.05)]];
  const s = K.summarizePaths(paths, longTrade, 0.36);
  assert.equal(s.n, 4);
  assert.equal(s.pTarget + s.pStop + s.pTime, 1);
  assert.equal(s.meanP, 0.5);
  assert.equal(s.call, 'take');
  assert.equal(K.summarizePaths(paths, longTrade, 0.6).call, 'skip');
});

test('validatePaths rejects short, non-finite and inverted candles', () => {
  const ok = { paths: [[{ h: 2, l: 1, c: 1.5 }, { h: 2, l: 1, c: 1.5 }]] };
  assert.equal(K.validatePaths(ok, 2)[0].length, 2);
  assert.throws(() => K.validatePaths(ok, 3));
  assert.throws(() => K.validatePaths({ paths: [[{ h: 1, l: 2, c: 1 }]] }, 1));
  assert.throws(() => K.validatePaths({ paths: [[{ h: NaN, l: 1, c: 1 }]] }, 1));
  assert.throws(() => K.validatePaths({}, 1));
});

test('forecast route: saves on the proposal, repeat is free, force asks again', async () => {
  const p = make();
  const a = await api(`/proposals/${p.id}/forecast`, 'POST');
  assert.equal(a.status, 200);
  assert.equal(a.body.kronos.model, 'fake-kronos');
  assert.equal(a.body.kronos.stats.call, 'take'); // every fake path rises 1% an hour and reaches the target
  assert.equal(a.body.kronos.stats.pTarget, 1);
  assert.equal(calls, 1);
  assert.ok(lastBody.bars.length >= 60 && lastBody.horizon === 24);
  assert.equal(store.getProposals().find((x) => x.id === p.id).kronos.samples, 30);
  assert.equal((await api(`/proposals/${p.id}/forecast`, 'POST')).body.cached, true);
  assert.equal(calls, 1);
  await api(`/proposals/${p.id}/forecast?force=1`, 'POST');
  assert.equal(calls, 2);
});

test('forecast route: errors are explicit', async () => {
  const p = make();
  mode = 'down';
  assert.equal((await api(`/proposals/${p.id}/forecast`, 'POST')).body.code, 'forecast_failed');
  mode = 'junk';
  assert.equal((await api(`/proposals/${p.id}/forecast`, 'POST')).body.code, 'invalid_output');
  assert.equal(store.getProposals().find((x) => x.id === p.id).kronos, undefined);
  assert.equal((await api('/proposals/prop_nope/forecast', 'POST')).status, 404);
  process.env.KRONOS_URL = '';
  const r = await api(`/proposals/${p.id}/forecast`, 'POST');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'not_configured');
  assert.equal((await api('/forecast/status')).body.configured, false);
});

test('only a pending proposal can be forecast', async () => {
  const p = make();
  store.setProposals(store.getProposals().map((x) => ({ ...x, status: 'rejected' })));
  assert.equal((await api(`/proposals/${p.id}/forecast`, 'POST')).body.code, 'not_pending');
});

test('KRONOS_URL must be an http(s) URL; junk is ignored', () => {
  process.env.KRONOS_URL = 'file:///etc/passwd';
  assert.equal(config.ai.kronosUrl, '');
  process.env.KRONOS_URL = 'http://host:1/';
  assert.equal(config.ai.kronosUrl, 'http://host:1');
});

test('KRONOS_TOKEN is sent as a bearer token and a refusal is explained', async () => {
  process.env.KRONOS_TOKEN = 'secret-abc';
  const p = make();
  assert.equal((await api(`/proposals/${p.id}/forecast`, 'POST')).status, 200);
  assert.equal(lastAuth, 'Bearer secret-abc');
  mode = 'deny';
  assert.equal((await api(`/proposals/${p.id}/forecast?force=1`, 'POST')).body.code, 'forecast_unauthorized');
  process.env.KRONOS_TOKEN = '';
});

test('forecast saves a band, and compare shows it next to the real closes once the horizon is over', async () => {
  const p = make('AMD');
  await api(`/proposals/${p.id}/forecast`, 'POST');
  const saved = store.getProposals().find((x) => x.id === p.id).kronos;
  assert.equal(saved.band.p50.length, 24);
  assert.ok(saved.band.p10[5] <= saved.band.p50[5] && saved.band.p50[5] <= saved.band.p90[5]);
  assert.ok(Date.parse(saved.startT) > 0 && saved.lastClose > 0);
  // pretend the forecast was made 3 days ago, so its 24 hours are over and the (mock) bars after it can be compared
  const start = new Date(Date.now() - 72 * 3600e3).toISOString();
  store.setProposals(store.getProposals().map((x) => (x.id === p.id ? { ...x, kronos: { ...x.kronos, startT: start } } : x)));
  const cmp = (await api('/forecast/compare')).body;
  assert.equal(cmp.items.length, 1);
  assert.equal(cmp.items[0].complete, true);
  assert.ok(cmp.items[0].actual.length > 0 && cmp.items[0].actual.length <= 24);
  assert.equal(store.getProposals().find((x) => x.id === p.id).kronos.actualDone, true); // saved for good
  assert.ok(cmp.summary.complete === 1 && cmp.summary.inside >= 0 && cmp.summary.inside <= 1);
});

test('scoreForecast: inside share and direction', () => {
  const k = { lastClose: 100, band: { p10: [99, 98], p50: [100.5, 101], p90: [102, 104] }, actual: [{ c: 100.2 }, { c: 105 }] };
  assert.deepEqual(K.scoreForecast(k), { hours: 2, inside: 0.5, direction: true, medianErrorPct: -3.81 });
  assert.equal(K.scoreForecast({ ...k, actual: [] }), null);
});

test('bandOf is ordered p10 <= p50 <= p90 per hour', () => {
  const paths = [1, 2, 3, 4, 5].map((v) => [{ c: v }, { c: v * 2 }]);
  const b = K.bandOf(paths);
  assert.deepEqual(b.p50, [3, 6]);
  assert.ok(b.p10[0] < b.p50[0] && b.p50[1] < b.p90[1]);
});

test('forecastMany works through a list and stops when the service is unset; autoForecast is a validated setting', async () => {
  const { validateSettings } = await import('../server/middleware.js');
  assert.equal(validateSettings({ autoForecast: true }).error, undefined);
  assert.ok(validateSettings({ autoForecast: 'yes' }).error);
  assert.equal(store.getSettings().autoForecast, false);
  const a = make('AAPL');
  const b = make('MSFT');
  const r = await K.forecastMany([a.id, b.id]);
  assert.deepEqual(r, { done: 2, cached: 0, failed: 0 });
  assert.equal((await K.forecastMany([a.id])).cached, 1);
  process.env.KRONOS_URL = '';
  const c = make('TSLA');
  assert.equal((await K.forecastMany([c.id, c.id])).failed, 1); // stops after the first not_configured
});

test('/api/status tells the page whether the forecast service is set up', async () => {
  assert.equal((await api('/status')).body.forecastConfigured, true);
  process.env.KRONOS_URL = '';
  assert.equal((await api('/status')).body.forecastConfigured, false);
});

test('a forecast is refused when the price history is far from the proposal entry', async () => {
  const p = createProposals({ runId: 'run_k_far', items: [{ symbol: 'NVDA', side: 'long', quoted: 5000, entry: 5000, stop: 4800, target: 5300, alloc: 5000, atrPct: 2, confidence: 0.7, reason: 'r', scannerReason: 's', setup: {}, riskCheck: { ok: true, notes: [] } }], source: 'ai', models: { scanner: 'a', trader: 'b' } })[0];
  const r = await api(`/proposals/${p.id}/forecast`, 'POST');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'price_mismatch');
  assert.equal(calls, 0); // the paid/slow service was never called
});
