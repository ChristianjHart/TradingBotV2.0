/* Pure, DOM-free helpers for the model finder (filtering, sorting, price/estimate formatting, pagination).
   Importable from node:test. Strings returned are NOT HTML-escaped. */
import { fmtMoney } from './api.js';
import { validateModel } from './auth-logic.js';

export const PAGE_SIZE = 25;
export const BOTS = [
  { id: 'scanner', label: 'Scanner', field: 'scannerModel', hint: 'ranks the top picks' },
  { id: 'trader', label: 'Trader', field: 'traderModel', hint: 'proposes the trades' },
  { id: 'news', label: 'News', field: 'newsModel', hint: 'headlines and earnings notes' },
];

export const FREE_NOTES = [
  'Free models are rate-limited (often a few requests per minute and a daily cap), so a run can fail with “rate limited”.',
  'Free-model providers may log and train on your prompts. That is fine for paper trading with public market data; do not use them for anything private.',
  'Free models are often slower and less reliable at returning valid JSON than paid ones.',
];

const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export const priceKnown = (m) => n(m?.promptPerM) != null && n(m?.completionPerM) != null;

/** Cheapest-first sort key: a typical call is ~9:1 prompt to completion tokens. Unknown prices sort last. */
export function blendedPrice(m) {
  if (m?.isFree) return 0;
  if (!priceKnown(m)) return Infinity;
  return Number(m.promptPerM) * 0.9 + Number(m.completionPerM) * 0.1;
}

/** USD per 1M tokens -> "$0.15", "$0.0042", "Free", or "unknown". */
export function formatPrice(v, { free = false } = {}) {
  const x = n(v);
  if (x == null) return free ? 'Free' : 'unknown';
  if (x === 0) return 'Free';
  if (x >= 100) return `$${x.toFixed(0)}`;
  if (x >= 1) return `$${x.toFixed(2)}`;
  if (x >= 0.01) return `$${x.toFixed(3).replace(/0$/, '')}`;
  return `$${x.toPrecision(2)}`;
}

/** 131072 -> "131k", 1000000 -> "1M". */
export function formatContext(v) {
  const x = n(v);
  if (x == null || x <= 0) return '—';
  if (x >= 1_000_000) return `${+(x / 1_000_000).toFixed(1)}M`;
  if (x >= 1000) return `${Math.round(x / 1000)}k`;
  return String(x);
}

/** Cheapest first; ties by name; unknown price last. Returns a new array. */
export function sortModels(models) {
  return [...(models || [])].sort((a, b) => {
    const pa = blendedPrice(a);
    const pb = blendedPrice(b);
    if (pa !== pb) return pa === Infinity ? 1 : pb === Infinity ? -1 : pa - pb;
    return String(a.name || a.id).localeCompare(String(b.name || b.id));
  });
}

/**
 * Filter by text (every word must match id or name), free-only, and a max price per 1M tokens (applies to the dearer of
 * prompt/completion; models with an unknown price are excluded when a max is set, since we cannot vouch for them).
 */
