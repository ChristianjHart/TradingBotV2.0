/* Pure, DOM-free helpers for the propose-and-approve flow: run problems, approval errors, countdowns, proposal card
   view-models, shadow "what-if" language, budget levels. Importable from node:test. Keep browser globals out of this file.
   Everything returned as text may contain server/LLM strings: callers must escape before putting it in HTML. */
import { fmtDuration, fmtMoney } from './api.js';
import { pctOf } from './run-logic.js';

export const BUDGET_WARN_PCT = 70;
export const DEFAULT_CAP_USD = 20;

/* ---------------------------------------------------------------- run problems (blocked / error stages) */

const SETTINGS_ACCOUNT = { id: 'link', label: 'Add your OpenRouter key', href: '#settings/account' };
const TRY_MODEL = { id: 'link', label: 'Try another model', href: '#settings/models' };
const RETRY = { id: 'retry', label: 'Retry run' };

const RUN_PROBLEMS = {
  no_api_key: { title: 'AI can’t run: no OpenRouter key', message: 'The scanner and trader are AI bots and need your OpenRouter key. Nothing ran, no trades were proposed.', actions: [SETTINGS_ACCOUNT] },
  budget_exhausted: {
    title: 'Monthly AI budget used up',
    message: 'The AI spend cap for this month has been reached, so the run was blocked. Nothing ran and nothing changed. The budget resets at the start of next month, or you can raise the cap.',
    actions: [{ id: 'link', label: 'Raise the cap', href: '#settings/budget' }],
  },
  rate_limited: { title: 'The AI model is rate-limited', message: 'OpenRouter is throttling this model (common with free models). Wait a minute and retry, or pick another model.', actions: [TRY_MODEL, RETRY] },
  timeout: { title: 'The AI took too long', message: 'The model did not answer in time. Retry, or pick a faster model.', actions: [TRY_MODEL, RETRY] },
  model_unavailable: { title: 'The AI model is unavailable', message: 'OpenRouter reports that this model is not available right now (removed, overloaded, or not allowed for your key). Pick another model.', actions: [TRY_MODEL, RETRY] },
  upstream_error: { title: 'OpenRouter returned an error', message: 'The AI provider failed while serving the request. Retry, or pick another model.', actions: [TRY_MODEL, RETRY] },
  invalid_output: { title: 'The AI gave an unusable answer', message: 'The model replied, but not in a form that could be used, so no proposals were made. Retrying usually works.', actions: [RETRY, TRY_MODEL] },
  run_failed: { title: 'The run failed', message: 'Something went wrong while running the pipeline. Nothing was proposed or opened.', actions: [RETRY] },
};

/**
 * Explain a blocked/error run. Returns null when the run is fine.
 * @returns {{tone:'blocked'|'error', code:string, title:string, message:string, detail:string, actions:{id:string,label:string,href?:string}[]}|null}
 */
export function runProblem(run) {
  if (!run) return null;
  const stage = run.stage;
  if (stage !== 'blocked' && stage !== 'error') return null;
  const code = run.code && RUN_PROBLEMS[run.code] ? run.code : 'run_failed';
  const base = RUN_PROBLEMS[code];
  const detail = String(run.error || '').trim();
  return {
    tone: stage === 'blocked' ? 'blocked' : 'error',
    code,
    title: base.title,
    message: base.message,
    // the server's own human message is kept verbatim when it adds information
    detail: detail && detail !== base.message ? detail : '',
    actions: base.actions.map((a) => ({ ...a })),
  };
}

