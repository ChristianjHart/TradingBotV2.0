// Run schedules + event triggers + cost forecast. America/New_York wall-clock slots (DST-safe via Intl, no deps), NYSE holiday /
// half-day table from market.js, durable fired-slot state (store.getScheduleState) so a restart/redeploy never double-fires.
// The AI is required: nothing here has a rule-based fallback; a run that cannot be afforded is SKIPPED with a logged reason.
import { store } from '../db/store.js';
import { config } from '../config.js';
import { alpaca } from './alpaca.js';
import { startAiRun, runState, aiStatus } from './aiRun.js';
import { NYSE_HOLIDAYS, NYSE_HALF_DAYS, usMarketOpen } from './market.js';
import { budgetStatus, budgetCapUsd, priceOf, costFromTokens, DEFAULT_TOKENS, FALLBACK_PRICE, tokenProfile } from './spend.js';

export const TZ = 'America/New_York';
export const GRACE_MS = 20 * 60_000;
export const PLANS = ['A', 'B', 'C', 'D', 'custom'];
export const SCOPES = ['stocks', 'crypto', 'all'];
export const DAYS = ['weekdays', 'daily'];
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULT_CRYPTO_RUNS = []; // opt-in: a crypto run costs the same as a stock run
export const DEFAULT_EVENT_TRIGGERS = { enabled: false, spyMovePct: 1.0, btcMovePct: 2.5, shortlistMovePct: 3.0, minMinutesBetweenEventRuns: 120, maxEventRunsPerDay: 2, newsCatalyst: false };
export const EVENT_RUNS_ASSUMED = { A: 0, B: 0, C: 4, D: 0 };
export const PLAN_LABELS = {
  A: 'A: weekdays 09:00 + 12:30 ET',
  B: 'B: weekdays 09:00 ET',
  C: 'C: plan B + event triggers',
  D: 'D: weekdays 09:00, 13:00, 16:15 ET',
  custom: 'Custom slots',
};
const W = (time) => ({ time, days: 'weekdays', scope: 'stocks' });
export const PLAN_SLOTS = {
  A: [W('09:00'), W('12:30')],
  B: [W('09:00')],
  C: [W('09:00')],
  D: [W('09:00'), W('13:00'), W('16:15')],
};

// ---------- ET time helpers ----------
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
const parts = (ms) => Object.fromEntries(etFmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
const offsetAt = (ms) => {
  const p = parts(ms);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
};
/** 'YYYY-MM-DD' of the ET calendar day containing epoch ms. */
export const etDayKey = (ms) => {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
};
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dow = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat
/** Epoch ms of ET wall-clock HH:MM on `day` (DST-safe). */
export function etWallToMs(day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, m);
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return wall - offsetAt(t);
}
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const isTradingDay = (day) => dow(day) >= 1 && dow(day) <= 5 && !NYSE_HOLIDAYS.has(day);

// ---------- settings ----------
/** Schedule settings with defaults filled in (a partial/old settings file is fine). */
export function scheduleOf(settings = store.getSettings()) {
  const s = settings?.schedule || {};
  return {
    enabled: s.enabled === true,
    plan: PLANS.includes(s.plan) ? s.plan : 'B',
    custom: Array.isArray(s.custom) ? s.custom : [],
    cryptoRuns: Array.isArray(s.cryptoRuns) ? s.cryptoRuns : [...DEFAULT_CRYPTO_RUNS],
    eventTriggers: { ...DEFAULT_EVENT_TRIGGERS, ...(s.eventTriggers || {}) },
  };
}
/** Plan C always has event triggers on; any plan honours the explicit flag. */
export const eventsActive = (sch) => sch.plan === 'C' || sch.eventTriggers.enabled === true;

