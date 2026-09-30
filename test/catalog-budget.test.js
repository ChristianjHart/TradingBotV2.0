import './setup.js';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubOpenRouter, realFetch } from './helpers.js';

const { store } = await import('../server/db/store.js');
const { config } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const cat = await import('../server/services/catalog.js');
const spend = await import('../server/services/spend.js');

let server;
let base;
await new Promise((r) => (server = createApp().listen(0, '127.0.0.1', () => r((base = `http://127.0.0.1:${server.address().port}`)))));
after(() => {
  server.close();
  globalThis.fetch = realFetch;
});
const api = async (p) => {
  const r = await realFetch(`${base}/api${p}`);
  return { status: r.status, body: await r.json() };
};

const RAW = {
  data: [
    { id: 'vendor/cheap', name: 'Cheap', created: 1_700_000_000, context_length: 64000, pricing: { prompt: '0.0000001', completion: '0.0000004' }, supported_parameters: ['temperature', 'response_format'] },
    { id: 'vendor/pricey', name: 'Pricey', pricing: { prompt: '0.000015', completion: '0.000075' }, top_provider: { context_length: 200000 }, supported_parameters: ['temperature'] },
    { id: 'vendor/model:free', name: 'Free One', pricing: { prompt: '0', completion: '0' }, context_length: 32000 },
    { id: 'vendor/free-nulls:free', pricing: { prompt: null } },
    { id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '-1', completion: '-1' } },
    { id: 'vendor/weird', pricing: { prompt: 'abc', completion: '' } },
    { id: 'vendor/nopricing' },
    { id: 'vendor/numeric', pricing: { prompt: 0.000002, completion: 0.000006 }, created: 'x' },
    { id: 'vendor/cheap', name: 'Duplicate' },
    { id: 'bad id with spaces', pricing: { prompt: '1' } },
    null,
    'text',
    { name: 'no id' },
  ],
};

beforeEach(() => {
  globalThis.fetch = realFetch;
  config.openrouter.key = '';
  cat._resetCatalog();
  store.setSpend([]);
  store.setSettings({ ...store.getSettings(), monthlyAiBudgetUsd: 20 });
});

test('toPerM parses strings, numbers, zero, null and negative sentinels defensively', () => {
  assert.equal(cat.toPerM('0.000003'), 3);
  assert.equal(cat.toPerM(0.0000001), 0.1);
  assert.equal(cat.toPerM('0'), 0);
  assert.equal(cat.toPerM(0), 0);
  for (const bad of [null, undefined, '', '  ', '-1', -1, 'abc', NaN, {}, true, Infinity]) assert.equal(cat.toPerM(bad), null, String(bad));
});

test('parseCatalog normalises, dedupes, drops junk and sorts cheapest first (unknown prices last)', () => {
  const m = cat.parseCatalog(RAW);
  assert.deepEqual(m.map((x) => x.id), ['vendor/free-nulls:free', 'vendor/model:free', 'vendor/cheap', 'vendor/numeric', 'vendor/pricey', 'openrouter/auto', 'vendor/nopricing', 'vendor/weird']);
  const by = Object.fromEntries(m.map((x) => [x.id, x]));
  assert.deepEqual(by['vendor/cheap'], { id: 'vendor/cheap', name: 'Cheap', promptPerM: 0.1, completionPerM: 0.4, contextLength: 64000, isFree: false, supportsJson: true, created: 1_700_000_000 });
  assert.equal(by['vendor/pricey'].contextLength, 200000);
  assert.equal(by['vendor/pricey'].supportsJson, false);
  assert.equal(by['vendor/model:free'].isFree, true);
  assert.deepEqual([by['vendor/free-nulls:free'].promptPerM, by['vendor/free-nulls:free'].completionPerM, by['vendor/free-nulls:free'].isFree], [0, 0, true]);
  assert.deepEqual([by['openrouter/auto'].promptPerM, by['openrouter/auto'].completionPerM, by['openrouter/auto'].isFree], [null, null, false]);
  assert.equal(by['vendor/weird'].promptPerM, null);
  assert.equal(by['vendor/numeric'].created, undefined);
  assert.equal('supportsJson' in by['vendor/nopricing'], false);
  assert.deepEqual(cat.parseCatalog(RAW.data), m); // bare array accepted
  assert.throws(() => cat.parseCatalog({ nope: 1 }), /shape/);
  assert.throws(() => cat.parseCatalog('x'), /shape/);
});