/** Why the RUN button is disabled when the server says the AI cannot run (status.ai.ready === false), else null. */
export function aiBlocked(ai) {
  if (!ai || ai.ready !== false) return null;
  if (ai.blockedReason === 'budget_exhausted') {
    return { code: 'budget_exhausted', reason: 'Monthly AI budget used up', message: RUN_PROBLEMS.budget_exhausted.message, actions: RUN_PROBLEMS.budget_exhausted.actions.map((a) => ({ ...a })) };
  }
  if (ai.blockedReason === 'no_api_key' || !ai.blockedReason) {
    return { code: 'no_api_key', reason: 'Add your OpenRouter key to run the AI', message: RUN_PROBLEMS.no_api_key.message, actions: [{ ...SETTINGS_ACCOUNT }] };
  }
  return { code: ai.blockedReason, reason: 'The AI can’t run right now', message: 'The AI is not ready to run.', actions: [] };
}

/** Text for the post-run line: never implies anything opened by itself. */
export function runDoneText(run) {
  const n = Number(run?.proposals) || 0;
  const auto = Number(run?.autoApproved) || 0;
  const picks = Number(run?.picks) || 0;
  let s = n === 0 ? `Done: ${picks} picks scanned, the AI proposed no trades` : `Done: ${picks} picks scanned, ${n} ${n === 1 ? 'proposal is' : 'proposals are'} waiting for your approval`;
  if (auto > 0) s += ` (${auto} more auto-approved within your caps)`;
  return s;
}

/* ---------------------------------------------------------------- approve / reject error mapping */

const money = (n) => fmtMoney(n, 2);

/**
 * Map a failed approve call (ApiError-like: {status, code, message, data:{details}}) to something the owner can act on.
 * `symbol` is optional context. `refresh` = reload proposals/positions after showing it.
 * @returns {{code:string, tone:'warn'|'error'|'info', title:string, message:string, refresh:boolean, actions:{id:string,label:string,href?:string}[]}}
 */
export function approveProblem(err, symbol = '') {
  const status = err?.status;
  const code = err?.code || err?.data?.code || (status === 404 ? 'not_found' : status === 0 || err?.network ? 'network' : 'error');
  const d = err?.details || err?.data?.details || {};
  const sym = symbol ? `${symbol}: ` : '';
  const rerun = { id: 'rerun', label: 'Re-run the AI' };
  switch (code) {
    case 'expired':
      return { code, tone: 'warn', title: 'Proposal expired', message: `${sym}this proposal expired before it was approved, so nothing opened. Re-run the AI for a fresh one.`, refresh: true, actions: [rerun] };
    case 'price_moved': {
      const drift = Number(d.driftPct);
      const lim = Number(d.thresholdPct);
      const old = d.proposalEntry != null ? money(d.proposalEntry) : '?';
      const fresh = d.freshPrice != null ? money(d.freshPrice) : '?';
      const moved = Number.isFinite(drift) ? ` (${drift > 0 ? '+' : ''}${drift.toFixed(2)}%${Number.isFinite(lim) ? `, limit ${lim}%` : ''})` : '';
      return { code, tone: 'warn', title: 'Price moved', message: `${sym}the price moved since the AI proposed it: ${old} then, ${fresh} now${moved}. Nothing opened. Re-run the AI to get a fresh proposal at today’s price.`, refresh: false, actions: [rerun] };
    }
    case 'risk_blocked':
      return { code, tone: 'warn', title: 'Blocked by risk limits', message: `${sym}${d.reason ? String(d.reason) : err?.message || 'a risk limit would be exceeded'}. Nothing opened. Close a position or reject this proposal.`, refresh: true, actions: [] };
    case 'stale_quote':
      return { code, tone: 'warn', title: 'Market data unavailable', message: `${sym}no fresh price${d.symbol && d.symbol !== symbol ? ` for ${d.symbol}` : ''}: the market is probably closed or the data feed is down. Nothing opened. Try again when the market is open.`, refresh: false, actions: [] };
    case 'no_slots':
      return { code, tone: 'warn', title: 'No free position slots', message: `${sym}all position slots are in use. Close a position first, then approve again.`, refresh: false, actions: [{ id: 'jump', label: 'Go to positions', target: 'pos-open' }] };
    case 'worker_not_running':
      return { code, tone: 'warn', title: 'Worker is stopped', message: `${sym}the worker is stopped, so approvals are paused. Press START (in the header menu), then approve again.`, refresh: false, actions: [{ id: 'start', label: 'START worker' }] };
    case 'already_decided':
      return { code, tone: 'info', title: 'Already decided', message: `${sym}this proposal was already ${d.status || 'decided'} (maybe on another device). Refreshing the list.`, refresh: true, actions: [] };
    case 'not_found':
      return { code, tone: 'info', title: 'Proposal not found', message: `${sym}this proposal no longer exists. Refreshing the list.`, refresh: true, actions: [] };
    case 'network':
      return { code, tone: 'error', title: 'Can’t reach the server', message: 'Can’t reach the server. Nothing was changed; check your connection and try again.', refresh: false, actions: [] };
    default:
      return { code, tone: 'error', title: 'Couldn’t complete that', message: `${sym}${err?.message || 'unexpected error'}`, refresh: true, actions: [] };
  }
}

