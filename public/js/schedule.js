import { api, apiOptional, escapeHtml as esc, fmtDateTime } from './api.js';
import { refresh } from './data.js';
import { trackRun } from './run.js';
import { PLAN_IDS, PLAN_INFO, experimentRow, forecastLine, forecastRows, lastRunView, nextRunView, scheduleSummary, slotView, testFireMessage, usdText, validateCryptoRuns, validateCustomSlots, validateEventTriggers } from './schedule-logic.js';
import { $, empty, hooks, setHtml, skeleton, state } from './state.js';
import { confirmDialog, toast } from './ui.js';

const chip = (tone, text, extra = '') => `<span class="chip chip-${tone}"${extra}>${esc(text)}</span>`;
const savePatch = (schedule) => api('/settings', { method: 'PATCH', body: JSON.stringify({ schedule }) });

/* ---------- dashboard summary ---------- */

export const scheduleSectionSummary = () => scheduleSummary(state.schedule);

function slotPill(v) {
  return `<li class="slot slot-${v.tone}"><span class="slot-t mono">${esc(v.time)} ET</span><span class="slot-s">${esc(v.scopeText)}</span><span class="chip chip-${v.tone}">${esc(v.label)}</span>${v.reasonText ? `<small class="slot-r">${esc(v.reasonText)}</small>` : ''}</li>`;
}

export function scheduleWidgetHtml() {
  if (!state.loaded) return skeleton(2);
  const s = state.schedule;
  if (!s) return empty('The schedule is not available from the server.');
  if (!s.enabled) {
    return `<p class="sched-off"><strong>Scheduled runs are off.</strong> The AI only runs when you press RUN. Turn the schedule on to have it look at the market at set times (it still only proposes; you approve).</p><a class="btn-ghost sched-link" href="#settings/schedule">Set up a schedule</a>`;
  }
  const nx = nextRunView(s.nextRunAt);
  const slots = (s.slotsToday || []).map(slotView);
  const last = s.lastRuns?.[0] ? lastRunView(s.lastRuns[0]) : null;
  const fl = forecastLine(state.status?.budget?.forecast);
  return `<div class="sched-next"><span class="lbl">NEXT RUN</span><strong>${nx.et ? esc(nx.et) : 'none pending'}</strong>${nx.local ? `<span class="dim">${esc(nx.local)}</span>` : ''}</div>
    <div class="sched-plan dim">${s.plan === 'custom' ? 'Custom times' : esc(PLAN_INFO[s.plan]?.label || `Plan ${s.plan}`)}${PLAN_INFO[s.plan] && s.plan !== 'custom' ? ` · ${esc(PLAN_INFO[s.plan].when)}` : ''}${s.eventTriggers?.enabled ? ` · events ${s.eventTriggers.active ? 'active' : 'on'}` : ''}</div>
    ${slots.length ? `<ul class="slots" aria-label="Today’s run times">${slots.map(slotPill).join('')}</ul>` : '<p class="dim">No scheduled runs today.</p>'}
    ${last ? `<p class="sched-last dim">Last run: ${esc(fmtDateTime(last.at))} · ${chip(last.trigger.tone, last.trigger.label)} ${esc(last.statusLabel)}${last.costText !== '—' ? ` · ${esc(last.costText)}` : ''}</p>` : ''}
    ${fl ? `<p class="sched-fc dim">${esc(fl)}</p>` : ''}
    <a class="btn-ghost sched-link" href="#settings/schedule">Manage schedule</a>`;
}

export function patchScheduleWidget() {
  setHtml($('w-sched'), scheduleWidgetHtml());
}

/* ---------- settings: schedule cards ---------- */

let host = null;
const S = { sched: null, forecast: null, exp: null, custom: null, crypto: null, busy: false, err: {}, expOpen: false, loadFail: null };

