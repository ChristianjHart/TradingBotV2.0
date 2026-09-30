import './setup.js';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetFake, stubOpenRouter, chatReply, realFetch, TEST_KEY } from './helpers.js';

const { store } = await import('../server/db/store.js');
const { config } = await import('../server/config.js');
const or = await import('../server/services/openrouter.js');
const cat = await import('../server/services/catalog.js');
const spend = await import('../server/services/spend.js');
const { runScannerBot, sanitizePicks } = await import('../server/services/aiScanner.js');
const { sanitizeTrades } = await import('../server/services/traderBot.js');
const { startAiRun, runState } = await import('../server/services/aiRun.js');

const { chatJson, aiTuning } = or;
const sleeps = [];
aiTuning.sleep = async (ms) => {
  sleeps.push(ms);
};
after(() => {
  globalThis.fetch = realFetch;
  config.openrouter.key = '';
});

const MODELS = {
  data: [
    { id: 'vendor/json-ok', pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['response_format'] },
    { id: 'vendor/no-json', pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['temperature'] },
    { id: 'vendor/unknown-support', pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'vendor/model:free', pricing: { prompt: '0', completion: '0' } },
  ],
};
const GOOD = { picks: [{ symbol: 'AAPL', direction: 'long', confidence: 0.7, reason: 'x' }] };
const ask = (over = {}) => chatJson({ bot: 'scanner', model: 'vendor/json-ok', system: 'sys', user: '{"rows":[]}', maxTokens: 500, runId: 'run_t', ...over });
const status = (code, body = {}, headers = {}) => Response.json(body, { status: code, headers });

beforeEach(() => {
  resetFake();
  cat._resetCatalog();
  or._resetJsonMode();
  store.setSpend([]);
  store.setPositions([]);
  store.setProposals([]);
  store.setSettings({ ...store.getSettings(), monthlyAiBudgetUsd: 20 });
  store.setAiPicks({ picks: [{ symbol: 'PREV', direction: 'long', confidence: 0.9, reason: 'keep me' }], updatedAt: 'before', source: 'ai', model: 'm' });
  store.setRuns([]);
  store.setRunSummary(null);
  sleeps.length = 0;
  Object.assign(aiTuning, { rateLimitMaxWaitMs: 15_000, defaultRetryWaitMs: 3000 });
  globalThis.fetch = realFetch;
  config.openrouter.key = '';
  delete process.env.MOCK_LLM;
});

