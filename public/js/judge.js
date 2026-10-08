import { api, escapeHtml as esc } from './api.js';
import { refresh } from './data.js';
import { checkAllPlan, judgeProblem, judgeView } from './judge-logic.js';
import { hooks, state } from './state.js';
import { confirmDialog, toast } from './ui.js';

/* AI checker: a row on each pending proposal card, and a "Check all" button. Advice only: it never approves or rejects. */

const runsSetting = () => state.status?.settings?.judgeRuns ?? 3;
const judgeOf = (p) => p.judge || state.judgeLocal[p.id] || null;
const working = (p) => Boolean(state.judgeUi[p.id]?.busy || p.judging || (state.judgeBatch[p.id] && !judgeOf(p)));

/** Everything that should repaint a card when it changes (used in the keyed reconcile signature). */
export function judgeSig(p) {
  return JSON.stringify([judgeOf(p)?.at || null, working(p), state.judgeUi[p.id]?.error || null, runsSetting()]);
}

export const uncheckedPending = () => (state.proposals?.proposals || []).filter((p) => p.status === 'pending' && !judgeOf(p));

const spin = '<span class="spin" aria-hidden="true"></span>';

export function judgeRowHtml(p) {
  const j = judgeView(judgeOf(p));
  const ui = state.judgeUi[p.id] || {};
  if (working(p)) return `<div class="pc-judge pc-judge-busy" role="status">${spin} The AI checker is working (${runsSetting()} runs)…</div>`;
  if (!j) {
    return `<div class="pc-judge"><button type="button" class="btn-ghost pcj-btn" data-act="judge">🧐 Ask the AI checker</button><small class="dim">Asks ${runsSetting()} times for a second opinion. Uses AI budget.</small>${ui.error ? `<p class="pcj-err" role="alert">${esc(ui.error)}</p>` : ''}</div>`;
  }
  const runs = j.runs.map((r) => `<li><span class="pcj-call pcj-${r.tone}">${esc(r.label)}</span> <strong>${esc(r.pText)}</strong> <span class="dim">${esc(r.reason)}${r.keyRisk ? ` Risk: ${esc(r.keyRisk)}` : ''}</span></li>`).join('');
  const notes = [j.incoherentText, j.failedText, j.stableText].filter(Boolean);
  return `<div class="pc-judge pc-judge-${j.tone}">
    <div class="pcj-head"><span class="lbl">AI CHECKER</span><span class="pcj-call pcj-${j.tone}">${esc(j.label)}</span><span><strong class="mono">${esc(j.pText)}</strong> chance of profit${j.rangeText ? ` <span class="dim">(${esc(j.rangeText)})</span>` : ''}</span>${j.demo ? '<span class="badge-demo">DEMO DATA</span>' : ''}</div>
    <div class="pcj-meta dim">${esc([j.agreeText, j.steady ? 'steady numbers' : '', j.needText].filter(Boolean).join(' · '))}</div>
    ${notes.length ? `<ul class="pcj-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <details class="pcj-det"><summary>Each run</summary><ul class="pcj-runs">${runs}</ul><p class="dim pcj-note">A second AI’s guess. It can be wrong. Loss review shows its record.</p><div class="pcj-foot dim">${esc([j.model, j.costText].filter(Boolean).join(' · '))} <button type="button" class="linklike" data-act="judge-redo">Ask again (new AI calls)</button></div></details>
    ${ui.error ? `<p class="pcj-err" role="alert">${esc(ui.error)}</p>` : ''}</div>`;
}

/** Check one pending proposal. `rerender()` repaints the cards. */
export async function askChecker(p, force, rerender) {
  if (state.judgeUi[p.id]?.busy) return;
  state.judgeUi[p.id] = { busy: true };
  rerender();
  try {
    const res = await api(`/proposals/${encodeURIComponent(p.id)}/judge${force ? '?force=1' : ''}`, { method: 'POST', body: '{}' });
    state.judgeLocal[p.id] = res.judge;
    delete state.judgeUi[p.id];
    if (!res.cached) toast(`Checked ${p.symbol}: ${res.judge.stats.call.toUpperCase()}, ${Math.round(res.judge.stats.meanP * 100)}% chance of profit.`, 'success', 5000);
  } catch (e) {
    state.judgeUi[p.id] = { error: judgeProblem(e) };
  }
  rerender();
}

/** "Check all (N)" for the proposals toolbar. */
export function checkAllLabel() {
  const n = uncheckedPending().length;
  return { show: n > 0, text: `Check all (${n})` };
}

let pollTimer = null;
export async function checkAll() {
  const plan = checkAllPlan(state.proposals?.proposals || [], runsSetting());
  plan.ids = uncheckedPending().map((p) => p.id);
  if (!plan.ids.length) return;
  const ok = await confirmDialog({
    title: `Ask the AI checker about ${plan.ids.length} ${plan.ids.length === 1 ? 'proposal' : 'proposals'}?`,
    message: `This makes about ${plan.ids.length * runsSetting()} AI calls (${runsSetting()} per proposal) and uses AI budget. The checker only gives advice. You still decide each trade.`,
    confirmText: 'Check them',
  });
  if (!ok) return;
  try {
    const r = await api('/proposals/judge-all', { method: 'POST', body: '{}' });
    for (const id of r.ids) state.judgeBatch[id] = true;
    toast(`Checking ${r.started} ${r.started === 1 ? 'proposal' : 'proposals'}. Results appear on the cards.`, 'info', 5000);
  } catch (e) {
    toast(judgeProblem(e), 'error', 8000);
    return;
  }
  clearInterval(pollTimer);
  const t0 = Date.now();
  const tick = async () => {
    await refresh().catch(() => {});
    const left = (state.proposals?.proposals || []).filter((p) => state.judgeBatch[p.id] && !p.judge && p.status === 'pending');
    hooks.patchCurrent();
    if (!left.length || Date.now() - t0 > 180_000) {
      clearInterval(pollTimer);
      for (const id of Object.keys(state.judgeBatch)) delete state.judgeBatch[id];
      hooks.patchCurrent();
    }
  };
  pollTimer = setInterval(tick, 3000);
}

export function resetJudge() {
  clearInterval(pollTimer);
}