async function loadAll({ experiments = true } = {}) {
  const [sched, forecast, exp] = await Promise.all([api('/schedule'), apiOptional('/schedule/forecast'), experiments ? apiOptional('/schedule/experiments') : Promise.resolve(S.exp)]);
  S.sched = sched;
  S.forecast = forecast;
  S.exp = exp;
  state.schedule = sched;
  S.custom = (sched.custom || []).map((r) => ({ ...r }));
  S.crypto = [...(sched.cryptoRuns || [])];
}

function planPickerHtml() {
  const rows = forecastRows(S.forecast, S.sched.plan);
  const by = new Map(rows.map((r) => [r.plan, r]));
  return `<div class="plan-list" role="radiogroup" aria-label="Schedule plan">${PLAN_IDS.map((id) => {
    const r = by.get(id);
    const info = PLAN_INFO[id];
    const sel = S.sched.plan === id;
    const cost = r ? (r.unknown && id === 'custom' ? 'Depends on your times' : r.costText) : 'Depends on your times';
    return `<button type="button" class="plan-opt" role="radio" data-plan="${id}" aria-checked="${sel}" ${S.busy ? 'disabled' : ''}>
      <span class="po-h"><strong>${esc(info.label)}</strong>${sel ? '<span class="chip chip-ok">Selected</span>' : ''}</span>
      <span class="po-w">${esc(info.when)}</span>
      <span class="po-b dim">${esc(info.blurb)}</span>
      ${r && !(id === 'custom' && r.unknown) ? `<span class="po-n mono">${esc(r.runsText)}</span>` : ''}
      <span class="po-c ${r?.unknown ? 'dim' : 'mono'}">${esc(cost)}${r && !r.unknown && r.perRunText ? ` <small class="dim">(${esc(r.perRunText)})</small>` : ''}</span>
      ${r && !(id === 'custom' && r.unknown) ? `<span class="po-f">${chip(r.fits.tone, r.fits.label)}${r.pctText ? ` <small class="dim">${esc(r.pctText)}</small>` : ''}${r.basisText ? ` <small class="dim">${esc(r.basisText)}</small>` : ''}</span>` : ''}
    </button>`;
  }).join('')}</div>`;
}

function timeRowErr(i, errs) {
  return errs?.[i] ? `<span class="fld-err row-err" role="alert">${esc(errs[i])}</span>` : '';
}

function customEditorHtml() {
  const v = S.err.custom || {};
  return `<form class="settings-form sched-sub" id="f-custom" novalidate aria-labelledby="h-custom"><h3 class="sub-h" id="h-custom">Your run times (Eastern time)</h3>
    <div class="trow-list">${S.custom.map((r, i) => `<div class="trow" data-i="${i}">
      <label>Time<input type="time" data-f="time" value="${esc(r.time)}" aria-label="Run ${i + 1} time, Eastern" required /></label>
      <label>Days<select data-f="days" aria-label="Run ${i + 1} days"><option value="weekdays" ${r.days === 'weekdays' ? 'selected' : ''}>Weekdays</option><option value="daily" ${r.days === 'daily' ? 'selected' : ''}>Every day</option></select></label>
      <label>Scope<select data-f="scope" aria-label="Run ${i + 1} scope"><option value="stocks" ${r.scope === 'stocks' ? 'selected' : ''}>Stocks</option><option value="crypto" ${r.scope === 'crypto' ? 'selected' : ''}>Crypto</option><option value="all" ${r.scope === 'all' ? 'selected' : ''}>Both</option></select></label>
      <button type="button" class="btn-ghost trow-x" data-rm="custom" data-i="${i}" aria-label="Remove run ${i + 1}">Remove</button>${timeRowErr(i, v.errors)}</div>`).join('')}</div>
    ${v.error ? `<div class="form-err" role="alert">${esc(v.error)}</div>` : ''}
    ${S.custom.length ? '' : '<p class="dim">No custom times yet. Add at least one, or pick another plan.</p>'}
    <div class="row-actions"><button type="button" class="btn-ghost" data-add="custom" ${S.custom.length >= 24 ? 'disabled' : ''}>Add a time</button><button class="btn-accent" type="submit">Save custom times</button></div></form>`;
}

