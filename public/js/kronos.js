import { api, escapeHtml as esc } from './api.js';
import { chartSvg, forecastFacts } from './kronos-logic.js';
import { state } from './state.js';
import { toast } from './ui.js';

/* Kronos forecast row on a pending proposal card. Only shown when the server has a forecast service (KRONOS_URL). Advice only. */

const one = (p) => p.kronos || state.kronosLocal[p.id] || null;
const pctText = (x) => `${Math.round(x * 100)}%`;
const PROBLEMS = {
  not_configured: 'The forecast service is not set up.',
  forecast_unreachable: 'Cannot reach the forecast service. Check that it is running.',
  forecast_unauthorized: 'The forecast service refused the token. Check KRONOS_TOKEN.',
  forecast_failed: 'The forecast service failed. Check its log.',
  invalid_output: 'The forecast service sent a bad reply.',
  timeout: 'The forecast took too long. Try again.',
  no_history: 'Not enough price history for this symbol.',
  price_mismatch: 'The price history does not match this trade’s entry price, so no forecast was made.',
  not_pending: 'Only pending trades can be forecast.',
};
const problem = (e) => (e?.network ? 'Cannot reach the server. Check your connection.' : PROBLEMS[e?.code] || e?.message || 'The forecast could not run.');

export const kronosSig = (p) => JSON.stringify([one(p)?.at || null, Boolean(state.kronosUi[p.id]?.busy), state.kronosUi[p.id]?.error || null, Boolean(state.status?.forecastConfigured)]);

export function kronosRowHtml(p) {
  const ui = state.kronosUi[p.id] || {};
  const k = one(p);
  if (!k && !state.status?.forecastConfigured) return '';
  if (ui.busy) return '<div class="pc-judge pc-judge-busy" role="status"><span class="spin" aria-hidden="true"></span> Kronos is drawing price paths…</div>';
  if (!k) return `<button type="button" class="btn-ghost pcj-btn" data-act="forecast" title="Simulates possible price paths. No AI budget used.">📈 Forecast</button>${ui.error ? `<p class="pcj-err" role="alert">${esc(ui.error)}</p>` : ''}`;
  const s = k.stats;
  const tone = s.call === 'take' ? 'good' : 'bad';
  const facts = forecastFacts({ ...k, stats: s, side: p.side, entry: p.entry, stopLoss: p.stopLoss, takeProfit: p.takeProfit, horizonHours: k.horizonHours });
  const chart = facts ? chartSvg({ ...k, entry: p.entry, stopLoss: p.stopLoss, takeProfit: p.takeProfit, actual: [] }, { levels: true }) : '';
  return `<div class="pc-judge pc-judge-${tone}">
    <div class="pcj-head"><span class="lbl">KRONOS</span><span class="pcj-call pcj-${tone}">${s.call === 'take' ? 'TAKE' : 'SKIP'}</span><span><strong class="mono">${pctText(s.meanP)}</strong> end in profit</span></div>
    ${facts ? `<div class="pcj-meta dim">${esc(`Median ${facts.median > 0 ? '+' : ''}${facts.median.toFixed(1)}% · target needs ${facts.target > 0 ? '+' : ''}${facts.target.toFixed(1)}%`)}</div>` : ''}
    <details class="pcj-det"><summary>Chart and numbers</summary>
      ${chart ? `<div class="kr-chart" role="img" aria-label="${esc(facts.sentence)}">${chart}</div><p class="dim kr-key"><span class="kr-k kr-k-band"></span> middle 80% of paths <span class="kr-k kr-k-med"></span> median <span class="kr-k kr-k-tgt"></span> target <span class="kr-k kr-k-stop"></span> stop</p>` : ''}
      ${facts ? `<p class="pcj-note">${esc(facts.sentence)}</p>` : ''}
      ${facts?.warning ? `<p class="pcj-err">${esc(facts.warning)}</p>` : ''}
      ${facts?.wicks ? `<p class="pcj-note">${esc(facts.wicks)}</p>` : ''}
      <p class="dim pcj-note">${esc(`${pctText(s.pTarget)} hit the target, ${pctText(s.pStop)} hit the stop, ${pctText(s.pTime)} still open at the time limit (${s.n} paths). A model guess. It can be wrong. Loss review shows its record.`)}</p>
      <div class="pcj-foot dim"><span>${esc(k.model || '')}</span> <button type="button" class="linklike" data-act="forecast-redo">Run again</button></div></details>
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
