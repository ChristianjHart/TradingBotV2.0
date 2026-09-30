import './setup.js';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const { store } = await import('../server/db/store.js');
const { config } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const { runState } = await import('../server/services/aiRun.js');
const { recordSpend } = await import('../server/services/spend.js');
const S = await import('../server/services/scheduler.js');
const { validateSettings } = await import('../server/middleware.js');

const ET = (day, hhmm) => S.etWallToMs(day, hhmm);
const iso = (ms) => new Date(ms).toISOString();

const setSchedule = (patch) => store.setSettings({ ...store.getSettings(), schedule: S.mergeSchedule(store.getSettings().schedule, patch) });
const okAi = { ready: true, demo: false };
const budgetOk = (over = {}) => () => ({ level: 'ok', remainingUsd: 10, ...over });
/** Deps with a fake clock; started runs are recorded. */
function deps(now, over = {}) {
  const calls = [];
  return {
    calls,
    deps: { now: () => now, startRun: (o) => (calls.push(o), true), isRunning: () => false, ai: () => okAi, budget: budgetOk(), estimate: () => ({ usd: 0.1, gatingUsd: 0.1, basis: 'measured' }), workerAlive: () => true, log: () => {}, getMoves: async () => [], ...over },
  };
}

beforeEach(() => {
  store.setScheduleState({});
  store.setRuns([]);
  store.setSpend([]);
  store.setProposals([]);
  store.setAiPicks({ picks: [], updatedAt: null });
  store.setWorker({ ...store.getWorker(), status: 'online' });
  runState.running = false;
  store.setSettings({ ...store.getSettings(), monthlyAiBudgetUsd: 20, schedule: { enabled: false, plan: 'B', custom: [], cryptoRuns: [], eventTriggers: { ...S.DEFAULT_EVENT_TRIGGERS } } });
});

// ---- slot computation ----
test('ET wall time converts to UTC across DST (EDT vs EST)', () => {
  assert.equal(iso(ET('2026-07-01', '09:00')), '2026-07-01T13:00:00.000Z'); // EDT, UTC-4
  assert.equal(iso(ET('2026-01-05', '09:00')), '2026-01-05T14:00:00.000Z'); // EST, UTC-5
  // DST start Sun 2026-03-08 and end Sun 2026-11-01: the Mon after is on the new offset
  assert.equal(iso(ET('2026-03-09', '09:00')), '2026-03-09T13:00:00.000Z');
  assert.equal(iso(ET('2026-03-06', '09:00')), '2026-03-06T14:00:00.000Z');
  assert.equal(iso(ET('2026-11-02', '09:00')), '2026-11-02T14:00:00.000Z');
  assert.equal(iso(ET('2026-10-30', '09:00')), '2026-10-30T13:00:00.000Z');
  assert.equal(iso(ET('2026-11-01', '12:00')), '2026-11-01T17:00:00.000Z'); // EST after fall back
});

test('plan definitions and weekend/holiday handling', () => {
  const sch = (plan) => S.scheduleOf({ schedule: { enabled: true, plan, cryptoRuns: [] } });
  assert.deepEqual(S.slotsForDay('2026-09-30', sch('A')).map((s) => s.timeEt), ['09:00', '12:30']);
  assert.deepEqual(S.slotsForDay('2026-09-30', sch('B')).map((s) => s.timeEt), ['09:00']);
  assert.deepEqual(S.slotsForDay('2026-09-30', sch('C')).map((s) => s.timeEt), ['09:00']);
  assert.deepEqual(S.slotsForDay('2026-09-30', sch('D')).map((s) => s.timeEt), ['09:00', '13:00', '16:15']);
  assert.deepEqual(S.slotsForDay('2026-10-03', sch('A')), []); // Saturday
  const hol = S.slotsForDay('2026-09-07', sch('B')); // Labor Day
  assert.equal(hol[0].skipReason, 'market_holiday');
});