function cryptoHtml() {
  const v = S.err.crypto || {};
  const on = S.crypto.length > 0;
  return `<form class="settings-form sched-sub" id="f-crypto" novalidate aria-labelledby="h-crypto"><h3 class="sub-h" id="h-crypto">Crypto runs (optional)</h3>
    <p class="dim">Adds a daily crypto run at the times below (Eastern time), including weekends. <strong>Each crypto run costs the same as a stock run</strong>, so two a day roughly doubles a one-a-day plan. Off by default.</p>
    <div class="trow-list">${S.crypto.map((t, i) => `<div class="trow trow-2" data-i="${i}"><label>Time<input type="time" data-f="ctime" value="${esc(t)}" aria-label="Crypto run ${i + 1} time, Eastern" required /></label><button type="button" class="btn-ghost trow-x" data-rm="crypto" data-i="${i}" aria-label="Remove crypto run ${i + 1}">Remove</button>${timeRowErr(i, v.errors)}</div>`).join('')}</div>
    ${v.error ? `<div class="form-err" role="alert">${esc(v.error)}</div>` : ''}
    ${on ? '' : '<p class="dim">Crypto runs are off.</p>'}
    <div class="row-actions"><button type="button" class="btn-ghost" data-add="crypto" ${S.crypto.length >= 12 ? 'disabled' : ''}>Add a crypto run</button><button class="btn-accent" type="submit">${on ? 'Save crypto runs' : 'Save (crypto off)'}</button></div></form>`;
}

function eventHtml() {
  const e = { enabled: false, spyMovePct: 1, btcMovePct: 2.5, shortlistMovePct: 3, minMinutesBetweenEventRuns: 120, maxEventRunsPerDay: 2, ...(S.sched.eventTriggers || {}) };
  const er = S.err.event || {};
  const f = (id, k, label, hint, mode = 'decimal') => `<label for="${id}">${label}<input id="${id}" type="text" inputmode="${mode}" autocomplete="off" enterkeyhint="next" value="${esc(e[k])}" aria-describedby="${id}-h ${id}-e" /><span class="fld-hint" id="${id}-h">${hint}</span><span class="fld-err" id="${id}-e" role="alert">${esc(er[k] || '')}</span></label>`;
  return `<form class="settings-form sched-sub" id="f-event" novalidate aria-labelledby="h-event"><h3 class="sub-h" id="h-event">Event triggers</h3>
    <div class="sw-row"><div class="sw-txt"><strong id="ev-l">Extra run on big moves</strong><p class="dim" id="ev-d">When the market moves sharply, run the AI once more outside the schedule${S.sched.eventTriggers?.enabled ? ` (today: ${Number(S.sched.eventTriggers.firedToday) || 0} fired)` : ''}. Event runs are dropped first when the budget runs low.</p></div>
      <button type="button" class="switch" id="sw-ev" role="switch" aria-checked="${!!e.enabled}" aria-labelledby="ev-l" aria-describedby="ev-d"><span class="sw-knob" aria-hidden="true"></span><span class="sw-state">${e.enabled ? 'ON' : 'OFF'}</span></button></div>
    ${f('ev-spy', 'spyMovePct', 'SPY move (%, 0.1 to 20)', 'The S&amp;P 500 ETF moves this much.')}
    ${f('ev-btc', 'btcMovePct', 'Bitcoin move (%, 0.1 to 30)', 'Bitcoin moves this much.')}
    ${f('ev-sl', 'shortlistMovePct', 'Shortlist move (%, 0.1 to 50)', 'A stock on the AI’s shortlist moves this much.')}
    ${f('ev-cd', 'minMinutesBetweenEventRuns', 'Cooldown (minutes, 5 to 1440)', 'Minimum wait between event runs.', 'numeric')}
    ${f('ev-max', 'maxEventRunsPerDay', 'Daily cap (0 to 10)', 'Most event runs per day.', 'numeric')}
    <div class="form-err" role="alert" data-err></div>
    <div class="row-actions"><button class="btn-accent" type="submit">Save event triggers</button></div></form>`;
}

