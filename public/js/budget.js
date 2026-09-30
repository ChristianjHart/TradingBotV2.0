import { api, escapeHtml as esc } from './api.js';
import { budgetView, DEFAULT_CAP_USD, validateBudgetInput } from './ai-logic.js';
import { refresh } from './data.js';
import { $, hooks, setHtml, setText, skeleton, state } from './state.js';
import { confirmDialog, toast } from './ui.js';

const ICON = { ok: '✓', warn: '!', blocked: '✕' };

/** Best available budget: the full /api/budget, else the compact copy on /api/status. */
export const currentBudget = () => state.budget || state.status?.budget || null;

/* ---------- header chip ---------- */

export function patchBudgetChip() {
  const chip = $('budget-chip');
  if (!chip) return;
  const v = budgetView(currentBudget());
  if (!v || state.locked) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  chip.dataset.level = v.level;
  const txt = `AI ${v.spentText} / ${v.capText}`;
  setText($('budget-chip-t'), v.level === 'ok' ? txt : `${txt} · ${v.levelLabel.toLowerCase()}`);
  setText($('budget-chip-i'), ICON[v.level]);
  chip.setAttribute('aria-label', `${v.ariaText}. Open budget settings`);
  chip.title = `Resets ${v.resetsText || 'next month'}`;
}

/* ---------- the meter (shared by the dashboard widget and the Settings card) ---------- */

export function meterHtml(v, { id = 'bm' } = {}) {
  return `<div class="bm" data-level="${v.level}">
    <div class="bm-head"><strong class="big-num mono">${esc(v.spentText)}</strong><span class="dim">of ${esc(v.capText)} this month</span>
      <span class="lvl-tag lvl-${v.level}"><span aria-hidden="true">${ICON[v.level]}</span> ${esc(v.levelLabel)}</span></div>
    <div class="bm-bar" id="${id}-bar" role="meter" aria-label="AI budget used this month" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(v.pct)}" aria-valuetext="${esc(v.ariaText)}"><span class="bm-fill" style="width:${v.pct}%"></span><i class="bm-tick" aria-hidden="true" title="70% warning level"></i></div>
    <dl class="bm-stats">
      <div><dt>Left</dt><dd class="mono">${esc(v.remainingText)}</dd></div>
      <div><dt>Projected by month end</dt><dd class="mono ${v.projectedOver ? 'neg' : ''}">${esc(v.projectedText)}${v.projectedOver ? ' <span class="sr-only">over the cap</span><span aria-hidden="true">!</span>' : ''}</dd></div>
      <div><dt>Avg per run</dt><dd class="mono">${esc(v.avgRunText)}</dd></div>
      <div><dt>Resets</dt><dd>${esc(v.resetsText || '—')}</dd></div>
    </dl>
    ${v.level === 'blocked' ? '<p class="bm-note">The cap is reached, so AI runs are paused until the budget resets. <a class="prop-link" href="#settings/budget">Raise the cap</a></p>' : v.level === 'warn' ? '<p class="bm-note">You have used most of this month’s budget. Runs stop at the cap.</p>' : ''}
    ${v.bots.length ? `<ul class="bm-bots" aria-label="Spend by bot">${v.bots.filter((b) => b.id !== 'other' || b.calls).map((b) => `<li><span>${esc(b.label)}</span><span class="mono">${esc(b.usd < 0.1 && b.usd > 0 ? `$${b.usd.toFixed(4)}` : `$${b.usd.toFixed(2)}`)} <span class="dim">· ${b.calls} ${b.calls === 1 ? 'call' : 'calls'}</span></span></li>`).join('')}</ul>` : ''}
    ${v.bars.length ? `<div class="bm-days" role="img" aria-label="Spend over the last 7 days: ${esc(v.bars.map((d) => `${d.label} $${d.usd.toFixed(2)}`).join(', '))}">${v.bars.map((d) => `<span class="bm-day"><i style="height:${d.h}%"></i><small aria-hidden="true">${esc(d.label.slice(0, 1))}</small></span>`).join('')}</div><div class="dim bm-days-l">Last 7 days</div>` : ''}
  </div>`;
}

export function budgetWidgetHtml() {
  if (!state.loaded) return skeleton(3);
  const v = budgetView(currentBudget());
  if (!v) return '<div class="empty">Budget data isn’t available from the server.</div>';
  return `${meterHtml(v)}<a class="prop-link bm-link" href="#settings/budget">Budget settings</a>`;
}

export function patchBudgetWidget() {
  setHtml($('w-budget'), budgetWidgetHtml());
  patchBudgetChip();
}

/* ---------- Settings → budget card ---------- */

export function budgetCardHtml() {
  const v = budgetView(currentBudget());
  const cap = v?.capUsd ?? state.status?.settings?.monthlyAiBudgetUsd ?? DEFAULT_CAP_USD;
  return `<section class="widget budget-card" id="sec-budget" aria-labelledby="h-budget"><h2 class="widget-title" id="h-budget">AI BUDGET</h2>
    <div id="budget-meter">${v ? meterHtml(v, { id: 'bs' }) : skeleton(3)}</div>
    <form class="settings-form" id="f-budget" novalidate>
      <label for="b-cap">Monthly AI budget (USD)<input id="b-cap" name="cap" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off" value="${esc(cap)}" aria-describedby="b-cap-h b-cap-e" /><span class="fld-hint" id="b-cap-h">Runs are blocked once this month’s AI spend reaches the cap. Default $${DEFAULT_CAP_USD}. Max $1,000.</span><span class="fld-err" id="b-cap-e" role="alert"></span></label>
      <div class="row-actions"><button class="btn-accent" type="submit">Save budget</button></div>
    </form></section>`;
}

export function wireBudgetCard(host) {
  const f = host.querySelector('#f-budget');
  if (!f) return;
  const err = host.querySelector('#b-cap-e');
  const input = host.querySelector('#b-cap');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = validateBudgetInput(input.value);
    err.textContent = r.error;
    input.toggleAttribute('aria-invalid', !r.ok);
    if (!r.ok) return input.focus();
    if (r.needsConfirm) {
      const ok = await confirmDialog({ title: `Raise the cap to $${r.value}?`, message: `The AI could then spend up to $${r.value} this month on your OpenRouter account, more than the $${DEFAULT_CAP_USD} default. Runs only stop once that higher cap is reached.`, confirmText: `Raise to $${r.value}` });
      if (!ok) return;
    }
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin" aria-hidden="true"></span> Saving…';
    try {
      await api('/settings', { method: 'PATCH', body: JSON.stringify({ monthlyAiBudgetUsd: r.value }) });
      toast(`Monthly AI budget set to $${r.value}`, 'success');
      await refresh();
      hooks.patchCurrent();
      setHtml($('budget-meter'), meterHtml(budgetView(currentBudget()), { id: 'bs' }));
    } catch (er) {
      err.textContent = er.message || 'Could not save the budget';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save budget';
    }
  });
}

/** Keep the Settings meter current on polls. */
export function patchBudgetCard() {
  const el = $('budget-meter');
  const v = budgetView(currentBudget());
  if (el && v) setHtml(el, meterHtml(v, { id: 'bs' }));
}