async function waitRun() {
  for (let i = 0; i < 400 && runState.running; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(runState.running, false);
}

test('no API key: chatJson throws no_api_key and never touches the network', async () => {
  let hit = 0;
  globalThis.fetch = async () => {
    hit++;
    return Response.json({});
  };
  await assert.rejects(ask(), (e) => e.code === 'no_api_key' && /nothing is traded/.test(e.message));
  assert.equal(hit, 0);
});

test('no key: the run ends BLOCKED (no_api_key) and changes nothing: picks, proposals, positions, ledger', async () => {
  let hit = 0;
  globalThis.fetch = async (u, o) => {
    if (!String(u).startsWith('http://127')) hit++;
    return realFetch(u, o);
  };
  assert.equal(startAiRun(), true);
  await waitRun();
  assert.equal(runState.stage, 'blocked');
  assert.equal(runState.code, 'no_api_key');
  assert.match(runState.error, /OpenRouter key/);
  assert.equal(hit, 0);
  assert.equal(store.getAiPicks().picks[0].symbol, 'PREV');
  assert.equal(store.getProposals().length, 0);
  assert.equal(store.getPositions().length, 0);
  assert.equal(store.getSpend().length, 0);
  assert.equal(store.getRunSummary(), null); // a failed run never replaces the last good summary
  const rec = store.getRuns()[0];
  assert.equal(rec.status, 'blocked');
  assert.equal(rec.code, 'no_api_key');
  assert.ok(rec.error);
  assert.equal(rec.proposalCount, 0);
});

test('budget cap blocks BEFORE any request; the run ends blocked budget_exhausted; free models still pass', async () => {
  const llm = stubOpenRouter(() => GOOD, { models: MODELS });
  store.setSettings({ ...store.getSettings(), monthlyAiBudgetUsd: 0.05 });
  spend.recordSpend({ bot: 'scanner', model: 'vendor/json-ok', costUsd: 0.05, costSource: 'reported', promptTokens: 1, completionTokens: 1 });
  await assert.rejects(ask(), (e) => e.code === 'budget_exhausted' && e.details.capUsd === 0.05 && /budget/.test(e.message));
  assert.equal(llm.calls.length, 0);
  // the free model's estimate is $0, so it still fits
  const ok = await ask({ model: 'vendor/model:free' });
  assert.deepEqual(ok.json, GOOD);
  // whole run: blocked with code, nothing changed
  config.openrouter.scannerModel = 'vendor/json-ok';
  assert.equal(startAiRun(), true);
  await waitRun();
  assert.equal(runState.stage, 'blocked');
  assert.equal(runState.code, 'budget_exhausted');
  assert.equal(store.getAiPicks().picks[0].symbol, 'PREV');
  assert.equal(store.getRuns()[0].code, 'budget_exhausted');
  config.openrouter.scannerModel = 'deepseek/deepseek-v3.1-terminus';
});

test('the estimate that gates a call uses the real prompt size: a call that would cross the cap is refused', async () => {
  const llm = stubOpenRouter(() => GOOD, { models: MODELS });
  await ask(); // load catalog
  llm.calls.length = 0;
  store.setSpend([]);
  // 200k chars ~ 57k tokens at $1/M = ~$0.057 + output
  store.setSettings({ ...store.getSettings(), monthlyAiBudgetUsd: 0.05 });
  await assert.rejects(ask({ user: 'x'.repeat(200_000) }), (e) => e.code === 'budget_exhausted');
  assert.equal(llm.calls.length, 0);
});

test('cost accounting: reported usage.cost wins; otherwise tokens x catalog price is ESTIMATED; both land in the ledger', async () => {
  const llm = stubOpenRouter((_b, n) => (n === 1 ? chatReply(GOOD, { prompt: 2000, completion: 500, cost: 0.01234 }) : chatReply(GOOD, { prompt: 2000, completion: 500 })), { models: MODELS });
  const a = await ask();
  assert.equal(a.usage.costUsd, 0.01234);
  assert.equal(a.usage.costSource, 'reported');
  const b = await ask();
  assert.equal(b.usage.costSource, 'estimated');
  assert.equal(b.usage.costUsd, 0.003); // 2000*$1/M + 500*$2/M
  const [e1, e2] = store.getSpend();
  assert.deepEqual([e1.bot, e1.model, e1.promptTokens, e1.completionTokens, e1.costUsd, e1.costSource, e1.ok, e1.runId], ['scanner', 'vendor/json-ok', 2000, 500, 0.01234, 'reported', true, 'run_t']);
  assert.deepEqual([e2.costUsd, e2.costSource], [0.003, 'estimated']);
  assert.equal(spend.monthToDateUsd(), 0.01534);
  // every request asks for cost reporting
  assert.ok(llm.calls.every((c) => c.usage?.include === true));
});

test('usage shape variations: strings, input/output token names, total only, missing usage entirely', async () => {
  stubOpenRouter((_b, n) => {
    if (n === 1) return Response.json({ choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: '300', completion_tokens: '100', cost: '0.002' } });
    if (n === 2) return Response.json({ choices: [{ message: { content: '{"a":1}' } }], usage: { input_tokens: 40, output_tokens: 10 } });
    if (n === 3) return Response.json({ choices: [{ message: { content: '{"a":1}' } }], usage: { total_tokens: 90, completion_tokens: 30 } });
    return Response.json({ choices: [{ message: { content: '{"a":1}' } }] });
  }, { models: MODELS });
  const u1 = (await ask()).usage;
  assert.deepEqual([u1.promptTokens, u1.completionTokens, u1.costUsd, u1.costSource], [300, 100, 0.002, 'reported']);
  const u2 = (await ask()).usage;
  assert.deepEqual([u2.promptTokens, u2.completionTokens, u2.costSource], [40, 10, 'estimated']);
  const u3 = (await ask()).usage;
  assert.deepEqual([u3.promptTokens, u3.completionTokens], [60, 30]);
  const u4 = (await ask()).usage; // no usage at all: tokens estimated from text length, never crashes
  assert.equal(u4.costSource, 'estimated');
  assert.ok(u4.promptTokens > 0);
  assert.equal(store.getSpend().length, 4);
});