/** Validates a (partial) `schedule` settings object. Returns { value } or { error }. */
export function validateSchedule(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'invalid value for schedule' };
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'enabled') {
      if (typeof x !== 'boolean') return { error: 'invalid value for schedule.enabled' };
      out.enabled = x;
    } else if (k === 'plan') {
      if (!PLANS.includes(x)) return { error: `invalid value for schedule.plan (one of ${PLANS.join(', ')})` };
      out.plan = x;
    } else if (k === 'custom') {
      if (!Array.isArray(x) || x.length > 24) return { error: 'invalid value for schedule.custom (array of at most 24 slots)' };
      const list = [];
      for (const s of x) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) return { error: 'invalid schedule.custom slot' };
        for (const key of Object.keys(s)) if (!['time', 'days', 'scope'].includes(key)) return { error: `unknown schedule.custom field: ${key}` };
        if (typeof s.time !== 'string' || !TIME_RE.test(s.time)) return { error: `invalid schedule.custom time (HH:MM, 00:00-23:59): ${String(s.time)}` };
        if (!DAYS.includes(s.days)) return { error: 'invalid schedule.custom days (weekdays|daily)' };
        if (!SCOPES.includes(s.scope)) return { error: 'invalid schedule.custom scope (stocks|crypto|all)' };
        list.push({ time: s.time, days: s.days, scope: s.scope });
      }
      out.custom = list;
    } else if (k === 'cryptoRuns') {
      if (!Array.isArray(x) || x.length > 12 || x.some((t) => typeof t !== 'string' || !TIME_RE.test(t))) return { error: 'invalid value for schedule.cryptoRuns (up to 12 HH:MM strings)' };
      out.cryptoRuns = [...new Set(x)];
    } else if (k === 'eventTriggers') {
      if (!x || typeof x !== 'object' || Array.isArray(x)) return { error: 'invalid value for schedule.eventTriggers' };
      const rules = {
        enabled: (n) => typeof n === 'boolean',
        newsCatalyst: (n) => typeof n === 'boolean',
        spyMovePct: (n) => Number.isFinite(n) && n >= 0.1 && n <= 20,
        btcMovePct: (n) => Number.isFinite(n) && n >= 0.1 && n <= 30,
        shortlistMovePct: (n) => Number.isFinite(n) && n >= 0.1 && n <= 50,
        minMinutesBetweenEventRuns: (n) => Number.isInteger(n) && n >= 5 && n <= 1440,
        maxEventRunsPerDay: (n) => Number.isInteger(n) && n >= 0 && n <= 10,
      };
      const ev = {};
      for (const [ek, ev1] of Object.entries(x)) {
        if (!Object.hasOwn(rules, ek)) return { error: `unknown schedule.eventTriggers field: ${ek}` };
        if (!rules[ek](ev1)) return { error: `invalid value for schedule.eventTriggers.${ek}` };
        ev[ek] = ev1;
      }
      out.eventTriggers = ev;
    } else {
      return { error: `unknown schedule field: ${k}` };
    }
  }
  return { value: out };
}

/** Deep-merge a validated partial schedule into the current one (lists replace, eventTriggers merge). */
export function mergeSchedule(current, patch) {
  const cur = scheduleOf({ schedule: current });
  return { ...cur, ...patch, eventTriggers: { ...cur.eventTriggers, ...(patch.eventTriggers || {}) } };
}

// ---------- slot computation ----------
/** Raw slot definitions (before per-day expansion) for the schedule: plan slots + daily crypto runs. */
export function rawSlots(sch) {
  const base = sch.plan === 'custom' ? sch.custom : PLAN_SLOTS[sch.plan] || [];
  return [...base, ...sch.cryptoRuns.map((time) => ({ time, days: 'daily', scope: 'crypto' }))];
}

/**
 * Concrete slots for one ET day, sorted by time. Same-time slots merge (scope differs -> 'all'). Stock-scope slots get
 * skipReason 'market_holiday' / 'weekend' on non-trading days; on a half-day a stock slot at/after 16:00 moves 3h earlier
 * (same offset from the 13:00 early close).
 */