test('filters: free, q, maxPrice, limit', () => {
  const m = cat.parseCatalog(RAW);
  assert.deepEqual(cat.filterModels(m, { free: true }).map((x) => x.id), ['vendor/free-nulls:free', 'vendor/model:free']);
  assert.deepEqual(cat.filterModels(m, { q: 'PRICEY' }).map((x) => x.id), ['vendor/pricey']);
  assert.deepEqual(cat.filterModels(m, { q: 'auto router' }).map((x) => x.id), ['openrouter/auto']);
  assert.deepEqual(cat.filterModels(m, { maxPrice: '1' }).map((x) => x.id), ['vendor/free-nulls:free', 'vendor/model:free', 'vendor/cheap']);
  assert.deepEqual(cat.filterModels(m, { maxPrice: 'abc' }).length, m.length);
  assert.equal(cat.filterModels(m, { limit: 2 }).length, 2);
});

test('catalog is fetched from the fixed public URL WITHOUT the api key, cached 1h, and served stale on error', async () => {
  let n = 0;
  let mode = 'ok';
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    n++;
    seen.push({ url: String(url), headers: opts?.headers || {} });
    if (mode === 'ok') return Response.json(RAW);
    if (mode === 'http') return new Response('nope', { status: 503 });
    return new Response('<html>', { status: 200 });
  };
  config.openrouter.key = 'sk-or-secret-value-123';
  const t0 = Date.now();
  const a = await cat.getCatalog({ now: t0 });
  assert.equal(a.stale, false);
  assert.equal(n, 1);
  assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/models');
  assert.doesNotMatch(JSON.stringify(seen[0].headers), /Authorization|sk-or-secret/i);
  await cat.getCatalog({ now: t0 + 59 * 60_000 });
  assert.equal(n, 1, 'served from cache inside the 1h TTL');
  mode = 'http';
  const stale = await cat.getCatalog({ now: t0 + 61 * 60_000 });
  assert.equal(n, 2);
  assert.equal(stale.stale, true);
  assert.match(stale.error, /503/);
  assert.equal(stale.models.length, a.models.length);
  mode = 'html';
  const stale2 = await cat.getCatalog({ now: t0 + 62 * 60_000, force: true });
  assert.equal(stale2.stale, true);
  mode = 'ok';
  const fresh = await cat.getCatalog({ force: true });
  assert.equal(fresh.stale, false);
  config.openrouter.key = '';
  // nothing cached + failing endpoint: throws, and is not hammered again right away
  cat._resetCatalog();
  mode = 'http';
  const before = n;
  await assert.rejects(cat.getCatalog(), /503/);
  await assert.rejects(cat.getCatalog(), /503/);
  assert.equal(n, before + 1);
});

test('GET /api/models: sorted list with filters; 502 catalog_unavailable when nothing is cached', async () => {
  stubOpenRouter(undefined, { models: RAW });
  const all = await api('/models');
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 8);
  assert.equal(all.body.models[0].id, 'vendor/free-nulls:free');
  assert.ok(all.body.notes.some((n) => /429/.test(n)));
  assert.equal(all.body.selected.scanner, config.openrouter.scannerModel);
  const free = await api('/models?free=1');
  assert.equal(free.body.count, 2);
  assert.equal((await api('/models?q=cheap&maxPrice=1')).body.count, 1);
  cat._resetCatalog();
  stubOpenRouter(undefined, { models: new Response('x', { status: 500 }) });
  const down = await api('/models');
  assert.equal(down.status, 502);
  assert.equal(down.body.code, 'catalog_unavailable');
});

