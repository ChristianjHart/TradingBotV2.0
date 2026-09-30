// Supabase env must be set BEFORE the modules load (they read env at import time).
import './setup.js';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-role-key';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
const posts = []; // { table, rows, upsert }
const tableRows = {};
const missing = new Set();
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://supabase.test/rest/v1/')) {
    const table = u.split('/rest/v1/')[1].split('?')[0];
    if (opts.method === 'POST') {
      posts.push({ table, rows: JSON.parse(opts.body), upsert: u.includes('on_conflict') });
      return new Response('', { status: 201 });
    }
    if (missing.has(table)) return new Response(JSON.stringify({ code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` }), { status: 404 });
    return Response.json(tableRows[table] || []);
  }
  if (u.endsWith('/chat/completions')) {
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.0042 } });
  }
  if (u.startsWith('https://openrouter.ai/api/v1/models')) return Response.json({ data: [] });
  return realFetch(url, opts);
};

const { store } = await import('../server/db/store.js');
const { config } = await import('../server/config.js');
const sb = await import('../server/db/supabase.js');
const spend = await import('../server/services/spend.js');
const P = await import('../server/services/proposals.js');
const { chatJson } = await import('../server/services/openrouter.js');
const { hydrateProposalsAndSpend } = await import('../server/db/hydrate.js');
after(() => {
  globalThis.fetch = realFetch;
  config.openrouter.key = '';
});

test('spend ledger rows, proposals and ai_logs.usage (with cost) are mirrored to Supabase with the migration-005 shapes', async () => {
  config.openrouter.key = 'sk-or-test-000111222';
  store.setSpend([]);
  store.setProposals([]);
  await chatJson({ bot: 'trader', model: 'vendor/m', system: 's', user: '{}', runId: 'run_sb' });
  P.createProposals({ runId: 'run_sb', source: 'ai', models: { scanner: 'a', trader: 'b' }, items: [{ symbol: 'AAPL', side: 'long', quoted: 100, entry: 100.05, stop: 96, target: 107, alloc: 1000, atrPct: 2, confidence: 0.7, reason: 'r', riskCheck: { ok: true } }] });
  await sb.flush();
  const spendPost = posts.find((p) => p.table === 'ai_spend');
  assert.equal(spendPost.upsert, true);
  assert.deepEqual(Object.keys(spendPost.rows[0]).sort(), ['bot', 'completion_tokens', 'cost_source', 'cost_usd', 'id', 'model', 'ok', 'prompt_tokens', 'run_id', 'ts']);
  assert.deepEqual([spendPost.rows[0].cost_usd, spendPost.rows[0].cost_source, spendPost.rows[0].prompt_tokens, spendPost.rows[0].run_id], [0.0042, 'reported', 11, 'run_sb']);
  const propPost = posts.find((p) => p.table === 'proposals');
  assert.deepEqual(Object.keys(propPost.rows[0]).sort(), ['created_at', 'decided_at', 'expires_at', 'id', 'raw', 'run_id', 'side', 'status', 'symbol', 'updated_at']);
  assert.equal(propPost.rows[0].raw.status, 'pending');
  const logPost = posts.find((p) => p.table === 'ai_logs');
  assert.equal(logPost.rows[0].usage.cost_usd, 0.0042);
  assert.equal(logPost.rows[0].usage.cost_source, 'reported');
  assert.equal(logPost.rows[0].usage.prompt_tokens, 11);
  assert.equal(logPost.rows[0].usage.run_id, 'run_sb');
  assert.ok(!('cost_usd' in logPost.rows[0]), 'no new ai_logs columns: cost lives inside usage jsonb');
  assert.ok(!JSON.stringify(posts).includes('sk-or-test-000111222'));
});

test('boot hydrate after a redeploy: proposals + month-to-date spend restored from Supabase; budget cannot reset to zero', async () => {
  store.setSpend([]);
  store.setProposals([]);
  const ts = new Date().toISOString();
  tableRows.ai_spend = [{ id: 'sp1', ts, bot: 'scanner', model: 'm/a', prompt_tokens: 1, completion_tokens: 1, cost_usd: 4.25, cost_source: 'reported', run_id: 'r', ok: true }];
  tableRows.proposals = [{ raw: { id: 'prop_x', status: 'pending', symbol: 'AAPL', createdAt: ts, expiresAt: ts } }];
  await hydrateProposalsAndSpend();
  assert.equal(store.getProposals()[0].id, 'prop_x');
  assert.equal(spend.monthToDateUsd(), 4.25);
  await hydrateProposalsAndSpend(); // idempotent
  assert.equal(store.getSpend().length, 1);
});

test('migration 005 not applied (PGRST205): hydrate warns and continues, spend is rebuilt from ai_logs.usage', async () => {
  store.setSpend([]);
  store.setProposals([]);
  missing.add('proposals');
  missing.add('ai_spend');
  tableRows.ai_logs = [{ id: 5, ts: new Date().toISOString(), bot: 'scanner', model: 'm/a', ok: true, usage: { prompt_tokens: 9, completion_tokens: 9, cost_usd: 1.5, cost_source: 'reported', run_id: 'r' } }];
  const warn = console.warn;
  const warns = [];
  console.warn = (m) => warns.push(String(m));
  try {
    await hydrateProposalsAndSpend(); // must not throw
  } finally {
    console.warn = warn;
  }
  assert.equal(spend.monthToDateUsd(), 1.5);
  assert.ok(warns.some((w) => /public\.proposals does not exist/.test(w)));
  assert.ok(warns.some((w) => /ai_spend is missing/.test(w)));
  missing.clear();
});