function statusHtml() {
  const s = S.sched;
  const nx = nextRunView(s.nextRunAt);
  const slots = (s.slotsToday || []).map(slotView);
  const runs = (s.lastRuns || []).map(lastRunView);
  const est = S.forecast?.estCostPerRunUsd;
  const exp = S.exp;
  const expRows = (exp?.plans || []).map((p) => experimentRow(p, exp.minSample));
  return `<section class="widget sched-status" id="sec-sched-status" aria-labelledby="h-sst"><h2 class="widget-title" id="h-sst">SCHEDULE STATUS</h2>
    <div class="sched-next"><span class="lbl">NEXT RUN</span>${s.enabled ? `<strong>${nx.et ? esc(nx.et) : 'none pending'}</strong>${nx.local ? `<span class="dim">${esc(nx.local)}</span>` : ''}` : '<strong>Schedule is off</strong>'}</div>
    <h3 class="sub-h">Today’s runs</h3>
    ${slots.length ? `<ul class="slots" aria-label="Today’s run times">${slots.map(slotPill).join('')}</ul>` : '<p class="dim">No scheduled runs today.</p>'}
    <div class="row-actions testfire"><button type="button" class="btn-accent" id="btn-testfire" ${S.busy ? 'disabled' : ''}>Test fire now</button><span class="dim">Runs the AI once right now, exactly like a scheduled run. It costs about ${est != null && S.forecast?.basis !== 'unknown' ? esc(usdText(est, 3)) : 'one run’s'} of your budget.</span></div>
    <div class="form-err" role="alert" id="tf-err"></div>
    <h3 class="sub-h">Recent runs</h3>
    ${runs.length ? `<ul class="lr-list">${runs.map((r) => `<li class="lr"><div class="lr-h">${chip(r.trigger.tone, r.trigger.label, r.trigger.detail ? ` title="${esc(r.trigger.detail)}"` : '')}<span class="chip chip-${r.tone}">${esc(r.statusLabel)}</span><span class="dim lr-when">${esc(fmtDateTime(r.at))}</span></div><div class="lr-d"><span>Cost <strong class="mono">${esc(r.costText)}</strong></span><span>Proposals <strong class="mono">${esc(r.proposalsText)}</strong></span></div>${r.reasonText ? `<small class="dim">${esc(r.reasonText)}</small>` : ''}${r.trigger.detail ? `<small class="dim">${esc(r.trigger.detail)}</small>` : ''}</li>`).join('')}</ul>` : '<p class="dim">No scheduled, event or test runs yet.</p>'}
    <details class="exp" id="exp-det" ${S.expOpen ? 'open' : ''}><summary>Experiments: which plan works best?</summary>
      <p class="dim">Compares plans by what they cost and what their proposals earned. A plan needs ${exp?.minSample?.runs ?? 10} runs and ${exp?.minSample?.scoredProposals ?? 10} scored proposals before its edge per dollar is shown, so early numbers are not meaningful.</p>
      ${exp?.netEdgeDefinition ? `<p class="dim">${esc(String(exp.netEdgeDefinition).slice(0, 300))}</p>` : ''}
      ${expRows.length ? `<ul class="lr-list">${expRows.map((r) => `<li class="lr"><div class="lr-h"><strong>${esc(r.plan)}</strong><span class="dim">${esc(r.sampleText)}</span></div>
        <dl class="exp-d"><div><dt>Avg cost / run</dt><dd class="mono">${esc(r.avgCostText)}</dd></div><div><dt>Proposals / run</dt><dd class="mono">${esc(r.proposalsPerRunText)}</dd></div><div><dt>Approval rate</dt><dd class="mono">${esc(r.approvalText)}</dd></div><div><dt>Edge per dollar</dt><dd class="${r.enough ? 'mono' : 'dim'}">${esc(r.edgePerDollarText)}</dd></div></dl>${r.note ? `<small class="dim">${esc(r.note)}</small>` : ''}</li>`).join('')}</ul>` : '<p class="dim">No runs to compare yet.</p>'}
    </details></section>`;
}

