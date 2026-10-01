/* Pure helpers for the collapsible dashboard sections on phones (no DOM, no storage access here). */

/** key -> {title, open by default}. Order is the on-screen order on phones after Proposals. */
export const SECTIONS = {
  pos: { title: 'Positions', open: true },
  sum: { title: 'AI summary', open: false },
  news: { title: 'News & earnings', open: false },
  sched: { title: 'Schedule', open: false },
  fun: { title: 'Achievements', open: false },
  totw: { title: 'Trade of the week', open: false },
  cal: { title: 'Calendar', open: false },
  budget: { title: 'Budget', open: false },
  picks: { title: 'Top picks', open: false },
  perf: { title: 'Performance', open: false },
  acc: { title: 'Model accuracy', open: false },
  alloc: { title: 'Allocation', open: false },
};
export const SECTION_KEYS = Object.keys(SECTIONS);
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
    case 'acc':
      return d.closed ? `${Math.round(d.winRatePct)}% win rate` : 'no closed trades';
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