test('GET /api/models/estimate: default vs measured basis, free models, unknown price, validation', async () => {
  stubOpenRouter(undefined, { models: RAW });
  const d = await api('/models/estimate?bot=scanner&model=vendor/cheap');
  assert.equal(d.status, 200);
  assert.equal(d.body.basis, 'default');
  assert.deepEqual(d.body.tokens, { prompt: 6000, completion: 4000, samples: 0 });
  assert.equal(d.body.estCostPerRunUsd, 0.0022); // 6000*0.1/1e6 + 4000*0.4/1e6
  assert.equal(d.body.estRunsPerMonthAtBudget, Math.floor(20 / 0.0022));
  const t = await api('/models/estimate?bot=trader&model=vendor/cheap');
  assert.deepEqual(t.body.tokens, { prompt: 3000, completion: 1000, samples: 0 });
  // measured averages from the ledger take over
  spend.recordSpend({ bot: 'scanner', model: 'x/y', promptTokens: 10_000, completionTokens: 2000, costUsd: 0.01, costSource: 'reported' });
  spend.recordSpend({ bot: 'scanner', model: 'x/y', promptTokens: 20_000, completionTokens: 4000, costUsd: 0.02, costSource: 'reported' });
  const m = await api('/models/estimate?bot=scanner&model=vendor/pricey');
  assert.equal(m.body.basis, 'measured');
  assert.deepEqual(m.body.tokens, { prompt: 15000, completion: 3000, samples: 2 });
  assert.equal(m.body.estCostPerRunUsd, +(15000 * 15 / 1e6 + 3000 * 75 / 1e6).toFixed(6));
  const f = await api('/models/estimate?bot=news&model=vendor/model:free');
  assert.equal(f.body.estCostPerRunUsd, 0);
  assert.equal(f.body.estRunsPerMonthAtBudget, null);
  assert.equal(f.body.isFree, true);
  assert.ok(f.body.notes.some((n) => /training/.test(n)));
  const u = await api('/models/estimate?bot=scanner&model=nobody/known');
  assert.equal(u.body.priceKnown, false);
  assert.equal(u.body.estCostPerRunUsd, null);
  assert.equal((await api('/models/estimate?bot=bogus')).status, 400);
  assert.equal((await api('/models/estimate?bot=scanner&model=a%20b')).status, 400);
  assert.equal((await api('/models/estimate?bot=scanner')).body.model, config.openrouter.scannerModel); // defaults to the configured model
});

test('budget: month-to-date by bot/model, level warn/blocked, projection, last7d; other months do not count', async () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const at = (iso, o) => spend.recordSpend({ ts: iso, costSource: 'reported', ok: true, ...o });
  at('2026-08-31T23:59:00Z', { bot: 'scanner', model: 'm/a', costUsd: 5, runId: 'r0' }); // last month
  at('2026-09-01T00:00:00Z', { bot: 'scanner', model: 'm/a', costUsd: 4, promptTokens: 100, completionTokens: 50, runId: 'r1' });
  at('2026-09-15T10:00:00Z', { bot: 'trader', model: 'm/b', costUsd: 1, runId: 'r1' });
  at('2026-09-16T09:00:00Z', { bot: 'scanner', model: 'm/a', costUsd: 2, runId: 'r2', costSource: 'estimated' });
  const b = spend.budgetStatus({ now });
  assert.equal(b.capUsd, 20);
  assert.equal(b.spentUsd, 7);
  assert.equal(b.remainingUsd, 13);
  assert.equal(b.pct, 35);
  assert.equal(b.level, 'ok');
  assert.equal(b.resetsAt, '2026-10-01T00:00:00.000Z');
  assert.equal(b.byBot.scanner.usd, 6);
  assert.equal(b.byBot.trader.calls, 1);
  assert.equal(b.byBot.news.usd, 0);
  assert.deepEqual(b.byModel['m/a'], { usd: 6, calls: 2 });
  assert.equal(b.last7d.length, 7);
  assert.deepEqual(b.last7d.at(-1), { day: '2026-09-16', usd: 2 });
  assert.deepEqual(b.last7d.at(-2), { day: '2026-09-15', usd: 1 });
  assert.equal(b.avgCostPerRun, 3.5); // (4+1) for r1, 2 for r2 => 7/2
  assert.equal(b.projectedMonthEndUsd, +(7 / (15.5) * 30).toFixed(6));
  assert.equal(b.estimatedShare, 0.33);
  store.setSettings({ ...store.getSettings(), monthlyAiBudgetUsd: 10 });
  assert.equal(spend.budgetStatus({ now }).level, 'warn'); // 70%
  store.setSettings({ ...store.getSettings(), monthlyAiBudgetUsd: 7 });
  assert.equal(spend.budgetStatus({ now }).level, 'blocked');
  assert.throws(() => spend.checkBudget(0.5, { now }), (e) => e.code === 'budget_exhausted' && e.details.capUsd === 7);
  assert.doesNotThrow(() => spend.checkBudget(0, { now })); // a free call fits even at the cap
});