test('half-day moves the after-close slot 3h earlier; crypto runs are daily and merge with same-time slots', () => {
  const d = S.scheduleOf({ schedule: { enabled: true, plan: 'D', cryptoRuns: [] } });
  assert.deepEqual(S.slotsForDay('2026-11-27', d).map((s) => s.timeEt), ['09:00', '13:00', '13:15']); // day after Thanksgiving closes 13:00
  const b = S.scheduleOf({ schedule: { enabled: true, plan: 'B', cryptoRuns: ['09:00', '21:00'] } });
  const sat = S.slotsForDay('2026-10-03', b);
  assert.deepEqual(sat.map((s) => [s.timeEt, s.scope]), [['09:00', 'crypto'], ['21:00', 'crypto']]);
  const wk = S.slotsForDay('2026-09-30', b);
  assert.deepEqual(wk.map((s) => [s.timeEt, s.scope]), [['09:00', 'all'], ['21:00', 'crypto']]);
});

// ---- scheduling / durability ----
test('fires a due slot once, records trigger, and never double-fires across a simulated restart', async () => {
  setSchedule({ enabled: true, plan: 'B' });
  const t = ET('2026-09-30', '09:01');
  const a = deps(t);
  const r1 = await S.schedulerTick({ deps: a.deps });
  assert.deepEqual(r1.fired, ['2026-09-30T09:00/stocks']);
  assert.equal(a.calls[0].trigger.type, 'schedule');
  assert.equal(a.calls[0].trigger.plan, 'B');
  assert.equal(a.calls[0].trigger.slot, '2026-09-30T09:00/stocks');
  assert.equal(store.getScheduleState().lastFiredKey, '2026-09-30T09:00/stocks');
  // "restart": new tick with fresh in-memory context, same persisted state
  const b = deps(t + 5 * 60_000);
  await S.schedulerTick({ deps: b.deps });
  assert.equal(b.calls.length, 0);
  // state file lost (redeploy) but run history carries the slot
  store.setScheduleState({});
  store.setRuns([{ runId: 'r1', at: iso(t), status: 'done', trigger: { type: 'schedule', plan: 'B', slot: '2026-09-30T09:00/stocks' } }]);
  const c = deps(t + 6 * 60_000);
  await S.schedulerTick({ deps: c.deps });
  assert.equal(c.calls.length, 0);
});

test('grace window: a slot missed within 20 min after a restart fires once; older is skipped and logged', async () => {
  setSchedule({ enabled: true, plan: 'A' });
  const logs = [];
  const late = deps(ET('2026-09-30', '09:19'), { log: (l, m) => logs.push(m) });
  const r = await S.schedulerTick({ deps: late.deps });
  assert.deepEqual(r.fired, ['2026-09-30T09:00/stocks']);
  const older = deps(ET('2026-09-30', '13:00'), { log: (l, m) => logs.push(m) }); // 12:30 slot is 30 min old
  const r2 = await S.schedulerTick({ deps: older.deps });
  assert.deepEqual(r2.missed, ['2026-09-30T12:30/stocks']);
  assert.equal(older.calls.length, 0);
  assert.ok(logs.some((m) => /missed/.test(m)));
  const view = S.scheduleView({ now: ET('2026-09-30', '13:00') });
  assert.deepEqual(view.slotsToday.map((s) => s.status), ['fired', 'missed']);
  assert.equal(view.tz, 'America/New_York');
});

test('disabled schedule, stopped worker and holidays fire nothing', async () => {
  const t = ET('2026-09-30', '09:01');
  let x = deps(t);
  await S.schedulerTick({ deps: x.deps });
  assert.equal(x.calls.length, 0); // disabled
  setSchedule({ enabled: true, plan: 'B' });
  x = deps(t, { workerAlive: () => false });
  await S.schedulerTick({ deps: x.deps });
  assert.equal(x.calls.length, 0);
  x = deps(ET('2026-09-07', '09:01')); // Labor Day
  const r = await S.schedulerTick({ deps: x.deps });
  assert.equal(x.calls.length, 0);
  assert.deepEqual(r.skipped, [{ id: '2026-09-07T09:00/stocks', reason: 'market_holiday' }]);
});

