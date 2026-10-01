import { escapeHtml as esc } from './api.js';
import { moodClass, quoteChip } from './fun-logic.js';
import { $, setHtml, state } from './state.js';

/* Live market mood bar: a slim strip under the top nav on every page. */

let open = false;

export function moodHtml() {
  const m = state.mood;
  if (!m || state.locked) return '';
  const has = m.score != null;
  const cls = moodClass(m.score);
  const chips = (m.quotes || []).map(quoteChip);
  const comps = (m.components || []).map((c) => `<li><span class="mood-cl">${esc(c.label)}</span><span class="mood-cbar" role="img" aria-label="${esc(`${c.label}: ${c.score} out of 100`)}"><span style="width:${c.score}%"></span></span><span class="mono mood-cv">${c.score}</span><small class="dim">${esc(c.detail)}</small></li>`).join('');
  return `<div class="mood mood-${cls}">
    ${has ? `<button type="button" class="mood-main" id="mood-btn" aria-expanded="${open}" aria-controls="mood-panel"><span class="mood-emoji" aria-hidden="true">${esc(m.emoji)}</span><span class="mood-l"><span class="mood-k">MARKET MOOD</span> <strong>${esc(m.label)}</strong> <span class="mono mood-score">${m.score}</span></span><span class="mood-meter" role="img" aria-label="Mood ${m.score} out of 100, ${esc(m.label)}"><span class="mood-mark" style="left:${m.score}%"></span></span></button>` : '<span class="mood-main mood-na"><span class="mood-k">MARKET MOOD</span> <span class="dim">not enough data yet</span></span>'}
    <ul class="mood-quotes" aria-label="Index quotes">${chips.map((c) => `<li><span class="mood-sym">${esc(c.symbol)}</span> <span class="mono">${esc(c.price)}</span> <span class="mono ${c.tone}">${esc(c.change)}</span>${c.stale ? ' <span class="dim" title="Last close: the market is closed or the data is old">·</span>' : ''}</li>`).join('')}</ul>
    ${m.mock ? '<span class="badge-demo mood-demo">DEMO DATA</span>' : ''}
    <div class="mood-panel" id="mood-panel" ${open && has ? '' : 'hidden'}><ul class="mood-comps">${comps}</ul><p class="dim mood-note">${esc(m.note || '')} Updated ${esc(new Date(m.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}.</p></div>
  </div>`;
}

export function patchMood() {
  setHtml($('mood-bar'), moodHtml());
}

export function bindMood() {
  $('mood-bar')?.addEventListener('click', (e) => {
    if (!e.target.closest('#mood-btn')) return;
    open = !open;
    const el = $('mood-bar');
    el.__h = null; // force a re-render with the new state
    patchMood();
    $('mood-btn')?.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      open = false;
      $('mood-bar').__h = null;
      patchMood();
    }
  });
}