/** Turn the approve-all response into a headline + per-failure lines. */
export function approveAllOutcome(res) {
  const ok = res?.approved || [];
  const bad = res?.failed || [];
  const failures = bad.map((f) => {
    const p = approveProblem({ code: f.code, message: f.error, details: f.details }, f.symbol);
    return { id: f.id, symbol: f.symbol, code: p.code, message: p.message };
  });
  let headline;
  if (!ok.length && !bad.length) headline = 'Nothing to approve';
  else if (!bad.length) headline = `Approved ${ok.length}: ${ok.length === 1 ? 'the position is' : 'the positions are'} now open`;
  else if (!ok.length) headline = `None of the ${bad.length} proposals could be approved`;
  else headline = `Approved ${ok.length}, ${bad.length} could not be approved`;
  return { approvedN: ok.length, failedN: bad.length, headline, failures, tone: bad.length ? (ok.length ? 'warn' : 'error') : 'success' };
}

/** Preview for the approve-all confirm sheet: what will be attempted and what is already known not to open. */
export function approveAllPlan(pending, now = Date.now()) {
  const will = [];
  const wont = [];
  for (const p of pending || []) {
    const left = p.expiresAt ? new Date(p.expiresAt).getTime() - now : Infinity;
    if (left <= 0) wont.push({ symbol: p.symbol, side: p.side, allocationUsd: p.allocationUsd, why: 'expired' });
    else if (p.riskCheck && p.riskCheck.ok === false) wont.push({ symbol: p.symbol, side: p.side, allocationUsd: p.allocationUsd, why: (p.riskCheck.notes || [])[0] || 'fails the risk check' });
    else will.push({ symbol: p.symbol, side: p.side, allocationUsd: p.allocationUsd });
  }
  const totalUsd = will.reduce((a, x) => a + (Number(x.allocationUsd) || 0), 0);
  return { will, wont, totalUsd };
}

/* ---------------------------------------------------------------- countdown */

/** {ms, text, level} for a pending proposal; level: ok | soon (<30 min) | urgent (<5 min) | expired. */
export function timeLeft(expiresAt, now = Date.now()) {
  if (!expiresAt) return { ms: null, text: '—', level: 'ok' };
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return { ms: null, text: '—', level: 'ok' };
  const ms = t - now;
  if (ms <= 0) return { ms, text: 'expired', level: 'expired' };
  return { ms, text: fmtDuration(ms), level: ms < 5 * 60e3 ? 'urgent' : ms < 30 * 60e3 ? 'soon' : 'ok' };
}

/* ---------------------------------------------------------------- proposal card view-model */

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Position of `price` along the stop -> target axis, 0..1 (stop always on the left, for longs and shorts). */
export function axisPos(price, stop, target) {
  const span = target - stop;
  if (!span || !Number.isFinite(span)) return 0.5;
  return Math.min(1, Math.max(0, (price - stop) / span));
}

