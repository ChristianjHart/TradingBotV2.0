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
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    calls += 1;
    lastBody = JSON.parse(b);
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