export function slotsForDay(day, sch) {
  const weekday = dow(day) >= 1 && dow(day) <= 5;
  const byTime = new Map();
  for (const r of rawSlots(sch)) {
    if (r.days === 'weekdays' && !weekday) continue;
    let time = r.time;
    if (r.scope !== 'crypto' && NYSE_HALF_DAYS.has(day) && toMin(time) >= 16 * 60) time = toHHMM(toMin(time) - 180);
    const prev = byTime.get(time);
    byTime.set(time, prev && prev !== r.scope ? 'all' : r.scope);
  }
  return [...byTime.entries()]
    .sort((a, b) => toMin(a[0]) - toMin(b[0]))
    .map(([time, scope]) => {
      const atMs = etWallToMs(day, time);
      const slot = { id: `${day}T${time}/${scope}`, day, timeEt: time, timeUtc: new Date(atMs).toISOString(), atMs, scope };
      if (scope === 'stocks' && !isTradingDay(day)) slot.skipReason = weekday ? 'market_holiday' : 'weekend';
      return slot;
    });
}

// ---------- durable state ----------
function pruneState(state, today) {
  const cutoff = addDays(today, -14);
  for (const id of Object.keys(state.slots)) if (id.slice(0, 10) < cutoff) delete state.slots[id];
  state.skips = (state.skips || []).slice(0, 50);
}
const loadState = () => store.getScheduleState();
const saveState = (st) => store.setScheduleState(st);

/** Was this slot already handled (state file, or a run in history carrying trigger.slot — survives a lost state file). */
function slotDone(id, state) {
  if (state.slots[id]) return state.slots[id];
  const run = store.getRuns().find((r) => r.trigger?.slot === id && r.trigger?.type === 'schedule');
  return run ? { status: 'fired', runId: run.runId, at: run.at } : null;
}

// ---------- cost estimation ----------
const r6 = (n) => Math.round(n * 1e6) / 1e6;
/**
 * Cost of one FULL run (scanner + trader). Measured = average over the last 20 ledger runs that include both bots (mock/demo
 * calls and failed runs excluded); else estimated from the selected models' catalog prices x token profile; 'unknown' when a
 * selected model has no price (usd null; gatingUsd still uses the conservative fallback price so budget checks stay safe).
 */
export function estimateRunCost() {
  const byRun = new Map();
  for (const e of store.getSpend()) {
    if (!e.runId || e.mock) continue;
    const r = byRun.get(e.runId) || { usd: 0, bots: new Set(), ok: true };
    r.usd += e.costUsd || 0;
    r.bots.add(e.bot);
    if (!e.ok) r.ok = false;
    byRun.set(e.runId, r);
  }
  const full = [...byRun.values()].filter((r) => r.ok && r.bots.has('scanner') && r.bots.has('trader')).slice(-20);
  if (full.length) {
    const usd = r6(full.reduce((s, r) => s + r.usd, 0) / full.length);
    return { usd, gatingUsd: usd, basis: 'measured', samples: full.length };
  }
  const models = { scanner: config.openrouter.scannerModel, trader: config.openrouter.traderModel };
  let total = 0;
  let gating = 0;
  let known = true;
  for (const bot of ['scanner', 'trader']) {
    const price = priceOf(models[bot]);
    const tok = tokenProfile(bot);
    if (!price) known = false;
    total += price ? costFromTokens(price, tok.prompt, tok.completion) : 0;
    gating += costFromTokens(price || FALLBACK_PRICE, tok.prompt, tok.completion);
  }
  return known ? { usd: r6(total), gatingUsd: r6(gating), basis: 'estimated', samples: 0 } : { usd: null, gatingUsd: r6(gating), basis: 'unknown', samples: 0 };
}

// ---------- forecast ----------
/** Number of scheduled runs in the next `days` ET days starting with today (real trading days / holidays / crypto runs). */
export function runsInWindow(sch, now = Date.now(), days = 30) {
  let n = 0;
  const today = etDayKey(now);
  for (let i = 0; i < days; i++) n += slotsForDay(addDays(today, i), sch).filter((s) => !s.skipReason).length;
  return n;
}