function riskLines(rc) {
  if (!rc) return { ok: null, lines: [], notes: [] };
  const lines = [];
  if (num(rc.grossExposureAfterPct) != null) lines.push({ k: 'Exposure after', v: `${num(rc.grossExposureAfterPct).toFixed(1)}%${rc.limits?.maxGrossPct ? ` of ${rc.limits.maxGrossPct}% cap` : ''}` });
  if (num(rc.riskPct) != null) lines.push({ k: 'Risk if stopped', v: `${num(rc.riskUsd) != null ? `${fmtMoney(rc.riskUsd, 0)} · ` : ''}${num(rc.riskPct).toFixed(2)}% of equity` });
  if (rc.assetClass && num(rc.classExposureAfterPct) != null) lines.push({ k: `${rc.assetClass} exposure`, v: `${num(rc.classExposureAfterPct).toFixed(1)}%${rc.limits?.maxClassPct ? ` of ${rc.limits.maxClassPct}% cap` : ''}` });
  return { ok: rc.ok !== false, lines, notes: Array.isArray(rc.notes) ? rc.notes.map(String) : [] };
}

/** Everything a pending-proposal card needs, as plain values (strings are NOT escaped). */
export function proposalView(p, now = Date.now()) {
  const entry = num(p.entry);
  const stop = num(p.stopLoss);
  const target = num(p.takeProfit);
  const stopDist = entry != null && stop != null ? Math.abs(entry - stop) : null;
  const targetDist = entry != null && target != null ? Math.abs(target - entry) : null;
  const left = timeLeft(p.expiresAt, now);
  const conf = pctOf(num(p.confidence));
  const demo = p.source === 'demo';
  return {
    id: String(p.id),
    symbol: String(p.symbol || '?'),
    side: p.side === 'short' ? 'short' : 'long',
    allocationUsd: num(p.allocationUsd),
    entry,
    stop,
    target,
    stopPct: stopDist != null && entry ? (stopDist / entry) * 100 : null,
    targetPct: targetDist != null && entry ? (targetDist / entry) * 100 : null,
    rr: stopDist && targetDist != null ? targetDist / stopDist : null,
    entryAt: entry != null && stop != null && target != null ? axisPos(entry, stop, target) : 0.5,
    confidencePct: conf == null ? null : Math.round(conf),
    reason: String(p.reason || ''),
    risk: riskLines(p.riskCheck),
    demo,
    source: demo ? 'DEMO' : 'AI',
    model: p.models?.trader || '',
    left,
    expiresAt: p.expiresAt || '',
    expired: left.level === 'expired',
    status: p.status || 'pending',
    createdAt: p.createdAt || '',
  };
}

/* ---------------------------------------------------------------- history / shadow what-if */