test('response_format json is sent only when the model supports it; a rejection downgrades to prompt-only JSON and is remembered', async () => {
  let llm = stubOpenRouter(() => GOOD, { models: MODELS });
  await ask({ model: 'vendor/json-ok' });
  await ask({ model: 'vendor/no-json' });
  await ask({ model: 'vendor/unknown-support' });
  assert.deepEqual(llm.calls.map((c) => c.response_format?.type), ['json_object', undefined, 'json_object']);
  cat._resetCatalog();
  or._resetJsonMode();
  llm = stubOpenRouter((body, n) => (n === 1 ? status(400, { error: { message: 'Provider does not support response_format json_object' } }) : GOOD), { models: MODELS });
  const r = await ask({ model: 'vendor/unknown-support' });
  assert.deepEqual(r.json, GOOD);
  assert.equal(r.repaired, false); // the downgrade is not a repair retry
  assert.deepEqual(llm.calls.map((c) => c.response_format?.type), ['json_object', undefined]);
  await ask({ model: 'vendor/unknown-support' });
  assert.equal(llm.calls[2].response_format, undefined, 'remembered for this model');
});

test('ONE repair retry on invalid JSON is counted in cost and ledger; a second failure is invalid_output', async () => {
  let llm = stubOpenRouter((_b, n) => (n === 1 ? chatReply('Sure! here you go: {not json', { cost: 0.01 }) : chatReply(GOOD, { cost: 0.02 })), { models: MODELS });
  const r = await ask();
  assert.equal(r.repaired, true);
  assert.deepEqual(r.json, GOOD);
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.calls[1].messages.length, 4);
  assert.match(llm.calls[1].messages[3].content, /valid JSON/);
  assert.equal(r.usage.calls, 2);
  assert.equal(r.usage.costUsd, 0.03);
  assert.equal(store.getSpend().length, 2);
  assert.equal(spend.monthToDateUsd(), 0.03);
  // shape failure via validate() also uses the single retry
  store.setSpend([]);
  llm = stubOpenRouter((_b, n) => (n === 1 ? { picks: 'no' } : GOOD), { models: MODELS });
  const v = await ask({ validate: (j) => sanitizePicks(j, new Map([['AAPL', {}]])) });
  assert.equal(v.repaired, true);
  assert.equal(v.value.length, 1);
  // twice bad: invalid_output, exactly two requests, both costs recorded
  store.setSpend([]);
  llm = stubOpenRouter(() => chatReply('still not json', { cost: 0.005 }), { models: MODELS });
  await assert.rejects(ask(), (e) => e.code === 'invalid_output' && e.details.calls === 2);
  assert.equal(llm.calls.length, 2);
  assert.equal(spend.monthToDateUsd(), 0.01);
});

test('429: one bounded wait honouring Retry-After, then success; a second 429 fails as rate_limited; long Retry-After fails at once', async () => {
  let llm = stubOpenRouter((_b, n) => (n === 1 ? status(429, { error: { message: 'slow down' } }, { 'retry-after': '2' }) : GOOD), { models: MODELS });
  assert.deepEqual((await ask()).json, GOOD);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(llm.calls.length, 2);
  assert.equal(store.getSpend().length, 1); // the 429 cost nothing and is not a ledger row

  sleeps.length = 0;
  llm = stubOpenRouter(() => status(429, { error: { message: 'free-models-per-min' } }, { 'retry-after': '1' }), { models: MODELS });
  await assert.rejects(ask({ model: 'vendor/model:free' }), (e) => e.code === 'rate_limited' && /free models/i.test(e.message) && e.retryAfterSec === 1);
  assert.equal(llm.calls.length, 2, 'exactly one retry');
  assert.deepEqual(sleeps, [1000]);

  sleeps.length = 0;
  llm = stubOpenRouter(() => status(429, {}, { 'retry-after': '120' }), { models: MODELS });
  await assert.rejects(ask(), (e) => e.code === 'rate_limited' && e.retryAfterSec === 120);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(sleeps, []);

  sleeps.length = 0;
  llm = stubOpenRouter((_b, n) => (n === 1 ? status(429, {}) : GOOD), { models: MODELS }); // no header: short default wait
  await ask();
  assert.deepEqual(sleeps, [3000]);
  // an HTTP-date Retry-After and a 200 that carries a 429 error body
  sleeps.length = 0;
  llm = stubOpenRouter((_b, n) => (n === 1 ? Response.json({ error: { code: 429, message: 'rate limited upstream' } }, { headers: { 'retry-after': new Date(Date.now() + 5000).toUTCString() } }) : GOOD), { models: MODELS });
  await ask();
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 3000 && sleeps[0] <= 5000);
});

