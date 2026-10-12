import { api, escapeHtml as esc } from './api.js';
import { state } from './state.js';
import { toast } from './ui.js';

/* Kronos forecast row on a pending proposal card. Only shown when the server has a forecast service (KRONOS_URL). Advice only. */

const one = (p) => p.kronos || state.kronosLocal[p.id] || null;
const pctText = (x) => `${Math.round(x * 100)}%`;
const PROBLEMS = {
  not_configured: 'The forecast service is not set up.',
  forecast_unreachable: 'Cannot reach the forecast service. Check that it is running.',
  forecast_failed: 'The forecast service failed. Check its log.',
  invalid_output: 'The forecast service sent a bad reply.',
  timeout: 'The forecast took too long. Try again.',
  no_history: 'Not enough price history for this symbol.',
  not_pending: 'Only pending trades can be forecast.',
};
const problem = (e) => (e?.network ? 'Cannot reach the server. Check your connection.' : PROBLEMS[e?.code] || e?.message || 'The forecast could not run.');

export const kronosSig = (p) => JSON.stringify([one(p)?.at || null, Boolean(state.kronosUi[p.id]?.busy), state.kronosUi[p.id]?.error || null, Boolean(state.status?.forecastConfigured)]);

export function kronosRowHtml(p) {
  const ui = state.kronosUi[p.id] || {};
  const k = one(p);
  if (!k && !state.status?.forecastConfigured) return '';
  if (ui.busy) return '<div class="pc-judge pc-judge-busy" role="status"><span class="spin" aria-hidden="true"></span> Kronos is drawing possible price paths…</div>';
  if (!k) return `<div class="pc-judge"><button type="button" class="btn-ghost pcj-btn" data-act="forecast">📈 Forecast with Kronos</button><small class="dim">Simulates possible price paths. No AI budget used.</small>${ui.error ? `<p class="pcj-err" role="alert">${esc(ui.error)}</p>` : ''}</div>`;
  const s = k.stats;
  const tone = s.call === 'take' ? 'good' : 'bad';
  return `<div class="pc-judge pc-judge-${tone}">
    <div class="pcj-head"><span class="lbl">KRONOS</span><span class="pcj-call pcj-${tone}">${s.call === 'take' ? 'TAKE' : 'SKIP'}</span><span><strong class="mono">${pctText(s.meanP)}</strong> of paths end in profit</span></div>
    <div class="pcj-meta dim">${esc(`${pctText(s.pTarget)} hit target · ${pctText(s.pStop)} hit stop · ${s.n} paths · ${k.horizonHours}h`)}${s.edge != null ? esc(` · ${s.edge >= 0 ? '+' : ''}${Math.round(s.edge * 100)} pts vs break-even`) : ''}</div>
    <div class="pcj-foot dim">A model guess. It can be wrong. Loss review shows its record. <button type="button" class="linklike" data-act="forecast-redo">Run again</button></div>
    ${ui.error ? `<p class="pcj-err" role="alert">${esc(ui.error)}</p>` : ''}</div>`;
}

export async function askKronos(p, force, rerender) {
  if (state.kronosUi[p.id]?.busy) return;
  state.kronosUi[p.id] = { busy: true };
  rerender();
  try {
    const res = await api(`/proposals/${encodeURIComponent(p.id)}/forecast${force ? '?force=1' : ''}`, { method: 'POST', body: '{}' });
    state.kronosLocal[p.id] = res.kronos;
    delete state.kronosUi[p.id];
    if (!res.cached) toast(`Forecast for ${p.symbol}: ${res.kronos.stats.call.toUpperCase()}, ${pctText(res.kronos.stats.meanP)} of paths end in profit.`, 'success', 5000);
  } catch (e) {
    state.kronosUi[p.id] = { error: problem(e) };
  }
  rerender();
}

export const resetKronos = () => {
  state.kronosUi = {};
  state.kronosLocal = {};
};