const signedMoney = (n) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${fmtMoney(Math.abs(n), 2)}`;

/**
 * What-if result of a decided proposal. Wording: a trade the owner did NOT take that would have lost = green "Avoided loss";
 * one that would have won = red "Missed gain". Approved trades just show the hypothetical result at the horizon.
 * @returns {{tone:'good'|'bad'|'neutral'|'pending'|'none', icon:string, label:string, amount:number|null, amountText:string, detail:string}}
 */
export function shadowView(p) {
  const taken = p.status === 'approved';
  const sh = p.shadow;
  if (p.status === 'pending') return { tone: 'none', icon: '', label: '', amount: null, amountText: '', detail: '' };
  if (!sh) return { tone: 'pending', icon: '…', label: 'Not scored yet', amount: null, amountText: '', detail: `Scored once the ${p.horizonHours || 24}h horizon has passed.` };
  if (sh.unscorable) return { tone: 'neutral', icon: '–', label: 'Can’t be scored', amount: null, amountText: '', detail: 'No price data was available for that window.' };
  const pnl = num(sh.hypotheticalPnl);
  if (pnl == null) return { tone: 'neutral', icon: '–', label: 'Can’t be scored', amount: null, amountText: '', detail: '' };
  const spy = num(sh.spyPnl);
  const tail = [sh.partial ? 'partial window' : '', sh.exitReason ? `exit: ${String(sh.exitReason).replace(/-/g, ' ')}` : '', spy != null ? `SPY buy-and-hold: ${signedMoney(spy)}` : ''].filter(Boolean).join(' · ');
  if (taken) return { tone: pnl > 0 ? 'good' : pnl < 0 ? 'bad' : 'neutral', icon: pnl > 0 ? '▲' : pnl < 0 ? '▼' : '=', label: 'Result at horizon', amount: pnl, amountText: signedMoney(pnl), detail: tail };
  if (pnl < 0) return { tone: 'good', icon: '✓', label: 'Avoided loss', amount: Math.abs(pnl), amountText: fmtMoney(Math.abs(pnl), 2), detail: tail };
  if (pnl > 0) return { tone: 'bad', icon: '✗', label: 'Missed gain', amount: pnl, amountText: fmtMoney(pnl, 2), detail: tail };
  return { tone: 'neutral', icon: '=', label: 'Would have broken even', amount: 0, amountText: fmtMoney(0, 2), detail: tail };
}

const DECIDER = { user: 'you', auto: 'auto-approve', system: 'the system' };

/** One-line outcome for the History list. */
export function outcomeText(p) {
  const by = DECIDER[p.decidedBy] || '';
  switch (p.status) {
    case 'approved':
      return `Approved${by ? ` by ${by}` : ''}${p.positionId ? ': position opened' : ''}`;
    case 'rejected':
      return `Rejected${by ? ` by ${by}` : ''}${p.rejectReason ? `: ${p.rejectReason}` : ''}`;
    case 'expired':
      return 'Expired: not approved in time';
    case 'superseded':
      return 'Superseded by a newer run';
    default:
      return String(p.status || '');
  }
}

/* ---------------------------------------------------------------- budget */

/** ok / warn (>=70%) / blocked (>=100%) from a 0..100 percentage. */
export function budgetLevel(pct) {
  const v = Number(pct);
  if (!Number.isFinite(v)) return 'ok';
  if (v >= 100) return 'blocked';
  if (v >= BUDGET_WARN_PCT) return 'warn';
  return 'ok';
}

const LEVEL_LABEL = { ok: 'On track', warn: 'Getting high', blocked: 'Cap reached' };
const usd = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : fmtMoney(n, n !== 0 && Math.abs(n) < 0.1 ? 4 : d));

export function fmtResets(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * View-model for the budget widgets. Accepts /api/budget, or the compact `status.budget` (no byBot/last7d).
 * `level` is derived from pct when the server did not send one, so the meter never shows a wrong colour.
 */
export function budgetView(b) {
  if (!b) return null;
  const cap = num(b.capUsd) ?? DEFAULT_CAP_USD;
  const spent = num(b.spentUsd) ?? 0;
  const pct = num(b.pct) ?? (cap > 0 ? (spent / cap) * 100 : spent > 0 ? 100 : 0);
  const level = b.level === 'ok' || b.level === 'warn' || b.level === 'blocked' ? b.level : budgetLevel(pct);
  const projected = num(b.projectedMonthEndUsd);
  const bots = ['scanner', 'trader', 'news', 'other']
    .filter((k) => b.byBot?.[k])
    .map((k) => ({ id: k, label: k[0].toUpperCase() + k.slice(1), usd: num(b.byBot[k].usd) ?? 0, calls: num(b.byBot[k].calls) ?? 0 }));
  const days = Array.isArray(b.last7d) ? b.last7d : [];
  const maxDay = Math.max(0, ...days.map((d) => num(d.usd) ?? 0));
  const bars = days.map((d) => {
    const v = num(d.usd) ?? 0;
    return { day: d.day, usd: v, h: maxDay > 0 ? Math.max(v > 0 ? 6 : 2, Math.round((v / maxDay) * 100)) : 2, label: new Date(`${d.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }) };
  });
  const remaining = num(b.remainingUsd) ?? Math.max(0, cap - spent);
  return {
    capUsd: cap,
    spentUsd: spent,
    remainingUsd: remaining,
    pct: Math.max(0, Math.min(100, pct)),
    pctRaw: pct,
    level,
    levelLabel: LEVEL_LABEL[level],
    spentText: usd(spent),
    capText: usd(cap, 0),
    remainingText: usd(remaining),
    projectedText: projected == null ? '—' : usd(projected),
    projectedOver: projected != null && cap > 0 && projected > cap,
    avgRunText: b.avgCostPerRun == null ? '—' : usd(b.avgCostPerRun),
    resetsText: fmtResets(b.resetsAt),
    bots,
    bars,
    ariaText: `AI budget: ${usd(spent)} spent of ${usd(cap, 0)} this month, ${Math.round(Math.max(0, pct))} percent, ${LEVEL_LABEL[level].toLowerCase()}`,
  };
}