test('in-flight guard: never starts while a run is in progress; retries within grace', async () => {
  setSchedule({ enabled: true, plan: 'B' });
  const busy = deps(ET('2026-09-30', '09:01'), { isRunning: () => true });
  await S.schedulerTick({ deps: busy.deps });
  assert.equal(busy.calls.length, 0);
  assert.equal(S.scheduleView({ now: ET('2026-09-30', '09:02') }).slotsToday[0].status, 'upcoming');
  const free = deps(ET('2026-09-30', '09:05'));
  await S.schedulerTick({ deps: free.deps });
  assert.equal(free.calls.length, 1);
  // startRun itself refusing (race) does not consume the slot
  store.setScheduleState({});
  const race = deps(ET('2026-09-30', '09:06'), { startRun: () => false });
  await S.schedulerTick({ deps: race.deps });
});

test('budget-aware: skip with reason when remaining < projected cost; warn drops event runs before scheduled ones', async () => {
  setSchedule({ enabled: true, plan: 'B' });
  const logs = [];
  const poor = deps(ET('2026-09-30', '09:01'), { budget: budgetOk({ remainingUsd: 0.05 }), log: (l, m) => logs.push(m) });
  const r = await S.schedulerTick({ deps: poor.deps });
  assert.equal(poor.calls.length, 0);
  assert.equal(r.skipped[0].reason, 'insufficient_budget');
  assert.ok(logs.some((m) => /skipped.*below the projected cost/.test(m)));
  const lr = S.scheduleView({ now: ET('2026-09-30', '09:02') });
  assert.equal(lr.slotsToday[0].status, 'skipped');
  assert.equal(lr.lastRuns[0].status, 'skipped');
  // warn level: scheduled still runs, event dropped
  const warn = { budget: budgetOk({ level: 'warn', remainingUsd: 5 }) };
  const sched = deps(ET('2026-10-01', '09:01'), warn);
  assert.equal(S.attemptRun({ type: 'schedule', slot: 'x' }, sched.deps).started, true);
  assert.equal(S.attemptRun({ type: 'event' }, sched.deps).reason, 'budget_warn_event_dropped');
  assert.equal(S.attemptRun({ type: 'event' }, deps(0).deps).started, true);
  // AI not ready
  assert.equal(S.attemptRun({ type: 'schedule' }, deps(0, { ai: () => ({ ready: false, blockedReason: 'no_api_key' }) }).deps).reason, 'no_api_key');
});

// ---- events ----
test('event thresholds: SPY/BTC/shortlist, absolute moves, stocks ignored when market closed', () => {
  const ev = S.DEFAULT_EVENT_TRIGGERS;
  assert.equal(S.evaluateEventTriggers(ev, [{ symbol: 'SPY', movePct: 0.9 }]), null);
  assert.equal(S.evaluateEventTriggers(ev, [{ symbol: 'SPY', movePct: -1.0 }]).kind, 'spy');
  assert.equal(S.evaluateEventTriggers(ev, [{ symbol: 'BTC/USD', movePct: 2.4 }]), null);
  assert.equal(S.evaluateEventTriggers(ev, [{ symbol: 'BTC/USD', movePct: 2.5 }]).kind, 'btc');
  assert.equal(S.evaluateEventTriggers(ev, [{ symbol: 'NVDA', movePct: 3 }]).kind, 'shortlist');
  assert.equal(S.evaluateEventTriggers(ev, [{ symbol: 'NVDA', movePct: 3 }, { symbol: 'SPY', movePct: 1.5 }]).symbol, 'SPY'); // strongest ratio
  assert.equal(S.evaluateEventTriggers(ev, [{ symbol: 'SPY', movePct: 5 }], { marketOpen: false }), null);
  assert.equal(S.evaluateEventTriggers(ev, [{ symbol: 'BTC/USD', movePct: 5 }], { marketOpen: false }).kind, 'btc');
});

