import { apiOptional, escapeHtml as esc, fmtTime } from './api.js';
import { $, empty, root, setHtml, skeleton, state } from './state.js';

/* logs page */
export function logsHtml() {
  const src = state.logs || state.dashboard?.logs;
  if (!src) return state.loaded ? empty('No logs') : skeleton(6);
  const rows = src.filter((l) => state.logFilter === 'all' || (state.logFilter === 'warn' ? l.level === 'warn' || l.level === 'error' : l.level === 'error'));
  return rows.length
    ? rows.map((l) => `<div class="log-row ${esc(l.level)}"><span class="ts">${esc(fmtTime(l.ts))}</span><span class="msg"><span class="lvl">${esc(l.level)}</span> ${esc(l.message)}</span></div>`).join('')
    : empty('No matching log entries');
}
export async function loadLogs() {
  const r = await apiOptional('/logs?limit=200');
  if (r?.logs) state.logs = r.logs;
  setHtml($('log-list'), logsHtml());
}
export function mountLogs() {
  root.innerHTML = `<div class="page"><section class="widget" style="min-height:70vh" aria-labelledby="h-logs">
    <h2 class="widget-title" id="h-logs"><span>LOGS</span><span class="range-tabs" role="group" aria-label="Filter log level">${[['all', 'All'], ['warn', 'Warnings+'], ['error', 'Errors']].map(([k, l]) => `<button type="button" data-lf="${k}" aria-pressed="${state.logFilter === k}" class="${state.logFilter === k ? 'active' : ''}">${l}</button>`).join('')}</span></h2>
    <div class="log-list scroll-y" id="log-list" tabindex="0" role="log" aria-label="Server log"></div></section></div>`;
  $('log-list').closest('section').querySelector('.range-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lf]');
    if (!b) return;
    state.logFilter = b.dataset.lf;
    e.currentTarget.querySelectorAll('button').forEach((x) => {
      x.setAttribute('aria-pressed', String(x === b));
      x.classList.toggle('active', x === b);
    });
    setHtml($('log-list'), logsHtml());
  });
  setHtml($('log-list'), logsHtml());
  loadLogs();
}
