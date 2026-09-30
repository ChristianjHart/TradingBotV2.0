// NEWS & EARNINGS bot: an OPTIONAL context stage between the scanner and the trader. It never trades and never blocks a run:
// when it cannot run (disabled, no Alpaca credentials, no data, budget, AI error) the run continues WITHOUT notes and the run record says why.
// There is no rule-based fallback for trading; this stage only adds structured context the trader (and the server-side guard) can use.
import { config, hasFinnhubKey, hasAlpacaCredentials, scrubSecrets } from '../config.js';
import { store } from '../db/store.js';
import { upsert } from '../db/supabase.js';
import { chatJson } from './openrouter.js';
import { getHeadlines } from './news.js';
import { getEarnings } from './finnhub.js';
import { mockLlmEnabled } from './mockLlm.js';
import { mockNewsEnabled } from './mockNews.js';
import { estimateCallCostUsd, checkBudget } from './spend.js';
import { isCrypto } from './market.js';
import { newsSettings, cleanText, buildNewsPrompt, validateNotes, NEWS_SYSTEM } from './newsNotes.js';

const MAX_SAVED = 3000;
const iso = (ms = Date.now()) => new Date(ms).toISOString();

const emptyNews = (status, reason, extra = {}) => ({ status, reason, symbols: 0, headlines: 0, earningsKnown: 0, costUsd: 0, notes: 0, ...extra });

/** Candidates for the news stage: the trader's own candidate filter (no open positions, no crypto shorts), best confidence first, top N. */
export function shortlistFrom(picks, maxSymbols) {
  const open = new Set(store.getPositions().filter((p) => p.status === 'open').map((p) => p.symbol));
  const seen = new Set();
  return (Array.isArray(picks) ? picks : [])
    .filter((p) => p && typeof p.symbol === 'string' && !open.has(p.symbol) && !(p.direction === 'short' && isCrypto(p.symbol)))
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .filter((p) => (seen.has(p.symbol) ? false : (seen.add(p.symbol), true)))
    .slice(0, maxSymbols)
    .map((p) => p.symbol);
}

function saveNotes(notes, { runId, model }) {
  if (!notes.length) return [];
  const at = iso();
  const rows = notes.map((n) => ({ id: `note_${runId}_${n.symbol.replace(/\W/g, '')}`, runId, at, model, ...n }));
  const ids = new Set(rows.map((r) => r.id));
  store.setResearch([...rows, ...store.getResearch().filter((r) => !ids.has(r.id))].slice(0, MAX_SAVED));
  for (const r of rows) upsert('research_notes', { id: r.id, run_id: runId, symbol: r.symbol, at, raw: r, updated_at: at });
  return rows;
}

/**
 * Run the news stage. NEVER throws. Returns { notes (validated, in-memory), news (run-record object), usage|null, model }.
 * news = { status:'ok'|'partial'|'skipped'|'error', reason, symbols, headlines, earningsKnown, costUsd, notes }.
 */
