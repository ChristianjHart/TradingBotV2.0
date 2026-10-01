import { escapeHtml as esc } from './api.js';
import { calendarGroups, calendarSummary } from './fun-logic.js';
import { $, empty, setHtml, skeleton, state } from './state.js';

/* Earnings & event calendar widget. */

const ICON = { macro: '🏛️', earnings: '📊', market: '🔒' };
const TAG = { position: 'YOU HOLD IT', proposal: 'PROPOSED', pick: 'SCANNER PICK', macro: '', market: '' };

const OPEN_DAYS = 2; // the next two days that have events start open; later days start folded
let dayOpen = {}; // date -> true/false once the owner toggled that day

export function calendarHtml() {
  if (!state.loaded) return skeleton(3);
  const cal = state.calendar;
  if (!cal) return empty('Calendar data is not available yet.');
  const groups = calendarGroups(cal);
  const rows = groups.map((g, i) => {
    const open = dayOpen[g.date] ?? i < OPEN_DAYS;
    const n = g.events.length;
    const list = open
      ? `<ul class="cal-list">${g.events
          .map((e) => `<li class="cal-ev cal-${esc(e.kind)} cal-imp-${esc(e.impact)}"><span class="cal-ic" aria-hidden="true">${ICON[e.kind] || '•'}</span><div class="cal-body"><div class="cal-t"><strong>${esc(e.title)}</strong>${(e.tags || []).filter((t) => TAG[t]).map((t) => `<span class="chip chip-${t === 'position' ? 'warn' : 'off'} cal-tag">${esc(TAG[t])}</span>`).join('')}${e.approx ? '<span class="chip chip-off cal-tag">APPROX.</span>' : ''}</div><small class="dim">${esc(e.detail)}</small></div></li>`)
          .join('')}</ul>`
      : '';
    return `<div class="cal-day"><h3 class="cal-date"><button type="button" class="cal-dtoggle" data-cal-day="${esc(g.date)}" aria-expanded="${open}"><span>${esc(g.label)} <span class="dim">· ${esc(g.rel)}</span></span><span class="dim cal-n">${n} ${n === 1 ? 'event' : 'events'}</span><svg class="dsec-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button></h3>${list}</div>`;
  });
  const notes = [];
  if (!cal.earningsAvailable) notes.push(`No earnings dates: ${cal.earningsError === 'no Finnhub key' ? 'add a Finnhub key in <a class="prop-link" href="#settings/account">Settings</a>' : esc(cal.earningsError || 'the lookup failed')}.`);
  else if (!cal.watched) notes.push('Earnings show for your positions, proposals and top picks. Run the AI to fill the list.');
  if (!cal.macroCovered) notes.push(`The built-in macro list covers only ${esc(cal.macroListYears.join(', '))}.`);
  notes.push('Check FOMC and jobs-report dates before you rely on them. The app has a fixed list.');
  return `${rows.length ? rows.join('') : '<div class="empty">No events in the next few weeks.</div>'}<p class="dim cal-note">${notes.join(' ')}</p>`;
}

export function patchCalendar() {
  setHtml($('w-cal'), calendarHtml());
}

export function bindCalendar() {
  $('w-cal')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cal-day]');
    if (!b) return;
    dayOpen[b.dataset.calDay] = b.getAttribute('aria-expanded') !== 'true';
    patchCalendar();
    $('w-cal').querySelector(`[data-cal-day="${CSS.escape(b.dataset.calDay)}"]`)?.focus({ preventScroll: true });
  });
}

export const calendarSectionSummary = () => calendarSummary(state.calendar);
