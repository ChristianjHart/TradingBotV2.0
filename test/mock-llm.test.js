import './setup.js';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetFake, realFetch } from './helpers.js';

const { store } = await import('../server/db/store.js');
const { config } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const { mockLlmEnabled, _resetMockWarning, MOCK_MODEL } = await import('../server/services/mockLlm.js');
const { chatJson } = await import('../server/services/openrouter.js');
const { startAiRun, runState, aiStatus } = await import('../server/services/aiRun.js');
const spend = await import('../server/services/spend.js');

let server;
let base;
await new Promise((r) => (server = createApp().listen(0, '127.0.0.1', () => r((base = `http://127.0.0.1:${server.address().port}`)))));
const api = async (p) => (await realFetch(`${base}/api${p}`)).json();
const saved = { NODE_ENV: process.env.NODE_ENV, RENDER: process.env.RENDER };
const restoreEnv = () => {
  for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  delete process.env.MOCK_LLM;
};
after(() => {
  server.close();
  restoreEnv();
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  resetFake();
  restoreEnv();
  _resetMockWarning();
  config.openrouter.key = '';
  store.setSpend([]);
  store.setPositions([]);
  store.setProposals([]);
  store.setRuns([]);
  store.setRunSummary(null);
  store.setAiPicks({ picks: [], updatedAt: null });
  store.setWorker({ ...store.getWorker(), status: 'online' });
});

async function waitRun() {
  for (let i = 0; i < 400 && runState.running; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(runState.running, false);
}

test('MOCK_LLM is OFF unless requested: no key still means no_api_key', async () => {
  assert.equal(mockLlmEnabled(), false);
  await assert.rejects(chatJson({ bot: 'scanner', model: 'x/y', system: 's', user: '{}' }), (e) => e.code === 'no_api_key');
});

test('MOCK_LLM=true (dev): deterministic canned scanner + trader JSON, no network, free, labelled mock-llm', async () => {
  process.env.MOCK_LLM = 'true';
  assert.equal(mockLlmEnabled(), true);
  globalThis.fetch = async () => assert.fail('the mock LLM must never use the network');
  const rows = Array.from({ length: 30 }, (_, i) => ({ symbol: i === 3 ? 'BTC/USD' : `S${i}`, price: 100 }));
  const a = await chatJson({ bot: 'scanner', model: 'ignored/model', system: 's', user: JSON.stringify({ rows }), runId: 'run_m' });
  const b = await chatJson({ bot: 'scanner', model: 'ignored/model', system: 's', user: JSON.stringify({ rows }), runId: 'run_m' });
  assert.deepEqual(a.json, b.json); // deterministic
  assert.equal(a.model, MOCK_MODEL);
  assert.equal(a.mock, true);
  assert.equal(a.json.picks.length, 20);
  assert.deepEqual(a.json.picks.slice(0, 4).map((p) => p.direction), ['long', 'short', 'long', 'long']); // alternating; the crypto row is long-only
  assert.deepEqual(a.json.picks.map((p) => p.symbol), rows.slice(0, 20).map((r) => r.symbol));
  const t = await chatJson({ bot: 'trader', model: 'm', system: 's', user: JSON.stringify({ account: { equity: 100000, cash: 100000 }, freeSlots: 5, candidates: [1, 2, 3, 4].map((i) => ({ symbol: `C${i}`, direction: 'long', confidence: 0.9 - i / 10, price: 50, atrPct: 2 })) }) });
  assert.deepEqual(t.json.trades.map((x) => x.symbol), ['C1', 'C2', 'C3']); // top 3 candidates
  assert.ok(t.json.trades.every((x) => x.stopLoss < 50 && x.takeProfit > 50 && x.allocationUsd > 0));
  const ledger = store.getSpend();
  assert.ok(ledger.length === 3 && ledger.every((e) => e.model === MOCK_MODEL && e.costUsd === 0 && e.mock));
  assert.equal(spend.monthToDateUsd(), 0);
});

test('a MOCK_LLM run: proposals and picks are labelled source "demo" / model "mock-llm"; status shows demo; nothing is spent or opened', async () => {
  process.env.MOCK_LLM = 'true';
  assert.deepEqual(aiStatus(), { required: true, ready: true, demo: true });
  startAiRun();
  await waitRun();
  assert.equal(runState.stage, 'done', runState.error);
  assert.equal(runState.demo, true);
  const picks = store.getAiPicks();
  assert.equal(picks.source, 'demo');
  assert.equal(picks.model, MOCK_MODEL);
  assert.equal(picks.picks.length, 20);
  const props = store.getProposals();
  assert.equal(props.length, 3);
  assert.ok(props.every((p) => p.source === 'demo' && p.models.trader === MOCK_MODEL && p.models.scanner === MOCK_MODEL && p.status === 'pending'));
  assert.equal(store.getPositions().length, 0);
  const sm = store.getRunSummary();
  assert.equal(sm.demo, true);
  assert.equal(sm.scannerSource, 'demo');
  assert.equal(sm.traderSource, 'demo');
  assert.equal(sm.proposalCount, 3);
  assert.equal(spend.budgetStatus().spentUsd, 0);
  assert.equal((await api('/status')).ai.demo, true);
  assert.equal((await api('/health')).mockLlm, true);
  // approving a demo proposal yields a position that stays labelled demo
  const r = await realFetch(`${base}/api/proposals/${props[0].id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 200);
  assert.equal(store.getPositions()[0].source, 'demo');
});

test('MOCK_LLM is REFUSED in production and on Render: ignored, loudly logged, never used', async () => {
  for (const env of [{ NODE_ENV: 'production' }, { RENDER: 'true' }]) {
    restoreEnv();
    _resetMockWarning();
    process.env.MOCK_LLM = 'true';
    Object.assign(process.env, env);
    const warn = console.warn;
    const warned = [];
    console.warn = (m) => warned.push(String(m));
    try {
      assert.equal(mockLlmEnabled(), false, JSON.stringify(env));
      assert.equal(mockLlmEnabled(), false);
    } finally {
      console.warn = warn;
    }
    assert.equal(warned.length, 1, 'one loud warning, not one per call');
    assert.match(warned[0], /MOCK_LLM=true is REFUSED/);
    assert.ok(store.getLogs().some((l) => l.level === 'error' && /MOCK_LLM=true is REFUSED/.test(l.message)));
    await assert.rejects(chatJson({ bot: 'scanner', model: 'x/y', system: 's', user: '{}' }), (e) => e.code === 'no_api_key');
    assert.deepEqual(aiStatus(), { required: true, ready: false, blockedReason: 'no_api_key', demo: false });
    startAiRun();
    await waitRun();
    assert.equal(runState.stage, 'blocked');
    assert.equal(runState.code, 'no_api_key');
    assert.equal(store.getProposals().length, 0);
    assert.equal(store.getAiPicks().picks.length, 0);
  }
});
