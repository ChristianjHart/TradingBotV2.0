import { escapeHtml as esc } from './api.js';
import { calendarGroups, calendarSummary } from './fun-logic.js';
import { $, empty, setHtml, skeleton, state } from './state.js';

/* Earnings & event calendar widget. */

const ICON = { macro: '🏛️', earnings: '📊', market: '🔒' };
const TAG = { position: 'YOU HOLD IT', proposal: 'PROPOSED', pick: 'SCANNER PICK', macro: '', market: '' };

let showAll = false;
const LIMIT = 8;

export function calendarHtml() {
  if (!state.loaded) return skeleton(3);
  const cal = state.calendar;
  if (!cal) return empty('The calendar is not available from the server yet.');
  const groups = calendarGroups(cal);
  const total = groups.reduce((n, g) => n + g.events.length, 0);
  const rows = [];
  let shown = 0;
  for (const g of groups) {
    if (!showAll && shown >= LIMIT) break;
    const evs = showAll ? g.events : g.events.slice(0, LIMIT - shown);
    shown += evs.length;
    rows.push(`<div class="cal-day"><h3 class="cal-date">${esc(g.label)} <span class="dim">· ${esc(g.rel)}</span></h3><ul class="cal-list">${evs
      .map((e) => `<li class="cal-ev cal-${esc(e.kind)} cal-imp-${esc(e.impact)}"><span class="cal-ic" aria-hidden="true">${ICON[e.kind] || '•'}</span><div class="cal-body"><div class="cal-t"><strong>${esc(e.title)}</strong>${(e.tags || []).filter((t) => TAG[t]).map((t) => `<span class="chip chip-${t === 'position' ? 'warn' : 'off'} cal-tag">${esc(TAG[t])}</span>`).join('')}${e.approx ? '<span class="chip chip-off cal-tag">APPROX.</span>' : ''}</div><small class="dim">${esc(e.detail)}</small></div></li>`)
      .join('')}</ul></div>`);
  }
  const notes = [];
  if (!cal.earningsAvailable) notes.push(`Earnings dates are off: ${cal.earningsError === 'no Finnhub key' ? 'add a Finnhub key under <a class="prop-link" href="#settings/account">Settings → Account</a>' : esc(cal.earningsError || 'the lookup failed')}.`);
  else if (!cal.watched) notes.push('Earnings are shown for what you hold, what is proposed and the scanner’s top picks. Run the AI once to fill that list.');
  if (!cal.macroCovered) notes.push(`The built-in macro list only covers ${esc(cal.macroListYears.join(', '))}; later dates are missing.`);
  notes.push('FOMC dates come from a built-in list and the jobs report date is the usual first Friday: verify both before relying on them.');
  return `${rows.length ? rows.join('') : '<div class="empty">Nothing scheduled in the next few weeks that this calendar tracks.</div>'}
    ${total > LIMIT ? `<button type="button" class="btn-ghost cal-more" id="cal-more" aria-pressed="${showAll}">${showAll ? 'Show fewer' : `Show all ${total} events`}</button>` : ''}
    <p class="dim cal-note">${notes.join(' ')}</p>`;
}

export function patchCalendar() {
  setHtml($('w-cal'), calendarHtml());
}

export function bindCalendar() {
  $('w-cal')?.addEventListener('click', (e) => {
    if (!e.target.closest('#cal-more')) return;
    showAll = !showAll;
    patchCalendar();
  });
}

export const calendarSectionSummary = () => calendarSummary(state.calendar);
