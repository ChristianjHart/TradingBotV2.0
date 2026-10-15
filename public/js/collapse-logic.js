/* Pure helpers for the collapsible dashboard sections on phones (no DOM, no storage access here). */

/** key -> {title, open by default, more: hidden until "More sections" is pressed}. Order is the on-screen order after Proposals (see the #dsec-* order rules in the CSS). */
export const SECTIONS = {
  pos: { title: 'Positions', open: true },
  sum: { title: 'AI summary', open: false },
  perf: { title: 'Performance', open: false },
  review: { title: 'Loss review', open: false },
  picks: { title: 'Top picks', open: false, more: true },
  news: { title: 'News & earnings', open: false, more: true },
  cal: { title: 'Calendar', open: false, more: true },
  fun: { title: 'Achievements', open: false, more: true },
  totw: { title: 'Trade of the week', open: false, more: true },
  alloc: { title: 'Allocation', open: false, more: true },
  sched: { title: 'Schedule', open: false, more: true },
  budget: { title: 'Budget', open: false, more: true },
};
export const SECTION_KEYS = Object.keys(SECTIONS);
/** Sections tucked behind one "More sections" button, so the page opens with a short list. */
export const SECONDARY_KEYS = SECTION_KEYS.filter((k) => SECTIONS[k].more);
export const MORE_STORE_KEY = 'tb_dash_more';
export const parseMore = (raw) => raw === '1';
export const SECTIONS_STORE_KEY = 'tb_dash_sections';

/** Parse the stored JSON into {key: boolean}; unknown keys and non-boolean values are dropped, bad input gives {}. */
export function parseSectionPrefs(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out = {};
    for (const k of SECTION_KEYS) if (typeof o[k] === 'boolean') out[k] = o[k];
    return out;
  } catch {
    return {};
  }
}

/** "Collapse all" / "Expand all": open everything only when nothing is open, else close everything. */
export const foldAllTarget = (openFlags) => !openFlags.some(Boolean);

export const isSectionOpen = (prefs, key) => (typeof prefs?.[key] === 'boolean' ? prefs[key] : SECTIONS[key]?.open ?? false);

/** New prefs with one section set; only values that differ from the default are kept, so the stored blob stays tiny. */
export function withSection(prefs, key, open) {
  if (!SECTIONS[key]) return { ...prefs };
  const next = { ...prefs };
  if (open === SECTIONS[key].open) delete next[key];
  else next[key] = !!open;
  return next;
}

const usd0 = (n) => `${n < 0 ? '-' : n > 0 ? '+' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const usd = (n, d = 0) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;

/** One-line summary shown next to the section title while it is collapsed, e.g. "3 open · +$42". Empty string = no number yet. */
export function sectionSummary(key, d = {}) {
  switch (key) {
    case 'pos': {
      const n = d.openCount;
      if (n == null) return '';
      return n ? `${n} open${Number.isFinite(d.unrealized) ? ` · ${usd0(d.unrealized)}` : ''}` : 'none open';
    }
    case 'sum':
      return d.proposalCount == null ? '' : `${d.proposalCount} proposed`;
    case 'news':
      return d.text || '';
    case 'sched':
      return d.text || '';
    case 'review':
      return d.text || '';
    case 'fun':
      return d.text || '';
    case 'totw':
      return d.text || '';
    case 'cal':
      return d.text || '';
    case 'budget':
      return d.spentText && d.capText ? `${d.spentText} of ${d.capText}` : '';
    case 'picks':
      return d.picksCount == null ? '' : String(d.picksCount);
    case 'perf':
      return Number.isFinite(d.netEdge) ? `net edge ${usd0(d.netEdge)}` : d.closed === 0 ? 'no closed trades yet' : '';
    case 'alloc':
      return Number.isFinite(d.cashPct) ? `${Math.round(d.cashPct)}% cash` : '';
    default:
      return '';
  }
}

/** Accessible name for the toggle button. */
export function sectionLabel(key, summary) {
  const t = SECTIONS[key]?.title || key;
  return summary ? `${t}, ${summary}` : t;
}
export { usd };