function renderSched() {
  const s = S.sched;
  const fc = S.forecast;
  const newsNote = fc?.newsIncluded ? ' Includes one news-bot call per run.' : '';
  host.innerHTML = `<div class="settings-grid sched-grid">
    <section class="widget sched-card" id="sec-schedule" aria-labelledby="h-sched"><h2 class="widget-title" id="h-sched">RUN SCHEDULE</h2>
      <div class="sw-row"><div class="sw-txt"><strong id="sch-l">Scheduled runs</strong><p class="dim" id="sch-d">${s.enabled ? 'ON: the AI runs at the times below (US Eastern time, skipping weekends and market holidays). It only proposes; you still approve everything.' : 'OFF: the AI only runs when you press RUN. Turn this on to have it run by itself at set times. Each run costs AI budget; the plans below show what that adds up to.'}</p></div>
        <button type="button" class="switch" id="sw-sched" role="switch" aria-checked="${!!s.enabled}" aria-labelledby="sch-l" aria-describedby="sch-d" ${S.busy ? 'disabled' : ''}><span class="sw-knob" aria-hidden="true"></span><span class="sw-state">${s.enabled ? 'ON' : 'OFF'}</span></button></div>
      <h3 class="sub-h">Plan</h3>
      ${planPickerHtml()}
      <p class="dim fc-foot">Monthly cost is a 30-day projection against your ${fc ? esc(usdText(fc.capUsd, 0)) : '$20'} budget.${fc?.basis === 'unknown' ? ' Until you have real runs there is no measured cost, so none is shown.' : fc?.basis === 'estimated' ? ' Based on model prices and typical token sizes until you have real runs.' : fc?.basis === 'measured' ? ' Based on the average cost of your real runs.' : ''}${esc(newsNote)}</p>
      ${(() => { const r = forecastRows(S.forecast, s.plan).find((x) => x.selected); return r?.note ? `<details class="fc-det"><summary>How this forecast is worked out</summary><p class="dim">${esc(r.note)}</p></details>` : ''; })()}
      ${s.plan === 'custom' ? customEditorHtml() : ''}
      ${cryptoHtml()}
      ${eventHtml()}
    </section>
    ${statusHtml()}</div>`;
}

function setBusy(v) {
  S.busy = v;
  host?.querySelectorAll('#sw-sched, .plan-opt, #btn-testfire').forEach((b) => (b.disabled = v));
}

async function afterChange(msg) {
  await loadAll({ experiments: false }).catch(() => {});
  S.err = {};
  renderSched();
  if (msg) toast(msg, 'success');
  refresh().then(() => hooks.patchCurrent()).catch(() => {});
}

function readRows(sel, fields) {
  return [...host.querySelectorAll(sel)].map((row) => Object.fromEntries(fields.map(([k, f]) => [k, row.querySelector(`[data-f="${f}"]`)?.value ?? ''])));
}