test('failures map to typed errors', async () => {
  const cases = [
    [() => status(401, { error: { message: 'No auth credentials found' } }), 'no_api_key'],
    [() => status(402, { error: { message: 'Insufficient credits' } }), 'budget_exhausted'],
    [() => status(404, { error: { message: 'No endpoints found for x/y' } }), 'model_unavailable'],
    [() => status(400, { error: { message: 'x/y is not a valid model ID' } }), 'model_unavailable'],
    [() => status(503, { error: { message: 'No available provider' } }), 'model_unavailable'],
    [() => status(408, {}), 'timeout'],
    [() => status(500, { error: { message: 'boom' } }), 'upstream_error'],
    [() => status(502, 'bad gateway'), 'upstream_error'],
    [() => new Response('<html>oops</html>', { status: 200 }), 'upstream_error'],
    [() => Response.json({ error: { code: 404, message: 'model gone' } }), 'model_unavailable'],
    [() => Response.json({ choices: [{ error: { code: 500, message: 'provider crashed' } }] }), 'upstream_error'],
  ];
  for (const [mk, code] of cases) {
    const llm = stubOpenRouter(mk, { models: MODELS });
    await assert.rejects(ask(), (e) => e.code === code, code);
    assert.equal(llm.calls.length, 1, code);
  }
  globalThis.fetch = async (u) => {
    if (String(u).includes('/models')) return Response.json(MODELS);
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  await assert.rejects(ask(), (e) => e.code === 'timeout');
  globalThis.fetch = async (u) => {
    if (String(u).includes('/models')) return Response.json(MODELS);
    throw new TypeError('fetch failed');
  };
  await assert.rejects(ask(), (e) => e.code === 'upstream_error');
  assert.equal(spend.monthToDateUsd(), 0); // nothing billed for failures
});

test('error text never leaks the API key', async () => {
  stubOpenRouter(() => status(500, { error: { message: `bad key ${TEST_KEY} rejected` } }), { models: MODELS });
  await assert.rejects(ask(), (e) => !e.message.includes(TEST_KEY));
});

test('reply shape variations: content parts, legacy text, fenced JSON, chatter around JSON', async () => {
  const replies = [
    { choices: [{ message: { content: [{ type: 'text', text: '{"picks":' }, { type: 'text', text: '[]}' }] } }] },
    { choices: [{ text: '{"picks":[]}' }] },
    { choices: [{ message: { content: '```json\n{"picks":[]}\n```' } }] },
    { choices: [{ message: { content: 'Here you go:\n{"picks":[]}\nHope that helps!' } }] },
  ];
  for (const r of replies) {
    stubOpenRouter(() => Response.json(r), { models: MODELS });
    assert.deepEqual((await ask()).json, { picks: [] });
  }
  // empty / null content is unusable output: one repair, then invalid_output
  const llm = stubOpenRouter(() => Response.json({ choices: [{ message: { content: null } }] }), { models: MODELS });
  await assert.rejects(ask(), (e) => e.code === 'invalid_output');
  assert.equal(llm.calls.length, 2);
  stubOpenRouter(() => Response.json({ choices: [] }), { models: MODELS });
  await assert.rejects(ask(), (e) => e.code === 'invalid_output');
});

test('hostile JSON never pollutes prototypes or smuggles symbols: sanitizers keep only allow-listed fields', () => {
  const evil = JSON.parse('{"picks":[{"symbol":"AAPL","direction":"long","confidence":0.9,"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":1}}},{"symbol":"AAPL; rm -rf /","direction":"long"},{"symbol":"../../etc","direction":"short"}],"__proto__":{"polluted3":1}}');
  const out = sanitizePicks(evil, new Map([['AAPL', {}]]));
  assert.deepEqual(out, [{ symbol: 'AAPL', direction: 'long', confidence: 0.9, reason: '' }]);
  assert.equal({}.polluted, undefined);
  assert.equal({}.polluted2, undefined);
  assert.equal({}.polluted3, undefined);
  const t = sanitizeTrades(JSON.parse('{"trades":[{"symbol":"AAPL","side":"long","allocationUsd":"1e9","__proto__":{"x":1}},{"symbol":"$(reboot)","side":"long"},{"symbol":"A B","side":"long"},{"symbol":"https://evil.example/x","side":"long"}]}'));
  assert.deepEqual(t.trades.map((x) => x.symbol), ['AAPL']);
  assert.equal(t.dropped, 3);
  assert.equal({}.x, undefined);
});

test('scanner success path stores picks as source "ai" with the model and usage; failures leave picks alone', async () => {
  config.openrouter.scannerModel = 'vendor/json-ok';
  stubOpenRouter((b) => ({ picks: JSON.parse(b.messages[1].content).rows.map((r) => ({ symbol: r.symbol, direction: 'long', confidence: 0.6, reason: 'r' })) }), { models: MODELS });
  const data = ['AAPL', 'MSFT'].map((symbol) => ({ symbol, price: 100, atrPct: 2, row: { symbol } }));
  const r = await runScannerBot(data, { runId: 'run_s' });
  assert.equal(r.source, 'ai');
  assert.equal(r.model, 'vendor/json-ok');
  assert.equal(store.getAiPicks().picks.length, 2);
  assert.equal(store.getAiPicks().source, 'ai');
  assert.equal(store.getSpend()[0].runId, 'run_s');
  stubOpenRouter(() => status(500, {}), { models: MODELS });
  await assert.rejects(runScannerBot(data, {}), (e) => e.code === 'upstream_error');
  assert.equal(store.getAiPicks().picks.length, 2);
  config.openrouter.scannerModel = 'deepseek/deepseek-v3.1-terminus';
});

test('a whole run that hits rate limits ends in state "error" with code rate_limited (surfaced in runState and run history)', async () => {
  const llm = stubOpenRouter(() => status(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } }, { 'retry-after': '1' }), { models: MODELS });
  config.openrouter.scannerModel = 'vendor/model:free';
  startAiRun();
  await waitRun();
  assert.equal(runState.stage, 'error');
  assert.equal(runState.code, 'rate_limited');
  assert.match(runState.error, /rate limit/i);
  assert.equal(llm.calls.length, 2);
  assert.equal(store.getAiPicks().picks[0].symbol, 'PREV');
  assert.equal(store.getProposals().length, 0);
  assert.equal(store.getPositions().length, 0);
  const rec = store.getRuns()[0];
  assert.equal(rec.status, 'error');
  assert.equal(rec.code, 'rate_limited');
  config.openrouter.scannerModel = 'deepseek/deepseek-v3.1-terminus';
});

test('a full successful run records cost on the run, proposals (not positions) and ledger rows tagged with the runId', async () => {
  stubOpenRouter(undefined, { models: MODELS });
  startAiRun();
  await waitRun();
  assert.equal(runState.stage, 'done', runState.error);
  assert.equal(runState.code, null);
  const sm = store.getRunSummary();
  assert.equal(sm.status, 'done');
  assert.equal(sm.scannerSource, 'ai');
  assert.equal(sm.aiCalls, 2);
  assert.ok(sm.costUsd >= 0);
  assert.equal(sm.proposalCount, runState.proposals);
  assert.equal(store.getPositions().length, 0);
  assert.ok(store.getSpend().length === 2 && store.getSpend().every((e) => e.runId === runState.runId));
  assert.deepEqual(store.getSpend().map((e) => e.bot).sort(), ['scanner', 'trader']);
});