test('event cooldown and daily cap (durable), trigger recorded with reason', async () => {
  setSchedule({ enabled: true, plan: 'C', cryptoRuns: [], eventTriggers: { minMinutesBetweenEventRuns: 120, maxEventRunsPerDay: 2 } });
  store.setAiPicks({ picks: [{ symbol: 'NVDA' }], updatedAt: null });
  const moves = async () => [{ symbol: 'BTC/USD', movePct: 3 }];
  const t0 = ET('2026-09-30', '10:30'); // after the 09:00 slot grace, so only events matter
  store.setScheduleState({ slots: { '2026-09-30T09:00/stocks': { status: 'fired' } } });
  const a = deps(t0, { getMoves: moves });
  const r1 = await S.schedulerTick({ deps: a.deps });
  assert.equal(r1.event.started, true);
  assert.equal(a.calls[0].trigger.type, 'event');
  assert.match(a.calls[0].trigger.reason, /BTC\/USD moved \+3%/);
  const b = deps(t0 + 60 * 60_000, { getMoves: moves });
  await S.schedulerTick({ deps: b.deps });
  assert.equal(b.calls.length, 0); // cooldown
  const c = deps(t0 + 121 * 60_000, { getMoves: moves });
  await S.schedulerTick({ deps: c.deps });
  assert.equal(c.calls.length, 1);
  const d = deps(t0 + 300 * 60_000, { getMoves: moves });
  await S.schedulerTick({ deps: d.deps });
  assert.equal(d.calls.length, 0); // daily cap 2
  assert.equal(S.scheduleView({ now: t0 + 300 * 60_000 }).eventTriggers.firedToday, 2);
  // next ET day resets the cap
  const e = deps(ET('2026-10-01', '10:30'), { getMoves: moves });
  store.setScheduleState({ ...store.getScheduleState(), slots: { ...store.getScheduleState().slots, '2026-10-01T09:00/stocks': { status: 'fired' } } });
  await S.schedulerTick({ deps: e.deps });
  assert.equal(e.calls.length, 1);
});

test('event poll makes no move fetch when events are off and never polls without thresholds (no LLM)', async () => {
  setSchedule({ enabled: true, plan: 'B' });
  let fetched = 0;
  const a = deps(ET('2026-09-30', '10:30'), { getMoves: async () => (fetched++, []) });
  store.setScheduleState({ slots: { '2026-09-30T09:00/stocks': { status: 'fired' } } });
  await S.schedulerTick({ deps: a.deps });
  assert.equal(fetched, 0);
  setSchedule({ plan: 'C' });
  await S.schedulerTick({ deps: a.deps });
  assert.equal(fetched, 1);
  assert.equal(a.calls.length, 0);
});

// ---- forecast ----
test('forecast: runs/month counts real trading days and crypto runs; plan C/D event assumptions', () => {
  setSchedule({ cryptoRuns: [] });
  const now = ET('2026-09-01', '08:00'); // Sep 1..30 2026: 22 weekdays, Labor Day (Sep 7) is a holiday -> 21 trading days
  const f = S.forecast({ now });
  const by = Object.fromEntries(f.plans.map((p) => [p.plan, p]));
  assert.equal(by.B.runsPerMonth, 21);
  assert.equal(by.A.runsPerMonth, 42);
  assert.equal(by.D.runsPerMonth, 63);
  assert.equal(by.C.eventRunsAssumed, 4);
  assert.equal(by.D.eventRunsAssumed, 0);
  assert.equal(by.custom.runsPerMonth, 0);
  assert.equal(f.current, 'B');
  setSchedule({ cryptoRuns: ['09:00', '21:00'] });
  const g = S.forecast({ plan: 'B', now });
  assert.equal(g.plans.length, 1);
  assert.equal(g.plans[0].runsPerMonth, 60); // 09:00 crypto merges with B's 09:00 on trading days; 21:00 daily adds 30; 09:00 adds the 9 non-trading days
});