export function forecastForPlan(plan, { now = Date.now(), cost = estimateRunCost(), settings = store.getSettings() } = {}) {
  const cur = scheduleOf(settings);
  const sch = { ...cur, plan };
  const runsPerMonth = runsInWindow(sch, now, 30);
  const eventRunsAssumed = plan in EVENT_RUNS_ASSUMED && plan !== 'A' && plan !== 'B' ? EVENT_RUNS_ASSUMED[plan] : cur.eventTriggers.enabled ? 4 : 0;
  const cap = budgetCapUsd();
  const per = cost.usd;
  const total = per === null ? null : r6((runsPerMonth + eventRunsAssumed) * per);
  const pct = total === null || cap <= 0 ? null : Math.round((total / cap) * 1000) / 10;
  const notes = [];
  notes.push(`${runsPerMonth} scheduled runs in the next 30 days (trading days only for stock slots${cur.cryptoRuns.length ? `, plus ${cur.cryptoRuns.length} daily crypto run(s)` : ''})`);
  if (eventRunsAssumed) notes.push(`${eventRunsAssumed} event-triggered runs/month assumed (estimate; capped by maxEventRunsPerDay and the cooldown)`);
  else if (plan === 'D') notes.push('D has no event triggers: its 3 fixed slots already cover the day');
  notes.push(cost.basis === 'measured' ? `cost per run measured from ${cost.samples} recent full run(s)` : cost.basis === 'estimated' ? 'cost per run ESTIMATED from model prices x default token sizes (no measured runs yet)' : 'cost per run unknown: a selected model has no known price (catalog not loaded?)');
  return {
    plan,
    label: PLAN_LABELS[plan],
    runsPerMonth,
    eventRunsAssumed,
    estCostPerRunUsd: per,
    basis: cost.basis,
    projectedMonthlyUsd: total,
    pctOfBudget: pct,
    fitsBudget: total === null ? null : total <= cap + 1e-9,
    note: notes.join('. '),
  };
}

export function forecast({ plan, now = Date.now(), settings = store.getSettings() } = {}) {
  const cost = estimateRunCost();
  const cur = scheduleOf(settings);
  const list = plan ? [plan] : PLANS;
  return {
    current: cur.plan,
    enabled: cur.enabled,
    capUsd: budgetCapUsd(),
    estCostPerRunUsd: cost.usd,
    basis: cost.basis,
    plans: list.map((p) => forecastForPlan(p, { now, cost, settings })),
  };
}

// ---------- experiments ----------
export const MIN_EXPERIMENT_RUNS = 10;
export const MIN_EXPERIMENT_SCORED = 10;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

function aggregate(runs, proposalsByRun, weights) {
  const n = runs.length;
  const cost = runs.reduce((s, r) => s + (r.costUsd || 0), 0);
  let proposals = 0;
  let approved = 0;
  let decided = 0;
  let scored = 0;
  let approvedNet = 0;
  let avoided = 0;
  for (const r of runs) {
    proposals += r.proposalCount ?? r.proposals?.length ?? 0;
    for (const p of proposalsByRun.get(r.runId) || []) {
      if (p.status === 'approved') { approved++; decided++; } else if (p.status === 'rejected' || p.status === 'expired') decided++;
      if (p.shadow && fin(p.shadow.hypotheticalPnl)) {
        if (p.status === 'approved') { scored++; approvedNet += p.shadow.hypotheticalPnl; } else if ((p.status === 'rejected' || p.status === 'expired') && p.shadow.hypotheticalPnl < 0) { scored++; avoided += Math.abs(p.shadow.hypotheticalPnl); } else if (p.status === 'rejected' || p.status === 'expired') scored++;
      }
    }
  }
  const net = scored ? Math.round((approvedNet + weights.avoided * avoided) * 100) / 100 : null;
  const enough = n >= MIN_EXPERIMENT_RUNS && scored >= MIN_EXPERIMENT_SCORED;
  return {
    runs: n,
    avgCostUsd: n ? r6(cost / n) : null,
    proposalsPerRun: n ? Math.round((proposals / n) * 100) / 100 : null,
    approvalRate: decided ? Math.round((approved / decided) * 1000) / 1000 : null,
    netEdgeContribution: net,
    edgePerDollar: enough && cost > 0 && net !== null ? Math.round((net / cost) * 100) / 100 : null,
    sampleSize: n,
    scoredProposals: scored,
    minSampleNote: enough ? null : `needs at least ${MIN_EXPERIMENT_RUNS} runs and ${MIN_EXPERIMENT_SCORED} shadow-scored proposals before edge per dollar means anything (have ${n} runs, ${scored} scored)`,
  };
}

