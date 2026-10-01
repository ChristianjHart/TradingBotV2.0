import { foldAllTarget, isSectionOpen, parseSectionPrefs, SECTIONS, SECTIONS_STORE_KEY, sectionLabel, sectionSummary, withSection } from './collapse-logic.js';

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

/** Section header: a toggle button (title, one-line summary, chevron) inside a level-2 heading, plus an optional link such as "Manage". */
export function sectionHeadHtml(key, link = null) {
  const open = isSectionOpen(load(), key);
  return `<div class="dsec-hw" role="heading" aria-level="2"><button type="button" class="dsec-h" data-dsec-toggle="${key}" aria-expanded="${open}" aria-controls="dsec-${key}"><span class="dsec-t">${SECTIONS[key].title}</span><span class="dsec-s"></span><svg class="dsec-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>${link ? `<a class="dsec-a" href="${link.href}">${link.label}</a>` : ''}</div>`;
}

function setOpen(w, open) {
  w.classList.toggle('is-collapsed', !open);
  w.querySelector('[data-dsec-toggle]')?.setAttribute('aria-expanded', String(open));
}

/** Label the fold button: "Collapse all" while any section is open, else "Expand all". */
export function syncFoldButton() {
  const b = document.getElementById('btn-fold');
  if (!b) return;
  const anyOpen = !foldAllTarget([...document.querySelectorAll('[data-dsec]')].map((w) => !w.classList.contains('is-collapsed')));
  b.textContent = anyOpen ? 'Collapse all' : 'Expand all';
  b.setAttribute('aria-label', anyOpen ? 'Collapse all sections' : 'Expand all sections');
}

/** Collapse every section when any is open, else expand every section. Remembered like a single toggle. */
export function foldAll() {
  const ws = [...document.querySelectorAll('[data-dsec]')];
  const open = foldAllTarget(ws.map((w) => !w.classList.contains('is-collapsed')));
  for (const w of ws) {
    prefs = withSection(load(), w.dataset.dsec, open);
    setOpen(w, open);
  }
  save();
  syncFoldButton();
}

/** Apply the remembered state to every section in the page. */
export function applySections(rootEl = document) {
  rootEl.querySelectorAll('[data-dsec]').forEach((w) => setOpen(w, isSectionOpen(load(), w.dataset.dsec)));
  syncFoldButton();
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
    syncFoldButton();
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