/** Validate the monthly cap input. Raising above the default needs an explicit confirm. */
export function validateBudgetInput(raw) {
  const s = String(raw ?? '').trim().replace(/^\$/, '');
  if (!s) return { ok: false, error: 'Enter a dollar amount.' };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: 'Use a plain amount like 20 or 12.50.' };
  const v = Number(s);
  if (v > 1000) return { ok: false, error: 'The maximum cap is $1,000.' };
  return { ok: true, value: v, needsConfirm: v > DEFAULT_CAP_USD, error: '' };
}

/** Generic bounded number field. */
export function validateRange(raw, { min, max, label, integer = false }) {
  const s = String(raw ?? '').trim();
  if (!s || !Number.isFinite(Number(s))) return { ok: false, error: `${label}: enter a number.` };
  const v = Number(s);
  if (integer && !Number.isInteger(v)) return { ok: false, error: `${label}: use a whole number.` };
  if (v < min || v > max) return { ok: false, error: `${label} must be between ${min} and ${max}.` };
  return { ok: true, value: v, error: '' };
}

/** Plain-language formula line for the Settings explainer. */
export function netEdgeFormula(w = {}) {
  const dd = Number.isFinite(Number(w.drawdown)) ? Number(w.drawdown) : 0.5;
  const av = Number.isFinite(Number(w.avoided)) ? Number(w.avoided) : 1;
  return `Net edge = realized P&L − ${dd} × max drawdown + ${av} × avoided loss`;
}

/* ---------------------------------------------------------------- performance baselines */

export const MIN_BASELINE_N = 5;

/**
 * Plain-language verdicts for AI vs SPY hold vs random picks. `beats.*` null (or n below the minimum) => not enough data.
 * @returns {{id:string,label:string,tone:'good'|'bad'|'neutral',text:string}[]}
 */
export function baselineVerdicts(base) {
  if (!base) return [];
  const aiN = Number(base.ai?.n) || 0;
  const one = (id, label, b) => {
    const n = Number(b?.n) || 0;
    const beats = base.beats?.[id];
    if (beats == null || aiN < MIN_BASELINE_N || n < MIN_BASELINE_N) {
      return { id, label, tone: 'neutral', text: `Not enough data yet (AI ${aiN}, ${label.toLowerCase()} ${n}; need ${MIN_BASELINE_N}+ each)` };
    }
    return beats ? { id, label, tone: 'good', text: `AI is ahead of ${label.toLowerCase()}` } : { id, label, tone: 'bad', text: `AI is behind ${label.toLowerCase()}` };
  };
  return [one('spyHold', 'SPY hold', base.spyHold), one('randomPicks', 'Random picks', base.randomPicks)];
}