/** Per plan and per trigger type aggregates over run history (cost falls back to the ledger when a run record lacks it). */
export function experiments(settings = store.getSettings()) {
  const ledger = new Map();
  for (const e of store.getSpend()) if (e.runId && !e.mock) ledger.set(e.runId, (ledger.get(e.runId) || 0) + (e.costUsd || 0));
  const runs = store.getRuns().filter((r) => !r.demo).map((r) => ({ ...r, costUsd: fin(r.costUsd) ? r.costUsd : r6(ledger.get(r.runId) || 0) }));
  const proposalsByRun = new Map();
  for (const p of store.getProposals()) {
    if (!proposalsByRun.has(p.runId)) proposalsByRun.set(p.runId, []);
    proposalsByRun.get(p.runId).push(p);
  }
  const weights = { avoided: Number.isFinite(settings.netEdgeAvoidedWeight) ? settings.netEdgeAvoidedWeight : 1 };
  const plans = new Map();
  for (const r of runs) {
    const plan = r.trigger?.plan || 'none';
    const type = r.trigger?.type || 'manual';
    if (!plans.has(plan)) plans.set(plan, { all: [], types: new Map() });
    const g = plans.get(plan);
    g.all.push(r);
    if (!g.types.has(type)) g.types.set(type, []);
    g.types.get(type).push(r);
  }
  return {
    minSample: { runs: MIN_EXPERIMENT_RUNS, scoredProposals: MIN_EXPERIMENT_SCORED },
    netEdgeDefinition: 'sum of shadow P&L of approved proposals + avoidedLoss weight x losses avoided by declined ones',
    plans: [...plans.entries()].map(([plan, g]) => ({
      plan,
      ...aggregate(g.all, proposalsByRun, weights),
      byTrigger: [...g.types.entries()].map(([type, list]) => ({ type, ...aggregate(list, proposalsByRun, weights) })),
    })),
  };
}

// ---------- events ----------
const STOCK_ONLY = (sym) => !sym.includes('/');

/** Pure threshold check. moves: [{symbol, movePct}] vs previous close. Returns the strongest hit or null. */
export function evaluateEventTriggers(ev, moves, { marketOpen = true } = {}) {
  let best = null;
  for (const m of moves) {
    if (!fin(m.movePct)) continue;
    if (STOCK_ONLY(m.symbol) && !marketOpen) continue;
    const threshold = m.symbol === 'SPY' ? ev.spyMovePct : m.symbol === 'BTC/USD' ? ev.btcMovePct : ev.shortlistMovePct;
    const kind = m.symbol === 'SPY' ? 'spy' : m.symbol === 'BTC/USD' ? 'btc' : 'shortlist';
    if (Math.abs(m.movePct) >= threshold) {
      const ratio = Math.abs(m.movePct) / threshold;
      if (!best || ratio > best.ratio) best = { symbol: m.symbol, movePct: Math.round(m.movePct * 100) / 100, threshold, kind, ratio };
    }
  }
  if (!best) return null;
  const { ratio: _r, ...hit } = best;
  return hit;
}