test('forecast cost basis: unknown -> estimated -> measured, pct of budget and fit', () => {
  const now = ET('2026-09-01', '08:00');
  const f0 = S.forecastForPlan('B', { now });
  // default models are not in the (empty) catalog -> unknown, no fake number
  assert.equal(f0.basis, 'unknown');
  assert.equal(f0.estCostPerRunUsd, null);
  assert.equal(f0.projectedMonthlyUsd, null);
  assert.equal(f0.fitsBudget, null);
  const saved = [config.openrouter.scannerModel, config.openrouter.traderModel];
  config.openrouter.scannerModel = 'x/free-model:free';
  config.openrouter.traderModel = 'y/free-model:free';
  const f1 = S.forecastForPlan('B', { now });
  assert.equal(f1.basis, 'estimated');
  assert.equal(f1.estCostPerRunUsd, 0);
  assert.equal(f1.fitsBudget, true);
  [config.openrouter.scannerModel, config.openrouter.traderModel] = saved;
  // measured from two full runs ($0.30 and $0.50) + one scanner-only run that must be ignored
  for (const [run, s, tr] of [['r1', 0.2, 0.1], ['r2', 0.3, 0.2]]) {
    recordSpend({ bot: 'scanner', model: 'm', promptTokens: 10, completionTokens: 10, costUsd: s, runId: run });
    recordSpend({ bot: 'trader', model: 'm', promptTokens: 10, completionTokens: 10, costUsd: tr, runId: run });
  }
  recordSpend({ bot: 'scanner', model: 'm', promptTokens: 10, completionTokens: 10, costUsd: 0.05, runId: 'r3' });
  recordSpend({ bot: 'scanner', model: 'm', costUsd: 9, runId: 'm1', mock: true });
  const f2 = S.forecastForPlan('B', { now });
  assert.equal(f2.basis, 'measured');
  assert.equal(f2.estCostPerRunUsd, 0.4);
  assert.equal(f2.projectedMonthlyUsd, 8.4); // 21 runs
  assert.equal(f2.pctOfBudget, 42);
  assert.equal(f2.fitsBudget, true);
  assert.equal(S.forecastForPlan('D', { now }).fitsBudget, false); // 63 x 0.4 = 25.2 > 20
});

// ---- experiments ----
test('experiments aggregate by plan and trigger type; edgePerDollar null until enough samples', () => {
  const mkRun = (i, type, plan, cost, n) => ({ runId: `run_${i}`, at: iso(Date.now() - i * 1000), status: 'done', costUsd: cost, proposalCount: n, trigger: { type, plan } });
  store.setRuns([mkRun(1, 'schedule', 'A', 0.4, 2), mkRun(2, 'schedule', 'A', 0.2, 4), mkRun(3, 'event', 'C', 0.3, 1), { runId: 'old', at: iso(0), status: 'done', costUsd: 0.1, proposalCount: 0 }]);
  const prop = (runId, status, pnl) => ({ id: `${runId}${status}${pnl}`, runId, status, shadow: pnl === null ? null : { hypotheticalPnl: pnl } });
  store.setProposals([prop('run_1', 'approved', 10), prop('run_1', 'rejected', -4), prop('run_2', 'approved', 6), prop('run_3', 'rejected', 5), prop('run_2', 'pending', null)]);
  const x = S.experiments();
  const A = x.plans.find((p) => p.plan === 'A');
  assert.equal(A.runs, 2);
  assert.ok(Math.abs(A.avgCostUsd - 0.3) < 1e-9);
  assert.equal(A.proposalsPerRun, 3);
  assert.equal(A.approvalRate, 0.667);
  assert.equal(A.netEdgeContribution, 20); // 10 + 6 + avoided 4
  assert.equal(A.edgePerDollar, null);
  assert.match(A.minSampleNote, /at least 10 runs/);
  assert.equal(A.byTrigger[0].type, 'schedule');
  assert.ok(x.plans.find((p) => p.plan === 'C').byTrigger.some((t) => t.type === 'event'));
  assert.ok(x.plans.find((p) => p.plan === 'none').byTrigger.some((t) => t.type === 'manual'));
  // enough samples -> a number
  store.setRuns(Array.from({ length: 10 }, (_, i) => mkRun(i + 10, 'schedule', 'B', 0.5, 1)));
  store.setProposals(Array.from({ length: 10 }, (_, i) => prop(`run_${i + 10}`, 'approved', 3)));
  assert.equal(S.experiments().plans.find((p) => p.plan === 'B').edgePerDollar, 6);
});

