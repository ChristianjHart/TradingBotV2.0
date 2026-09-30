import { api, apiOptional, escapeHtml as esc, fmtDuration } from './api.js';
import { refresh } from './data.js';
import { hooks, $, nowMs, setHtml, setText, state } from './state.js';
import { STEPS, stepperState } from './run-logic.js';
import { aiBlocked, runDoneText, runProblem } from './ai-logic.js';
import { toast } from './ui.js';
import { newsRunStatus } from './news-logic.js';
import { triggerBadge } from './schedule-logic.js';

export { STEPS };

/* ---------- run pipeline ---------- */

export let runTracking = false;

export function isRunning() {
  return !!state.run?.running;
}

const actionHtml = (a) => (a.href ? `<a class="btn-accent rp-btn" href="${esc(a.href)}">${esc(a.label)}</a>` : `<button type="button" class="btn-accent rp-btn" data-act="${esc(a.id)}">${esc(a.label)}</button>`);

function problemHtml(pr) {
  return `<div class="run-problem run-problem-${pr.tone}" role="alert">
    <div class="rp-h"><span class="rp-ic" aria-hidden="true">${pr.tone === 'blocked' ? '⏸' : '!'}</span><strong>${esc(pr.title)}</strong><button type="button" class="pc-msg-x" data-act="dismiss-run" aria-label="Dismiss this message"><span aria-hidden="true">×</span></button></div>
    <p>${esc(pr.message)}</p>
    ${pr.detail ? `<p class="rp-detail dim">Details: ${esc(pr.detail.slice(0, 280))}</p>` : ''}
    <p class="rp-safe">Nothing was changed: your proposals and positions are untouched.</p>
    <div class="rp-actions">${pr.actions.map((a) => actionHtml(a)).join('')}</div></div>`;
}

export function runProblemNow() {
  const r = state.run;
  const pr = runProblem(r);
  if (!pr) return null;
  return state.runDismissed === `${r.runId}:${r.stage}` ? null : pr;
}

export function runBarHtml() {
  const r = state.run;
  const v = stepperState(r, nowMs(), state.runLastStage);
  const pr = runProblemNow();
  if (!v.visible && !pr) return '';
  const steps = v.steps.map((s, i) => {
    const st = s.state;
    const icon = { done: '✓', warn: '!', error: '!', active: '', pending: String(i + 1) }[st];
    const sr = { done: 'complete', warn: `finished with a problem: ${esc(state.run?.news?.status || 'skipped')}`, error: 'failed', active: 'in progress', pending: 'pending' }[st];
    return `<li class="step step-${st}" ${st === 'active' ? 'aria-current="step"' : ''}>
      <span class="step-dot" aria-hidden="true">${st === 'active' ? '<span class="spin"></span>' : icon}</span>
      <span class="step-txt"><strong>${s.label}</strong><small>${st === 'active' ? esc(s.hint) : ''}<span class="sr-only"> ${sr}</span></small></span></li>`;
  }).join('');
  if (v.kind === 'blocked' || (!v.visible && pr)) return pr ? problemHtml(pr) : '';
  const pend = state.status?.proposalsPending ?? null;
  const n = pend === 0 ? 0 : Number(r.proposals) || 0;
  const tail =
    v.kind === 'error'
      ? '<span class="neg">Run failed. Nothing was proposed.</span>'
      : v.kind === 'done'
        ? `<span class="pos">${esc(runDoneText(r, pend))}</span>${n ? ` <a class="linklike" href="#dashboard" data-jump="sec-proposals">Review ${n === 1 ? 'it' : 'them'}</a>` : ''}`
        : state.runLocal === false
          ? '<span class="run-elsewhere">A run is already in progress (started elsewhere or before this page loaded). RUN is disabled until it finishes.</span>'
          : '<span class="dim">Running…</span>';
  return `<div class="run-bar run-${v.kind}" role="group" aria-label="Run progress"><ol class="stepper">${steps}</ol>
    <div class="run-meta">${triggerHtml(r)}${tail} <span class="mono dim" id="run-elapsed"></span></div>${newsLineHtml(r)}</div>${pr ? problemHtml(pr) : ''}`;
}

/** One obvious line about the news step (shown once the run is past it). Text comes from the server: escaped. */
export function newsLineHtml(run) {
  if (!run || !['trading', 'done'].includes(run.stage)) return '';
  const ns = newsRunStatus(run.news);
  if (!ns) return '';
  return `<div class="news-line news-${ns.tone}" role="status"><strong><span aria-hidden="true">${{ ok: '✓', warn: '!', bad: '✕' }[ns.tone] || ''}</span> ${esc(ns.title)}</strong> <span>${esc(ns.text)}</span>${ns.demo ? ' <span class="badge-demo">DEMO DATA</span>' : ''}${ns.link ? ` <a class="prop-link" href="${esc(ns.link.href)}">${esc(ns.link.label)}</a>` : ''}</div>`;
}