/** Cooldown + daily cap. Returns null when allowed, else the reason. */
export function eventGate(ev, evState, now) {
  const day = etDayKey(now);
  const count = evState.day === day ? evState.count : 0;
  if (count >= ev.maxEventRunsPerDay) return 'daily_cap';
  if (evState.lastAt && now - Date.parse(evState.lastAt) < ev.minMinutesBetweenEventRuns * 60_000) return 'cooldown';
  return null;
}

/** Cheap move poll, NO LLM: move of price vs previous daily close for SPY, BTC/USD and the current shortlist. */
export async function fetchMoves(symbols, now = Date.now()) {
  const out = [];
  for (const symbol of symbols) {
    try {
      const daily = await alpaca.getBars(symbol, { timeframe: '1Day', limit: 5 });
      const q = await alpaca.getQuote(symbol);
      if (!q || !daily.length) continue;
      const today = symbol.includes('/') ? new Date(now).toISOString().slice(0, 10) : etDayKey(now);
      const prev = [...daily].reverse().find((b) => String(b.t).slice(0, 10) < today);
      if (prev?.c) out.push({ symbol, movePct: ((q.price - prev.c) / prev.c) * 100 });
    } catch {
      /* skip this symbol */
    }
  }
  return out;
}

// ---------- firing ----------
const defaultDeps = () => ({
  now: () => Date.now(),
  startRun: (opts) => startAiRun(opts),
  isRunning: () => runState.running,
  ai: () => aiStatus(),
  budget: (now) => budgetStatus({ now }),
  estimate: () => estimateRunCost(),
  getMoves: (symbols, now) => fetchMoves(symbols, now),
  workerAlive: () => ['online', 'degraded'].includes(store.getWorker().status),
  log: (level, message) => store.addLog({ level, message }),
});
const mk = (d) => ({ ...defaultDeps(), ...(d || {}) });

function recordSkip(state, { at, trigger, reason }) {
  state.skips = [{ at: new Date(at).toISOString(), trigger: { ...trigger, reason }, status: 'skipped', costUsd: 0, proposals: 0, reason }, ...(state.skips || [])].slice(0, 50);
}

/**
 * Shared gate + start for scheduled, event and test runs. Returns { started } or { started:false, reason } where reason is one of
 * run_in_progress | worker_not_running | no_api_key | budget_exhausted | budget_warn_event_dropped | insufficient_budget.
 */
export function attemptRun({ type, slot = null, reason = null, plan }, deps) {
  const d = mk(deps);
  const now = d.now();
  const sch = scheduleOf();
  if (!d.workerAlive()) return { started: false, reason: 'worker_not_running' };
  if (d.isRunning()) return { started: false, reason: 'run_in_progress' };
  const ai = d.ai();
  if (!ai.ready) return { started: false, reason: ai.blockedReason === 'no_api_key' ? 'no_api_key' : 'budget_exhausted' };
  if (!ai.demo) {
    const b = d.budget(now);
    if (type === 'event' && b.level !== 'ok') return { started: false, reason: 'budget_warn_event_dropped' };
    const cost = d.estimate();
    if (b.remainingUsd < cost.gatingUsd) return { started: false, reason: 'insufficient_budget', detail: `remaining $${b.remainingUsd.toFixed(4)} < projected run cost $${cost.gatingUsd.toFixed(4)}` };
  }
  const trigger = { type, plan: plan ?? sch.plan, slot, reason };
  return { started: true, trigger };
}

const REASON_TEXT = {
  worker_not_running: 'worker is stopped',
  run_in_progress: 'a run is already in progress',
  no_api_key: 'no OpenRouter key configured',
  budget_exhausted: 'monthly AI budget used up',
  budget_warn_event_dropped: 'budget level is warn: event runs are dropped first',
  insufficient_budget: 'remaining budget is below the projected cost of a run',
};

/** Fire now through the same gate as a scheduled run. `persist(trigger)` runs BEFORE the run starts (durability). */
function fire(spec, deps, persist) {
  const d = mk(deps);
  const gate = attemptRun(spec, deps);
  if (!gate.started) return gate;
  persist?.(gate.trigger);
  if (!d.startRun({ trigger: gate.trigger })) return { started: false, reason: 'run_in_progress' };
  return gate;
}