export function filterModels(models, { q = '', freeOnly = false, maxPrice = null } = {}) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const max = n(maxPrice);
  return (models || []).filter((m) => {
    if (freeOnly && !m.isFree) return false;
    if (max != null && !(m.isFree || (priceKnown(m) && Math.max(Number(m.promptPerM), Number(m.completionPerM)) <= max))) return false;
    if (!words.length) return true;
    const hay = `${m.id} ${m.name || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function paginate(list, page = 1, size = PAGE_SIZE) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, page), pages);
  return { items: list.slice((p - 1) * size, p * size), page: p, pages, total, from: total ? (p - 1) * size + 1 : 0, to: Math.min(total, p * size) };
}

/** "Free", "$0.15 in / $0.60 out per 1M", or "price unknown". */
export function priceLine(m) {
  if (m?.isFree) return 'Free';
  if (!priceKnown(m)) return 'price unknown';
  return `${formatPrice(m.promptPerM)} in / ${formatPrice(m.completionPerM)} out per 1M`;
}

/** Same rule as the Account form (vendor/model[:variant]). */
export const validModelId = (id) => typeof id === 'string' && validateModel(id.trim()) === null;

const money4 = (v) => (v == null ? '—' : fmtMoney(v, v !== 0 && Math.abs(v) < 0.1 ? 4 : 2));
const count = (v) => (v == null ? '—' : Math.round(v).toLocaleString());

/**
 * Format /api/models/estimate. One bot call is `estCostPerRunUsd`; a full RUN = scanner + trader (see combineEstimates).
 * @returns {{priceKnown:boolean, free:boolean, perCallText:string, runsText:string, runsRemainingText:string, basisText:string, tokensText:string}}
 */
export function estimateView(est) {
  if (!est) return { priceKnown: false, free: false, perCallText: '—', runsText: '—', runsRemainingText: '—', basisText: '', tokensText: '' };
  const free = !!est.isFree;
  const known = free || est.priceKnown !== false;
  const cost = n(est.estCostPerRunUsd);
  const tok = est.tokens;
  return {
    priceKnown: known,
    free,
    perCallText: free ? 'Free' : !known || cost == null ? 'unknown (no price listed)' : `≈ ${money4(cost)} per call`,
    runsText: free ? 'Not limited by budget (rate limits apply)' : est.estRunsPerMonthAtBudget == null ? '—' : `≈ ${count(est.estRunsPerMonthAtBudget)} calls/month at ${money4(est.capUsd)}`,
    runsRemainingText: free || est.estRunsWithinRemaining == null ? '' : `≈ ${count(est.estRunsWithinRemaining)} left this month`,
    basisText: est.basis === 'measured' ? `based on ${tok?.samples ?? 0} of your past calls` : 'based on typical token counts (no history for this bot yet)',
    tokensText: tok ? `${count(tok.prompt)} in + ${count(tok.completion)} out tokens` : '',
  };
}

/**
 * A full RUN is one scanner call plus one trader call. Combine the two per-call estimates (either may be for a candidate model).
 * Unknown price on either side => unknown total.
 */
export function combineEstimates(a, b, { capUsd, remainingUsd } = {}) {
  if (!a || !b) return { known: false, free: false, costUsd: null, runsPerMonth: null, runsRemaining: null, text: '—' };
  const free = !!a.isFree && !!b.isFree;
  const ca = a.isFree ? 0 : n(a.estCostPerRunUsd);
  const cb = b.isFree ? 0 : n(b.estCostPerRunUsd);
  if (ca == null || cb == null) return { known: false, free: false, costUsd: null, runsPerMonth: null, runsRemaining: null, text: 'unknown (a model has no listed price)' };
  const cost = ca + cb;
  const cap = n(capUsd ?? a.capUsd);
  const rem = n(remainingUsd ?? a.remainingUsd);
  const runsPerMonth = cost > 0 && cap != null ? Math.floor(cap / cost) : null;
  const runsRemaining = cost > 0 && rem != null ? Math.floor(rem / cost) : null;
  const text = free ? 'Free (rate limits apply)' : `≈ ${money4(cost)} per run · ≈ ${runsPerMonth == null ? '—' : runsPerMonth.toLocaleString()} runs/month at ${money4(cap)}`;
  return { known: true, free, costUsd: cost, runsPerMonth, runsRemaining, text };
}

/** Which model is currently selected for a bot (falls back to the default). */
export function currentModel(models, botId) {
  const sel = models?.[botId];
  return sel || models?.defaults?.[botId] || '';
}

export const isDefault = (models, botId) => !!models?.defaults?.[botId] && currentModel(models, botId) === models.defaults[botId];

/** Status line for the catalog: stale / error states. */
export function catalogStatus(res, err) {
  if (err) {
    if (err.code === 'catalog_unavailable' || err.status === 502) return { kind: 'unavailable', text: 'The OpenRouter model list can’t be loaded right now, and nothing is cached. You can still type a model id below.' };
    if (err.network) return { kind: 'offline', text: 'Can’t reach the server.' };
    return { kind: 'error', text: err.message || 'Could not load the model list.' };
  }
  if (res?.stale) return { kind: 'stale', text: `Showing a cached model list${res.error ? ` (refresh failed: ${res.error})` : ''}. Prices may be out of date.` };
  return { kind: 'ok', text: '' };
}
