import { api, escapeHtml as esc, getToken } from './api.js';
import { authClick } from './chrome.js';
import { refresh } from './data.js';
import { $, root, state } from './state.js';
import { toast } from './ui.js';

/* settings page */
export function mountSettings() {
  const s = state.status?.settings || {};
  const st = state.status || {};
  root.innerHTML = `<div class="page">
    <div class="notice">Trading is permanently disabled in this build. Alpaca is used for market data only; all positions are simulated.</div>
    <div class="settings-grid">
    <section class="widget" aria-labelledby="h-set"><h2 class="widget-title" id="h-set">SETTINGS</h2>
      <form class="settings-form" id="settings-form">
        <label for="s-hz">Position / prediction horizon (hours)<input id="s-hz" name="horizonHours" type="number" min="1" max="168" value="${esc(s.horizonHours ?? 24)}" /></label>
        <label for="s-wl">Watchlist size (legacy scanner)<input id="s-wl" name="watchlistSize" type="number" min="3" max="40" value="${esc(s.watchlistSize ?? 12)}" /></label>
        <label for="s-as">Auto scan (legacy scanner)<select id="s-as" name="autoScan"><option value="true" ${s.autoScan !== false ? 'selected' : ''}>On</option><option value="false" ${s.autoScan === false ? 'selected' : ''}>Off</option></select></label>
        <button class="btn-accent" type="submit">Save</button>
      </form></section>
    <section class="widget" aria-labelledby="h-sys"><h2 class="widget-title" id="h-sys">SYSTEM</h2>
      <dl class="kv">
        <dt>Data mode</dt><dd>${esc(st.dataMode || 'unknown')}</dd>
        <dt>Market</dt><dd>${st.marketOpen == null ? 'unknown' : st.marketOpen ? 'US stocks open' : 'US stocks closed'}</dd>
        <dt>Alpaca keys</dt><dd>${st.alpacaConfigured ? 'configured' : 'missing (mock data)'}</dd>
        <dt>OpenRouter key</dt><dd>${st.openrouterConfigured ? 'configured' : '<span class="neg">missing (rule-based fallback)</span>'}</dd>
        <dt>Supabase</dt><dd>${st.supabaseConfigured ? 'connected' : 'not configured (data resets on restart)'}</dd>
        <dt>Admin auth</dt><dd>${state.auth.required ? (getToken() ? 'required — token saved in this browser' : 'required — not signed in') : 'not required'}</dd>
      </dl>
      ${state.auth.required ? `<button class="btn-ghost" id="btn-auth2" type="button">${getToken() ? 'Sign out' : 'Sign in'}</button>` : ''}
    </section></div></div>`;
  $('btn-auth2')?.addEventListener('click', authClick);
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/settings', { method: 'PATCH', body: JSON.stringify({ watchlistSize: Number(fd.get('watchlistSize')), horizonHours: Number(fd.get('horizonHours')), autoScan: fd.get('autoScan') === 'true' }) });
      toast('Settings saved', 'success');
      await refresh();
    } catch (err) {
      toast(`Could not save settings: ${err.message}`, 'error');
    }
  });
}