function wire() {
  host.addEventListener('click', async (e) => {
    const t = e.target;
    const plan = t.closest('[data-plan]');
    if (plan && !plan.disabled) {
      const id = plan.dataset.plan;
      if (id === S.sched.plan) return;
      setBusy(true);
      try {
        await savePatch({ plan: id });
        S.err = {};
        await afterChange(`Plan changed to ${PLAN_INFO[id].label}`);
        if (id === 'custom' && !S.custom.length) host.querySelector('[data-add="custom"]')?.focus();
      } catch (er) {
        toast(`Could not change plan: ${er.message}`, 'error');
      } finally {
        setBusy(false);
      }
      return;
    }
    const add = t.closest('[data-add]');
    if (add) {
      const k = add.dataset.add;
      if (k === 'custom') S.custom = [...readRows('#f-custom .trow', [['time', 'time'], ['days', 'days'], ['scope', 'scope']]), { time: '09:30', days: 'weekdays', scope: 'stocks' }];
      else S.crypto = [...readRows('#f-crypto .trow', [['t', 'ctime']]).map((r) => r.t), '21:00'];
      renderSched();
      host.querySelectorAll(`#f-${k} .trow`)[(k === 'custom' ? S.custom : S.crypto).length - 1]?.querySelector('input')?.focus();
      return;
    }
    const rm = t.closest('[data-rm]');
    if (rm) {
      const k = rm.dataset.rm;
      const i = Number(rm.dataset.i);
      if (k === 'custom') S.custom = readRows('#f-custom .trow', [['time', 'time'], ['days', 'days'], ['scope', 'scope']]).filter((_, j) => j !== i);
      else S.crypto = readRows('#f-crypto .trow', [['t', 'ctime']]).map((r) => r.t).filter((_, j) => j !== i);
      renderSched();
      host.querySelector(`[data-add="${k}"]`)?.focus();
      return;
    }
    if (t.closest('#sw-sched')) return toggleSchedule();
    if (t.closest('#sw-ev')) {
      const sw = t.closest('#sw-ev');
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      sw.querySelector('.sw-state').textContent = on ? 'ON' : 'OFF';
      return;
    }
    if (t.closest('#btn-testfire')) return testFire(t.closest('#btn-testfire'));
  });
  host.addEventListener('toggle', (e) => {
    if (e.target.id === 'exp-det') S.expOpen = e.target.open;
  }, true);
  host.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type=submit]');
    if (form.id === 'f-custom') {
      S.custom = readRows('#f-custom .trow', [['time', 'time'], ['days', 'days'], ['scope', 'scope']]);
      const v = validateCustomSlots(S.custom);
      if (!v.ok) {
        S.err.custom = v;
        renderSched();
        return host.querySelector('#f-custom .row-err, #f-custom .form-err')?.scrollIntoView({ block: 'center' });
      }
      return run(btn, () => savePatch({ custom: v.value }), 'Custom times saved');
    }
    if (form.id === 'f-crypto') {
      S.crypto = readRows('#f-crypto .trow', [['t', 'ctime']]).map((r) => r.t);
      const v = validateCryptoRuns(S.crypto);
      if (!v.ok) {
        S.err.crypto = v;
        renderSched();
        return;
      }
      if (v.value.length) {
        const ok = await confirmDialog({ title: 'Turn on crypto runs?', message: `Each crypto run costs the same as a stock run, and crypto runs happen every day including weekends (${v.value.length} a day at ${v.value.join(', ')} ET). That adds to your monthly AI spend.`, confirmText: 'Save crypto runs' });
        if (!ok) return;
      }
      return run(btn, () => savePatch({ cryptoRuns: v.value }), v.value.length ? 'Crypto runs saved' : 'Crypto runs are off');
    }
    if (form.id === 'f-event') {
      const val = (id) => $(id).value;
      const v = validateEventTriggers({ enabled: $('sw-ev').getAttribute('aria-checked') === 'true', spyMovePct: val('ev-spy'), btcMovePct: val('ev-btc'), shortlistMovePct: val('ev-sl'), minMinutesBetweenEventRuns: val('ev-cd'), maxEventRunsPerDay: val('ev-max') });
      const ids = { spyMovePct: 'ev-spy', btcMovePct: 'ev-btc', shortlistMovePct: 'ev-sl', minMinutesBetweenEventRuns: 'ev-cd', maxEventRunsPerDay: 'ev-max' };
      Object.entries(ids).forEach(([k, id]) => {
        $(`${id}-e`).textContent = v.errors[k] || '';
        $(id).toggleAttribute('aria-invalid', !!v.errors[k]);
      });
      if (!v.ok) return $(ids[Object.keys(v.errors)[0]]).focus();
      return run(btn, () => savePatch({ eventTriggers: v.value }), 'Event triggers saved');
    }
  });
}

