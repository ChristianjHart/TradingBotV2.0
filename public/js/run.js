import { api, apiOptional, escapeHtml as esc, fmtDuration } from './api.js';
import { refresh } from './data.js';
import { hooks, $, nowMs, setHtml, setText, state } from './state.js';
import { STEPS, stepperState } from './run-logic.js';
import { toast } from './ui.js';

export { STEPS };

/* ---------- run pipeline ---------- */

export let runTracking = false;

export function isRunning() {
  return !!state.run?.running;
}

export function runBarHtml() {
  const r = state.run;
  const v = stepperState(r, nowMs(), state.runLastStage);
  if (!v.visible) return '';
  const steps = v.steps.map((s, i) => {
    const st = s.state;
    const icon = { done: '✓', error: '!', active: '', pending: String(i + 1) }[st];
    const sr = { done: 'complete', error: 'failed', active: 'in progress', pending: 'pending' }[st];
    return `<li class="step step-${st}" ${st === 'active' ? 'aria-current="step"' : ''}>
      <span class="step-dot" aria-hidden="true">${st === 'active' ? '<span class="spin"></span>' : icon}</span>
      <span class="step-txt"><strong>${s.label}</strong><small>${st === 'active' ? esc(s.hint) : ''}<span class="sr-only"> ${sr}</span></small></span></li>`;
  }).join('');
  const tail =
    v.kind === 'error'
      ? `<span class="neg">Run failed: ${esc(r.error || 'unknown error')}</span>`
      : v.kind === 'done'
        ? `<span class="pos">Done — ${r.picks ?? 0} picks, ${r.opened ?? 0} position(s) opened</span>`
        : state.runLocal === false
          ? '<span class="run-elsewhere">A run is already in progress (started elsewhere or before this page loaded) — RUN is disabled until it finishes.</span>'
          : '<span class="dim">Running…</span>';
  return `<div class="run-bar" role="group" aria-label="Run progress"><ol class="stepper">${steps}</ol>
    <div class="run-meta">${tail} <span class="mono dim" id="run-elapsed"></span></div></div>`;
}

export function patchRunBar() {
  setHtml($('run-bar'), runBarHtml());
  tickRun();
  const b = $('btn-scan');
  if (b) {
    b.disabled = isRunning();
    b.setAttribute('aria-busy', isRunning() ? 'true' : 'false');
    setText(b, isRunning() ? (state.runLocal === false ? 'RUN IN PROGRESS…' : 'RUNNING…') : 'RUN');
    if (isRunning()) b.title = 'A run is already in progress — it can’t be cancelled, please wait for it to finish.';
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
    const res = await api('/run', { method: 'POST' });
    state.runLocal = res.started !== false;
    if (!state.runLocal) toast('A run is already in progress — following it.', 'info');
    state.run = { ...(state.run || {}), ...res, running: true, stage: res.stage || 'fetching', startedAt: res.startedAt || new Date().toISOString() };
    patchRunBar();
    trackRun();
  } catch (e) {
    if (e.status === 409) toast('Worker is stopped — press START', 'error');
    else toast(`Could not start run: ${e.message}`, 'error');
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
        if (st.error || st.stage === 'error') toast(`Run failed: ${st.error || 'unknown error'}`, 'error');
        else if (st.stage === 'done') toast(`Run complete — ${st.picks ?? 0} picks, ${st.opened ?? 0} position(s) opened`, 'success');
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