// ---- settings validation ----
test('settings validation: bad times, unknown plans and fields rejected; partial merge keeps the rest', () => {
  const bad = (schedule) => validateSettings({ schedule }).error;
  assert.match(bad({ plan: 'Z' }), /plan/);
  assert.match(bad({ custom: [{ time: '25:00', days: 'daily', scope: 'all' }] }), /time/);
  assert.match(bad({ custom: [{ time: '9:00', days: 'daily', scope: 'all' }] }), /time/);
  assert.match(bad({ custom: [{ time: '09:00', days: 'sometimes', scope: 'all' }] }), /days/);
  assert.match(bad({ custom: [{ time: '09:00', days: 'daily', scope: 'bonds' }] }), /scope/);
  assert.match(bad({ cryptoRuns: ['09:61'] }), /cryptoRuns/);
  assert.match(bad({ enabled: 'yes' }), /enabled/);
  assert.match(bad({ nope: 1 }), /unknown schedule field/);
  assert.match(bad({ eventTriggers: { spyMovePct: -1 } }), /spyMovePct/);
  assert.match(bad({ eventTriggers: { minMinutesBetweenEventRuns: 1 } }), /minMinutes/);
  assert.match(bad({ eventTriggers: { bogus: 1 } }), /unknown/);
  assert.ok(validateSettings({ schedule: { plan: 'custom', custom: [{ time: '07:45', days: 'weekdays', scope: 'stocks' }], eventTriggers: { newsCatalyst: true } } }).value);
  const merged = S.mergeSchedule({ enabled: true, plan: 'A', eventTriggers: { spyMovePct: 2 } }, { eventTriggers: { btcMovePct: 4 } });
  assert.equal(merged.enabled, true);
  assert.equal(merged.eventTriggers.spyMovePct, 2);
  assert.equal(merged.eventTriggers.btcMovePct, 4);
  assert.equal(merged.eventTriggers.maxEventRunsPerDay, 2);
});

// ---- HTTP ----
const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(() => server.close());
const call = (method, url, body, headers = {}) => fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

test('HTTP: settings PATCH persists schedule; GET /schedule, /forecast, /experiments and status.budget.forecast', async () => {
  let r = await call('PATCH', '/settings', { schedule: { enabled: true, plan: 'A' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).schedule.plan, 'A');
  r = await call('PATCH', '/settings', { schedule: { plan: 'Q' } });
  assert.equal(r.status, 400);
  const view = await (await call('GET', '/schedule')).json();
  assert.equal(view.enabled, true);
  assert.equal(view.plan, 'A');
  assert.equal(view.tz, 'America/New_York');
  assert.ok(Array.isArray(view.slotsToday) && Array.isArray(view.lastRuns));
  assert.equal(view.eventTriggers.firedToday, 0);
  const f = await (await call('GET', '/schedule/forecast')).json();
  assert.equal(f.plans.length, 5);
  assert.equal((await call('GET', '/schedule/forecast?plan=nope')).status, 400);
  assert.equal((await (await call('GET', '/schedule/forecast?plan=D')).json()).plans[0].plan, 'D');
  assert.ok((await (await call('GET', '/schedule/experiments')).json()).plans);
  const st = await (await call('GET', '/status')).json();
  assert.equal(st.budget.forecast.plan, 'A');
  assert.equal(typeof st.budget.projectedMonthEndUsd, 'number');
  assert.equal(st.budget.projectedMonthEndUsd, (await (await call('GET', '/budget')).json()).projectedMonthEndUsd);
});

test('HTTP: test-fire needs CSRF-safe JSON, 409 when a run is in progress or the worker is stopped, 400 on unknown slot', async () => {
  process.env.MOCK_LLM = 'true'; // AI "ready" via the demo fixture
  assert.equal((await fetch(`${base}/schedule/test-fire`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 403);
  assert.equal((await call('POST', '/schedule/test-fire', { slotId: 'nope' })).status, 400);
  runState.running = true;
  let r = await call('POST', '/schedule/test-fire', {});
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'run_in_progress');
  runState.running = false;
  store.setWorker({ ...store.getWorker(), status: 'stopped' });
  r = await call('POST', '/schedule/test-fire', {});
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'worker_not_running');
  store.setWorker({ ...store.getWorker(), status: 'online' });
  r = await call('POST', '/schedule/test-fire', {});
  assert.equal(r.status, 202);
  const j = await r.json();
  assert.equal(j.trigger.type, 'test');
  for (let i = 0; i < 100 && runState.running; i++) await new Promise((x) => setTimeout(x, 50));
  const runs = (await (await call('GET', '/runs')).json()).runs;
  assert.equal(runs[0].trigger.type, 'test');
  delete process.env.MOCK_LLM;
});