/** POST /api/schedule/test-fire. Does not consume the slot. */
export function testFire({ slotId = null, plan } = {}, deps) {
  return fire({ type: 'test', slot: slotId, reason: 'owner test fire', plan }, deps);
}

/**
 * One scheduler pass (called every minute). Handles scheduled slots (durable, grace window, holidays, budget gating) and the
 * event-trigger poll. Never throws on a skipped run; returns a small report for tests.
 */
export async function schedulerTick(opts = {}) {
  const d = mk(opts.deps);
  const now = d.now();
  const sch = scheduleOf();
  const report = { fired: [], skipped: [], missed: [], event: null };
  if (!sch.enabled || !d.workerAlive()) return report;
  const state = loadState();
  const today = etDayKey(now);
  let dirty = false;

  const slots = [...slotsForDay(addDays(today, -1), sch), ...slotsForDay(today, sch)].filter((s) => s.atMs <= now);
  for (const slot of slots) {
    if (slotDone(slot.id, state)) continue;
    const age = now - slot.atMs;
    if (slot.skipReason) {
      state.slots[slot.id] = { status: 'skipped', reason: slot.skipReason, at: new Date(now).toISOString() };
      dirty = true;
      report.skipped.push({ id: slot.id, reason: slot.skipReason });
      continue;
    }
    if (age > GRACE_MS) {
      state.slots[slot.id] = { status: 'missed', reason: 'older_than_grace', at: new Date(now).toISOString() };
      dirty = true;
      report.missed.push(slot.id);
      d.log('warn', `schedule: slot ${slot.id} was missed (${Math.round(age / 60000)} min ago, grace is ${GRACE_MS / 60000} min); not run`);
      continue;
    }
    const spec = { type: 'schedule', slot: slot.id, reason: `${sch.plan === 'custom' ? 'custom' : `plan ${sch.plan}`} ${slot.timeEt} ET (${slot.scope})`, plan: sch.plan };
    const res = fire(spec, opts.deps, (trigger) => {
      state.slots[slot.id] = { status: 'fired', at: new Date(now).toISOString(), plan: trigger.plan };
      state.lastFiredKey = slot.id;
      saveState(state); // durable BEFORE the run starts
    });
    if (res.started) {
      report.fired.push(slot.id);
      continue; // state (incl. earlier changes this tick) was saved by persist() before the run started
    }
    if (res.reason === 'run_in_progress' || res.reason === 'worker_not_running') {
      d.log('warn', `schedule: slot ${slot.id} waiting: ${REASON_TEXT[res.reason]} (retries until the ${GRACE_MS / 60000}-minute grace ends)`);
      continue;
    }
    state.slots[slot.id] = { status: 'skipped', reason: res.reason, at: new Date(now).toISOString() };
    recordSkip(state, { at: now, trigger: { type: 'schedule', plan: sch.plan, slot: slot.id }, reason: res.reason });
    dirty = true;
    report.skipped.push({ id: slot.id, reason: res.reason });
    d.log('warn', `schedule: slot ${slot.id} skipped: ${REASON_TEXT[res.reason] || res.reason}${res.detail ? ` (${res.detail})` : ''}`);
  }

  // ---- event triggers (no LLM calls until a threshold is crossed) ----
  if (eventsActive(sch) && !d.isRunning()) {
    const ev = sch.eventTriggers;
    const gate = eventGate(ev, state.events, now);
    if (!gate && now - (opts.lastPollAt?.value || 0) >= (opts.pollEveryMs ?? 300_000)) {
      if (opts.lastPollAt) opts.lastPollAt.value = now;
      const open = usMarketOpen(new Date(now));
      const shortlist = (store.getAiPicks().picks || []).map((p) => p.symbol).filter(Boolean);
      const symbols = [...new Set(['SPY', 'BTC/USD', ...shortlist])].slice(0, 14);
      const moves = await d.getMoves(symbols, now);
      const hit = evaluateEventTriggers(ev, moves, { marketOpen: open });
      if (hit) {
        const reason = `${hit.symbol} moved ${hit.movePct > 0 ? '+' : ''}${hit.movePct}% vs previous close (threshold ${hit.threshold}%, ${hit.kind})`;
        const res = fire({ type: 'event', slot: null, reason, plan: sch.plan }, opts.deps, () => {
          const day = etDayKey(now);
          state.events = { day, count: (state.events.day === day ? state.events.count : 0) + 1, lastAt: new Date(now).toISOString() };
          saveState(state);
        });
        report.event = { hit, started: res.started, reason: res.reason };
        if (!res.started && res.reason !== 'run_in_progress') {
          if (!opts.lastEventSkip || now - opts.lastEventSkip.at > 3600_000) {
            if (opts.lastEventSkip) opts.lastEventSkip.at = now;
            recordSkip(state, { at: now, trigger: { type: 'event', plan: sch.plan, slot: null }, reason: res.reason });
            dirty = true;
            d.log('warn', `schedule: event run (${reason}) dropped: ${REASON_TEXT[res.reason] || res.reason}`);
          }
        }
      }
    }
  }
  if (dirty) {
    pruneState(state, today);
    saveState(state);
  }
  return report;
}