function triggerHtml(run) {
  const t = run?.trigger;
  if (!t || t.type === 'manual') return '';
  const b = triggerBadge(t);
  return `<span class="chip chip-${b.tone}" title="${esc(b.detail)}">${esc(b.label)} run</span> `;
}

export function gateHtml() {
  const g = aiBlocked(state.status?.ai);
  if (!g || isRunning()) return '';
  return `<div class="run-gate" id="run-gate-box"><strong>${esc(g.reason)}</strong><p>${esc(g.message)}</p><div class="rp-actions">${g.actions.map((a) => actionHtml(a)).join('')}</div></div>`;
}

export function patchRunBar() {
  setHtml($('run-bar'), runBarHtml());
  setHtml($('run-gate'), gateHtml());
  tickRun();
  const b = $('btn-scan');
  if (b) {
    const gate = aiBlocked(state.status?.ai);
    b.disabled = isRunning() || !!gate;
    b.setAttribute('aria-busy', isRunning() ? 'true' : 'false');
    if (gate) b.setAttribute('aria-describedby', 'run-gate');
    else b.removeAttribute('aria-describedby');
    setText(b, isRunning() ? (state.runLocal === false ? 'RUN IN PROGRESS…' : 'RUNNING…') : 'RUN');
    if (isRunning()) b.title = 'A run is already in progress. It can’t be cancelled, please wait for it to finish.';
    else if (gate) b.title = gate.reason;
    else b.removeAttribute('title');
  }
}
export function tickRun() {
  const r = state.run;
  const el = $('run-elapsed');
  if (!el || !r?.startedAt) return;
  const end = r.running ? nowMs() : new Date(r.finishedAt || nowMs()).getTime();
  setText(el, `elapsed ${fmtDuration(end - new Date(r.startedAt).getTime())}`);
}

export async function startRun() {
  try {
    const res = await api('/run', { method: 'POST', body: '{}' });
    state.runLocal = res.started !== false;
    if (!state.runLocal) toast('A run is already in progress — following it.', 'info');
    state.run = { ...(state.run || {}), ...res, running: true, stage: res.stage || 'fetching', startedAt: res.startedAt || new Date().toISOString() };
    patchRunBar();
    trackRun();
  } catch (e) {
    if (e.code === 'worker_not_running' || (e.status === 409 && !e.code)) toast('The worker is stopped, so the AI can’t run. Press START in the header menu, then RUN again.', 'error', 9000);
    else if (e.code && runProblem({ stage: 'blocked', code: e.code, error: e.message }) && e.code !== 'run_failed') {
      state.run = { ...(state.run || {}), running: false, stage: 'blocked', code: e.code, error: e.message, runId: `local-${Date.now()}` };
      patchRunBar();
    } else toast(`Could not start run: ${e.message}`, 'error');
  }
}

export async function trackRun() {
  if (runTracking) return;
  runTracking = true;
  let lastStage = null;
  try {
    for (;;) {
      if (state.locked) break;
      const st = await api('/run/status');
      if (st.running) state.runLastStage = st.stage;
      state.run = { ...st };
      patchRunBar();
      if (st.stage !== lastStage && lastStage !== null && (st.stage === 'trading' || !st.running)) {
        await refresh().catch(() => {});
        hooks.patchCurrent();
      }
      lastStage = st.stage;
      if (!st.running) {
        await refresh().catch(() => {});
        hooks.patchCurrent();
        const pr = runProblem(st);
        if (pr) toast(`${pr.title}. ${pr.message}`, 'error', 9000);
        else if (st.stage === 'done') toast(runDoneText(st), 'success', 7000, st.proposals ? { label: 'Review', href: '#dashboard', jump: 'sec-proposals' } : null);
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) {
    toast(`Lost track of the run: ${e.message}`, 'error');
  } finally {
    runTracking = false;
    if (!state.run?.running) state.runLocal = null;
    patchRunBar();
  }
}

/** On page load: if the server is mid-run (started by another tab/device or before a reload), resume the stepper + timer. */
export async function hydrateRun() {
  const st = await apiOptional('/run/status');
  if (!st) return;
  state.run = { ...(state.run || {}), ...st };
  if (st.running) {
    state.runLocal = false;
    state.runLastStage = st.stage;
    patchRunBar();
    trackRun();
  } else {
    patchRunBar();
  }
}

/** Delegated clicks inside the run bar / gate: retry and dismiss. (Links and data-jump anchors navigate on their own.) */
export function onRunClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'retry') startRun();
  else if (b.dataset.act === 'dismiss-run') {
    const r = state.run;
    state.runDismissed = `${r?.runId}:${r?.stage}`;
    patchRunBar();
    $('btn-scan')?.focus({ preventScroll: true });
  }
}
