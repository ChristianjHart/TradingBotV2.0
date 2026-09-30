/* Pure, DOM-free helpers for the news & earnings bot (notes, chips, run status, settings validation).
   Strings returned are NOT HTML-escaped; callers escape. All note/LLM/news text is untrusted. */

export const FLAGS = ['earnings_imminent', 'guidance_risk', 'legal', 'regulatory', 'halt', 'offering', 'macro', 'rumor', 'low_confidence'];
const FLAG_TEXT = {
  earnings_imminent: 'Earnings imminent',
  guidance_risk: 'Guidance risk',
  legal: 'Legal',
  regulatory: 'Regulatory',
  halt: 'Trading halt',
  offering: 'Stock offering',
  macro: 'Macro event',
  rumor: 'Rumor',
  low_confidence: 'Low confidence',
};
const FLAG_HELP = {
  earnings_imminent: 'Earnings are about to be reported',
  guidance_risk: 'The company may change its outlook',
  legal: 'Lawsuit or investigation news',
  regulatory: 'Regulator or government action',
  halt: 'Trading halted or suspended',
  offering: 'New shares being sold (dilution)',
  macro: 'A market-wide event affects it',
  rumor: 'Unconfirmed reports',
  low_confidence: 'The AI is unsure about this note',
};
export const flagLabel = (f) => FLAG_TEXT[f] || String(f || '').replace(/_/g, ' ').slice(0, 40);
export const flagHelp = (f) => FLAG_HELP[f] || '';
export const DEFAULT_BLOCKING = ['halt', 'legal'];

/** Only plain http(s) URLs may become links; anything else (javascript:, data:, relative, garbage) gives ''. */
export function safeUrl(u) {
  const s = String(u ?? '').trim();
  if (!s || s.length > 2000) return '';
  try {
    const p = new URL(s);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : '';
  } catch {
    return '';
  }
}
export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Sentiment -1..1 -> label + tone + bar geometry. Not colour-only: the label and signed number are always shown. */
export function sentimentView(s) {
  const n = Number(s);
  if (s == null || s === '' || !Number.isFinite(n)) return { known: false, label: 'Sentiment unknown', tone: 'off', text: '', pct: 50, fillLeft: 50, fillWidth: 0 };
  const v = Math.max(-1, Math.min(1, n));
  const label = v >= 0.6 ? 'Very positive' : v >= 0.2 ? 'Positive' : v > -0.2 ? 'Neutral' : v > -0.6 ? 'Negative' : 'Very negative';
  const tone = v >= 0.2 ? 'ok' : v <= -0.2 ? 'bad' : 'off';
  const half = Math.abs(v) * 50;
  return { known: true, label, tone, text: `${v > 0 ? '+' : ''}${v.toFixed(2)}`, pct: 50 + v * 50, fillLeft: v >= 0 ? 50 : 50 - half, fillWidth: half };
}

/** earningsInDays (number|null) -> chip or null. `soon` = within the blackout window (or <= 3 days when unset). */
export function earningsChip(days, blackoutDays = 2) {
  if (days == null || days === '' || !Number.isFinite(Number(days))) return null;
  const d = Math.round(Number(days));
  if (d < 0) return null;
  const text = d === 0 ? 'Earnings today' : d === 1 ? 'Earnings tomorrow' : `Earnings in ${d} days`;
  const soon = d <= Math.max(Number(blackoutDays) || 0, 2);
  return { text, days: d, soon, tone: soon ? 'warn' : 'off' };
}

/** Flag ids -> [{id,label,help,blocking}] (unknown ids dropped except shown as text; de-duplicated; max 9). */
export function flagChips(flags, blocking = DEFAULT_BLOCKING) {
  const out = [];
  for (const f of Array.isArray(flags) ? flags : []) {
    const id = String(f || '');
    if (!id || out.some((x) => x.id === id)) continue;
    out.push({ id, label: flagLabel(id), help: flagHelp(id), blocking: blocking.includes(id) });
    if (out.length >= 9) break;
  }
  return out;
}

const clip = (s, n) => String(s ?? '').slice(0, n);

/** A research note -> card model. */
export function noteView(n, { blackoutDays = 2, blocking = DEFAULT_BLOCKING } = {}) {
  const sources = (Array.isArray(n?.sources) ? n.sources : []).slice(0, 8).map((s) => {
    const url = safeUrl(s?.url);
    return { title: clip(s?.title, 200) || hostOf(url) || 'Source', url, host: hostOf(url), publishedAt: s?.publishedAt || null };
  });
  const earnings = earningsChip(n?.earningsInDays, blackoutDays);
  const flags = flagChips(n?.riskFlags, blocking);
  return {
    symbol: clip(n?.symbol, 24) || '?',
    runId: n?.runId || '',
    at: n?.at || '',
    sentiment: sentimentView(n?.sentiment),
    catalyst: clip(n?.catalyst, 200),
    summary: clip(n?.summary, 1200),
    earnings,
    flags,
    sources,
    soon: !!earnings?.soon,
    flagged: flags.length > 0,
    blocked: flags.some((f) => f.blocking),
  };
}

export const NEWS_FILTERS = [
  ['all', 'All'],
  ['flagged', 'Risk flags'],
  ['earnings', 'Earnings soon'],
];
/** filter views by id; flagged sort first, then earnings soon, then symbol. */
export function filterNotes(views, filter = 'all') {
  const list = filter === 'flagged' ? views.filter((v) => v.flagged) : filter === 'earnings' ? views.filter((v) => v.soon) : views;
  return [...list].sort((a, b) => Number(b.blocked) - Number(a.blocked) || Number(b.soon) - Number(a.soon) || Number(b.flagged) - Number(a.flagged) || a.symbol.localeCompare(b.symbol));
}