async function run(btn, fn, msg) {
  btn.disabled = true;
  try {
    await fn();
    await afterChange(msg);
  } catch (er) {
    toast(`Could not save: ${er.message}`, 'error');
    const box = btn.closest('form')?.querySelector('[data-err]');
    if (box) box.textContent = er.message;
    btn.disabled = false;
  }
}

async function toggleSchedule() {
  const next = !S.sched.enabled;
  if (next) {
    const fc = forecastRows(S.forecast, S.sched.plan).find((r) => r.selected);
    const ok = await confirmDialog({
      title: 'Turn on scheduled runs?',
      message: `The AI will run by itself at the times of ${PLAN_INFO[S.sched.plan]?.label || 'your plan'} (${PLAN_INFO[S.sched.plan]?.when || 'custom times'}). Each run uses your OpenRouter key and AI budget${fc ? `; projected ${fc.unknown ? 'cost is unknown until your first runs' : `${fc.costText} (${fc.fits.label})`}` : ''}. It only proposes trades; nothing opens until you approve. Runs are skipped when the budget is too low. You can turn this off any time.`,
      confirmText: 'Turn on schedule',
    });
    if (!ok) return;
  }
  setBusy(true);
  try {
    await savePatch({ enabled: next });
    await afterChange(next ? 'Scheduled runs are ON' : 'Scheduled runs are OFF');
  } catch (er) {
    toast(`Could not change the schedule: ${er.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function testFire(btn) {
  const est = S.forecast?.estCostPerRunUsd;
  const ok = await confirmDialog({
    title: 'Run the AI now as a test?',
    message: `This starts one real run right now, exactly like a scheduled run (scanner, news and trader). It uses your OpenRouter key and costs about ${est != null && S.forecast?.basis !== 'unknown' ? usdText(est, 3) : 'one run’s worth'} of your monthly budget. It only proposes trades; nothing opens until you approve.`,
    confirmText: 'Test fire now',
  });
  if (!ok) return;
  const errBox = $('tf-err');
  if (errBox) errBox.textContent = '';
  btn.disabled = true;
  try {
    const res = await api('/schedule/test-fire', { method: 'POST', body: '{}' });
    toast('Test run started. Follow it on the dashboard.', 'success', 7000, { label: 'Open dashboard', href: '#dashboard' });
    state.runLocal = true;
    state.run = { ...(state.run || {}), ...(res.run || {}), trigger: res.trigger || res.run?.trigger || { type: 'test' }, running: true, stage: res.run?.stage || 'fetching', startedAt: res.run?.startedAt || new Date().toISOString() };
    trackRun();
    setTimeout(() => afterChange().catch(() => {}), 1500);
  } catch (er) {
    const m = testFireMessage(er);
    if (errBox) errBox.textContent = `${m.title}. ${m.message}`;
    toast(`${m.title}. ${m.message}`, 'error', 9000);
    if (er.code === 'unknown_slot') afterChange().catch(() => {});
  } finally {
    btn.disabled = false;
  }
}

/** Mount the schedule cards into `el` (Settings page). */
export async function mountSchedule(el) {
  host = el;
  host.innerHTML = `<section class="widget" aria-busy="true"><h2 class="widget-title">RUN SCHEDULE</h2>${skeleton(3)}</section>`;
  try {
    await loadAll();
  } catch (e) {
    if (!host.isConnected) return;
    host.innerHTML = `<section class="widget" aria-labelledby="h-sched"><h2 class="widget-title" id="h-sched">RUN SCHEDULE</h2><div class="notice" role="alert">Could not load the schedule: ${esc(e.message)}</div><button class="btn-ghost" type="button" id="sched-retry">Retry</button></section>`;
    host.querySelector('#sched-retry')?.addEventListener('click', () => mountSchedule(host));
    return;
  }
  if (!host.isConnected) return;
  renderSched();
  if (!host.__wired) {
    wire();
    host.__wired = true;
  }
}