test('GET /api/budget and the compact budget in /api/status', async () => {
  spend.recordSpend({ bot: 'scanner', model: 'm/a', costUsd: 15, costSource: 'reported' });
  const b = (await api('/budget')).body;
  assert.equal(b.level, 'warn');
  assert.equal(b.spentUsd, 15);
  for (const k of ['capUsd', 'spentUsd', 'remainingUsd', 'pct', 'resetsAt', 'byBot', 'byModel', 'last7d', 'avgCostPerRun', 'projectedMonthEndUsd', 'level']) assert.ok(k in b, k);
  const st = (await api('/status')).body;
  assert.equal(st.budget.level, 'warn');
  assert.equal(st.budget.capUsd, 20);
  assert.equal(st.ai.required, true);
  assert.equal(st.ai.ready, false);
  assert.equal(st.ai.blockedReason, 'no_api_key');
  const dash = (await api('/dashboard')).body;
  assert.equal(dash.ai.required, true);
  assert.ok(dash.budget);
});

test('settings: MONTHLY_AI_BUDGET_USD env default and the editable setting', async () => {
  assert.equal(config.ai.monthlyBudgetUsd, 20);
  process.env.MONTHLY_AI_BUDGET_USD = '7.5';
  assert.equal(config.ai.monthlyBudgetUsd, 7.5);
  process.env.MONTHLY_AI_BUDGET_USD = 'junk';
  assert.equal(config.ai.monthlyBudgetUsd, 20);
  delete process.env.MONTHLY_AI_BUDGET_USD;
  const r = await realFetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ monthlyAiBudgetUsd: 3 }) });
  assert.equal(r.status, 200);
  assert.equal(spend.budgetStatus().capUsd, 3);
  const bad = await realFetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ monthlyAiBudgetUsd: -1 }) });
  assert.equal(bad.status, 400);
  const auto = await realFetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoApprove: 'yes' }) });
  assert.equal(auto.status, 400);
});

test('ledger rebuild after a redeploy: ai_spend rows restore month-to-date once (no duplicates); ai_logs.usage is the fallback', async () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const rows = [
    { id: 's1', ts: '2026-09-02T10:00:00Z', bot: 'scanner', model: 'm/a', prompt_tokens: 100, completion_tokens: 50, cost_usd: 0.4, cost_source: 'reported', run_id: 'r1', ok: true },
    { id: 's2', ts: '2026-09-03T10:00:00Z', bot: 'trader', model: 'm/b', prompt_tokens: 10, completion_tokens: 5, cost_usd: '0.1', cost_source: 'estimated', run_id: 'r1', ok: true },
  ];
  store.setSpend([]); // fresh disk after redeploy
  const select = async (table) => {
    if (table === 'ai_spend') return rows;
    throw new Error('unexpected');
  };
  const r = await spend.rebuildSpendFromRemote(select, { now });
  assert.deepEqual(r, { source: 'ai_spend', added: 2 });
  assert.equal(spend.monthToDateUsd(now), 0.5);
  assert.equal((await spend.rebuildSpendFromRemote(select, { now })).added, 0);
  assert.equal(store.getSpend().length, 2);
  // ai_spend table missing (migration 005 not applied) -> rebuild from ai_logs.usage
  store.setSpend([]);
  const logs = [
    { id: 7, ts: '2026-09-04T10:00:00Z', bot: 'scanner', model: 'm/a', ok: true, usage: { prompt_tokens: 5, completion_tokens: 6, cost_usd: 0.3, cost_source: 'reported', run_id: 'r9' } },
    { id: 8, ts: '2026-09-05T10:00:00Z', bot: 'trader', model: 'm/a', ok: false, usage: null },
    { id: 9, ts: '2026-09-05T11:00:00Z', bot: 'trader', model: 'm/a', ok: true, usage: { tokens: 1 } },
  ];
  const select2 = async (table) => {
    if (table === 'ai_spend') throw new Error('Supabase select ai_spend 404: {"code":"PGRST205","message":"Could not find the table \'public.ai_spend\'"}');
    return logs;
  };
  const r2 = await spend.rebuildSpendFromRemote(select2, { now });
  assert.deepEqual(r2, { source: 'ai_logs', added: 1 });
  assert.equal(spend.monthToDateUsd(now), 0.3);
  // both tables missing: tolerated, nothing added
  const select3 = async () => {
    throw new Error('PGRST205 Could not find the table');
  };
  assert.deepEqual(await spend.rebuildSpendFromRemote(select3, { now }), { source: 'none', added: 0 });
  // any other failure is surfaced to the caller (hydrate logs it)
  await assert.rejects(spend.rebuildSpendFromRemote(async () => { throw new Error('boom 500'); }, { now }), /boom/);
});