// ---------- read models ----------
/** GET /api/schedule */
export function scheduleView({ now = Date.now(), settings = store.getSettings() } = {}) {
  const sch = scheduleOf(settings);
  const state = loadState();
  const today = etDayKey(now);
  const slotsToday = slotsForDay(today, sch).map((s) => {
    const rec = slotDone(s.id, state);
    let status = 'upcoming';
    let reason;
    if (rec) {
      status = rec.status;
      reason = rec.reason;
    } else if (s.skipReason) {
      status = 'skipped';
      reason = s.skipReason;
    } else if (s.atMs <= now && now - s.atMs > GRACE_MS) {
      status = 'missed';
      reason = 'older_than_grace';
    }
    return { id: s.id, timeEt: s.timeEt, timeUtc: s.timeUtc, scope: s.scope, status, ...(reason ? { reason } : {}) };
  });
  let nextRunAt = null;
  if (sch.enabled) {
    for (let i = 0; i < 9 && !nextRunAt; i++) {
      const next = slotsForDay(addDays(today, i), sch).find((s) => !s.skipReason && s.atMs > now && !slotDone(s.id, state));
      if (next) nextRunAt = next.timeUtc;
    }
  }
  const fromRuns = store.getRuns().filter((r) => r.trigger).map((r) => ({ at: r.at, trigger: r.trigger, status: r.status || (r.error ? 'error' : 'done'), ...(r.code ? { code: r.code } : {}), costUsd: r.costUsd || 0, proposals: r.proposalCount ?? 0 }));
  const lastRuns = [...fromRuns, ...(state.skips || [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 20);
  const day = etDayKey(now);
  return {
    enabled: sch.enabled,
    plan: sch.plan,
    tz: TZ,
    custom: sch.custom,
    cryptoRuns: sch.cryptoRuns,
    slotsToday,
    nextRunAt,
    lastRuns,
    eventTriggers: { ...sch.eventTriggers, active: eventsActive(sch), firedToday: state.events.day === day ? state.events.count : 0 },
  };
}

/** Compact active-plan forecast for /api/status.budget. */
export function activeForecast({ now = Date.now(), settings = store.getSettings() } = {}) {
  const sch = scheduleOf(settings);
  const f = forecastForPlan(sch.plan, { now, settings });
  return { enabled: sch.enabled, plan: f.plan, runsPerMonth: f.runsPerMonth, eventRunsAssumed: f.eventRunsAssumed, estCostPerRunUsd: f.estCostPerRunUsd, basis: f.basis, projectedMonthlyUsd: f.projectedMonthlyUsd, pctOfBudget: f.pctOfBudget, fitsBudget: f.fitsBudget };
}

export { DEFAULT_TOKENS };
