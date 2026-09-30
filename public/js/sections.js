import { isSectionOpen, parseSectionPrefs, SECTIONS, SECTIONS_STORE_KEY, sectionLabel, sectionSummary, withSection } from './collapse-logic.js';

/* Collapsible dashboard sections (phones only: CSS shows the toggle and honours .is-collapsed below 700px). */

let prefs = null;
function load() {
  if (prefs) return prefs;
  try {
    prefs = parseSectionPrefs(localStorage.getItem(SECTIONS_STORE_KEY));
  } catch {
    prefs = {};
  }
  return prefs;
}
function save() {
  try {
    localStorage.setItem(SECTIONS_STORE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
}

/** Phone-only header: a button inside a level-2 heading. Desktop hides it (CSS) and keeps the widget's own h2. */
export function sectionHeadHtml(key) {
  const open = isSectionOpen(load(), key);
  return `<div class="dsec-hw" role="heading" aria-level="2"><button type="button" class="dsec-h" data-dsec-toggle="${key}" aria-expanded="${open}" aria-controls="dsec-${key}"><span class="dsec-t">${SECTIONS[key].title}</span><span class="dsec-s"></span><svg class="dsec-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button></div>`;
}

function setOpen(w, open) {
  w.classList.toggle('is-collapsed', !open);
  w.querySelector('[data-dsec-toggle]')?.setAttribute('aria-expanded', String(open));
}

/** Apply the remembered state to every section in the page. */
export function applySections(rootEl = document) {
  rootEl.querySelectorAll('[data-dsec]').forEach((w) => setOpen(w, isSectionOpen(load(), w.dataset.dsec)));
}

export function bindSections(rootEl) {
  rootEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dsec-toggle]');
    if (!b) return;
    const w = b.closest('[data-dsec]');
    const open = w.classList.contains('is-collapsed');
    prefs = withSection(load(), w.dataset.dsec, open);
    save();
    setOpen(w, open);
  });
}

/** Update the inline summaries; `data` maps key -> input for sectionSummary. */
export function patchSectionSummaries(data) {
  document.querySelectorAll('[data-dsec]').forEach((w) => {
    const key = w.dataset.dsec;
    const s = sectionSummary(key, data[key] || {});
    const b = w.querySelector('[data-dsec-toggle]');
    const span = b?.querySelector('.dsec-s');
    if (!span) return;
    const text = s ? `· ${s}` : '';
    if (span.textContent !== text) span.textContent = text;
    b.setAttribute('aria-label', sectionLabel(key, s));
  });
}

/** Make sure `el` is visible: expand a collapsed section around it (not remembered: it is a one-off jump). */
export function revealSection(el) {
  const w = el?.closest?.('[data-dsec].is-collapsed');
  if (w) setOpen(w, true);
  return !!w;
}