export async function runNewsStage(picks, { runId = `run_${Date.now()}` } = {}) {
  const settings = store.getSettings();
  const ns = newsSettings(settings);
  const out = (news, notes = [], usage = null, model = null) => ({ notes, news, usage, model });
  try {
    if (!ns.enabled) return out(emptyNews('skipped', 'news stage is turned off in Settings'));
    const symbols = shortlistFrom(picks, ns.maxSymbols);
    if (!symbols.length) return out(emptyNews('skipped', 'no candidate symbols to research'));
    const mockNews = mockNewsEnabled();
    if (!mockNews && !hasAlpacaCredentials()) return out(emptyNews('skipped', 'no Alpaca credentials: headlines cannot be fetched (the run continues without news notes)', { symbols: symbols.length }));

    // Budget: the trader call must still fit after this one. If not, skip news (the trader's own gate decides about itself).
    if (!mockLlmEnabled()) {
      try {
        const est = estimateCallCostUsd({ bot: 'news', model: config.openrouter.newsModel }) + estimateCallCostUsd({ bot: 'trader', model: config.openrouter.traderModel });
        checkBudget(est);
      } catch (err) {
        if (err?.code === 'budget_exhausted') return out(emptyNews('skipped', 'AI budget too low to also run the news stage (kept for the trader); the run continues without news notes', { symbols: symbols.length }));
        throw err;
      }
    }

    const [news, earn] = await Promise.all([getHeadlines(symbols), getEarnings(symbols)]);
    const problems = [];
    if (!news.available) return out(emptyNews('skipped', 'no Alpaca credentials: headlines cannot be fetched', { symbols: symbols.length }));
    if (news.failedBatches) problems.push(`headline fetch failed for some symbols (${cleanText(scrubSecrets(news.error || ''), 80)})`);
    if (!earn.available || (earn.failed && !earn.known)) problems.push(!hasFinnhubKey() && !mockNews ? 'no Finnhub key: earnings dates unknown (headlines only)' : `earnings calendar unavailable (${cleanText(scrubSecrets(earn.error || ''), 80)})`);
    else if (earn.failed) problems.push(`earnings lookup failed for ${earn.failed} symbol(s)`);

    // Shortlist for the model: stable short ids per headline; titles sanitised (untrusted); earnings days are authoritative server data.
    let n = 0;
    const shortlist = [];
    for (const symbol of symbols) {
      const headlines = (news.headlines.get(symbol) || [])
        .map((h) => ({ id: `n${++n}`, title: cleanText(h.title, 300), url: h.url, publishedAt: h.publishedAt, source: cleanText(h.source, 40) }))
        .filter((h) => h.title);
      const e = earn.earnings.get(symbol);
      const earningsInDays = e && Number.isFinite(e.inDays) ? e.inDays : null;
      if (headlines.length || earningsInDays !== null) shortlist.push({ symbol, earningsInDays, headlines });
    }
    const headlineCount = shortlist.reduce((s, x) => s + x.headlines.length, 0);
    const base = { symbols: symbols.length, headlines: headlineCount, earningsKnown: earn.known };
    if (!shortlist.length) return out(emptyNews(news.failedBatches ? 'error' : 'skipped', news.failedBatches ? `headline fetch failed: ${problems.join('; ')}` : 'no recent headlines or earnings dates for the shortlist', base));

    const ai = await chatJson({
      bot: 'news',
      model: config.openrouter.newsModel,
      system: NEWS_SYSTEM,
      user: buildNewsPrompt(shortlist),
      maxTokens: 6000,
      timeoutMs: 90_000,
      runId,
      validate: (json) => validateNotes(json, shortlist, { blackoutDays: ns.earningsBlackoutDays }),
    });
    const { notes, dropped } = ai.value;
    saveNotes(notes, { runId, model: ai.model });
    if (dropped) problems.push(`${dropped} note(s) dropped by validation`);
    const status = problems.length ? 'partial' : 'ok';
    store.addLog({ level: 'info', message: `news bot (${ai.model}${ai.mock ? ', DEMO' : ''}): ${notes.length} notes for ${symbols.length} symbols, ${headlineCount} headlines${problems.length ? `; ${problems.join('; ')}` : ''}` });
    return out({ status, reason: problems.length ? problems.join('; ') : 'ok', ...base, costUsd: ai.usage?.costUsd ?? 0, notes: notes.length, model: ai.model, ...(ai.mock ? { demo: true } : {}) }, notes, ai.usage, ai.model);
  } catch (err) {
    const msg = cleanText(scrubSecrets(err?.message || 'news stage failed'), 200);
    const code = err?.code && typeof err.code === 'string' ? err.code : 'news_failed';
    store.addLog({ level: 'warn', message: `news bot could not run (${code}): ${msg}; the run continues without news notes` });
    const spent = Number(err?.details?.costUsd) || 0; // a repaired-then-invalid call was still billed
    return out(emptyNews(code === 'budget_exhausted' ? 'skipped' : 'error', `${code}: ${msg}`, { costUsd: spent }), [], spent ? { costUsd: spent, calls: err.details?.calls || 1, costSource: 'estimated' } : null);
  }
}