/** 'News · 20 notes · 1 earnings soon' pieces for the collapsed header. */
export function newsSummaryText(views) {
  if (!views) return '';
  const n = views.length;
  if (!n) return 'no notes yet';
  const soon = views.filter((v) => v.soon).length;
  const flagged = views.filter((v) => v.flagged).length;
  return `${n} note${n === 1 ? '' : 's'}${soon ? ` · ${soon} earnings soon` : ''}${!soon && flagged ? ` · ${flagged} flagged` : ''}`;
}

/** run.news -> {tone:'ok'|'warn'|'bad'|'off', title, text, link?}. Skipped / partial / error must be obvious. */
export function newsRunStatus(news) {
  if (!news || typeof news !== 'object') return null;
  const reason = clip(news.reason, 300);
  const counts = `${Number(news.symbols) || 0} symbols, ${Number(news.headlines) || 0} headlines, earnings known for ${Number(news.earningsKnown) || 0}`;
  const finnhub = /finnhub/i.test(reason);
  const link = /finnhub|alpaca|key|credential/i.test(reason) ? { href: '#settings/account', label: 'Settings → Account' } : /budget/i.test(reason) ? { href: '#settings/budget', label: 'Settings → AI budget' } : /turned off|disabled/i.test(reason) ? { href: '#settings/news', label: 'Settings → News' } : null;
  switch (news.status) {
    case 'ok':
      return { tone: 'ok', title: 'News: done', text: counts, link: null, demo: !!news.demo };
    case 'partial':
      return { tone: 'warn', title: 'News: partial', text: finnhub ? 'No Finnhub key: earnings dates unknown. Add it in Settings → Account.' : reason ? `${reason}. ${counts}` : counts, link: finnhub ? { href: '#settings/account', label: 'Add Finnhub key' } : link, demo: !!news.demo };
    case 'skipped':
      return { tone: 'warn', title: 'News: skipped', text: reason || 'The news step did not run. The trader ran without news notes.', link, demo: !!news.demo };
    case 'error':
      return { tone: 'bad', title: 'News: failed', text: `${reason || 'The news step failed.'} The trader ran without news notes.`, link, demo: !!news.demo };
    default:
      return null;
  }
}

/** Proposal's news context: earnings chip, flag chips, AI note text. */
export function proposalNews(p, { blackoutDays = 2, blocking = DEFAULT_BLOCKING } = {}) {
  const note = typeof p?.notes === 'string' ? p.notes : typeof p?.notes?.summary === 'string' ? p.notes.summary : '';
  return { earnings: earningsChip(p?.earningsInDays, blackoutDays), flags: flagChips(p?.riskFlags, blocking), note: clip(note, 600) };
}

/** History: explain an automatic (server-side) rejection. '' when not one. */
export function autoRejectText(p) {
  if (p?.status !== 'rejected' || p?.decidedBy !== 'system') return '';
  const r = String(p.rejectReason || '');
  if (r === 'earnings blackout') {
    const d = p.earningsInDays;
    return `Auto-rejected: earnings blackout${Number.isFinite(Number(d)) && d !== null ? ` (earnings ${Number(d) === 0 ? 'today' : Number(d) === 1 ? 'tomorrow' : `in ${Number(d)} days`})` : ''}. The AI proposed it, but the safety check blocked it.`;
  }
  const m = /^news risk flag: (.+)$/.exec(r);
  if (m) return `Auto-rejected: news risk flag “${flagLabel(m[1].trim())}”. The AI proposed it, but the safety check blocked it.`;
  return '';
}

/** News settings form (strings/bools) -> {ok, errors, value} for PATCH settings.news. */
export function validateNewsSettings(f) {
  const errors = {};
  const num = (raw, min, max, label) => {
    const s = String(raw ?? '').trim();
    if (!s || !Number.isFinite(Number(s))) return { error: `${label}: enter a whole number.` };
    const v = Number(s);
    if (!Number.isInteger(v)) return { error: `${label}: use a whole number.` };
    if (v < min || v > max) return { error: `${label} must be between ${min} and ${max}.` };
    return { value: v };
  };
  const ms = num(f.maxSymbols, 1, 60, 'Symbols per run');
  const bd = num(f.earningsBlackoutDays, 0, 10, 'Blackout days');
  if (ms.error) errors.maxSymbols = ms.error;
  if (bd.error) errors.earningsBlackoutDays = bd.error;
  const flags = (Array.isArray(f.blockingFlags) ? f.blockingFlags : []).filter((x) => FLAGS.includes(x));
  return {
    ok: !Object.keys(errors).length,
    errors,
    value: { enabled: !!f.enabled, maxSymbols: ms.value, earningsBlackoutDays: bd.value, allowEarningsTrades: !!f.allowEarningsTrades, blockingFlags: [...new Set(flags)] },
  };
}

/** Finnhub key field: trimmed value -> {payload, error}. */
export function buildFinnhubPayload(raw) {
  const k = String(raw ?? '').trim();
  if (!k) return { payload: null, error: 'Paste your Finnhub API key.' };
  if (/\s/.test(k) || k.length < 8 || k.length > 200) return { payload: null, error: 'That does not look like a Finnhub key (no spaces, at least 8 characters).' };
  return { payload: { finnhubKey: k }, error: '' };
}
