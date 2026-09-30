// AI cost ledger + monthly budget governor. Every model call is recorded (locally, atomically, and mirrored to Supabase
// `ai_spend`); before each call its cost is estimated and the call is refused (budget_exhausted) if month-to-date + estimate
// would exceed the hard cap. The month is the UTC calendar month.
import { store } from '../db/store.js';
import { upsert } from '../db/supabase.js';
import { config } from '../config.js';
import { AiError } from './aiErrors.js';
import { catalogEntry } from './catalog.js';

export const BOTS = ['scanner', 'trader', 'news', 'other'];
export const WARN_PCT = 70;

/** Typical tokens per call when nothing has been measured yet. */
export const DEFAULT_TOKENS = {
  scanner: { prompt: 6000, completion: 4000 },
  trader: { prompt: 3000, completion: 1000 },
  news: { prompt: 4000, completion: 1000 },
  other: { prompt: 2000, completion: 500 },
};
/** Conservative price (USD per 1M tokens) used to ESTIMATE when a model is not in the catalog (never used for reported costs). */
export const FALLBACK_PRICE = { promptPerM: 3, completionPerM: 15 };

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const num = (v) => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---- month helpers (UTC) ----
export const monthStart = (now = Date.now()) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
export const nextMonthStart = (now = Date.now()) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

export function budgetCapUsd() {
  const s = num(store.getSettings().monthlyAiBudgetUsd);
  return s !== null && s >= 0 ? s : config.ai.monthlyBudgetUsd;
}

// ---- pricing ----
/** Price (USD per 1M tokens) for a model: catalog entry, else free for ":free", else null (unknown). */
export function priceOf(model) {
  const e = catalogEntry(model);
  if (e && e.promptPerM !== null && e.completionPerM !== null) return { promptPerM: e.promptPerM, completionPerM: e.completionPerM, known: true };
  if (typeof model === 'string' && model.endsWith(':free')) return { promptPerM: 0, completionPerM: 0, known: true };
  return null;
}

export const costFromTokens = (price, promptTokens, completionTokens) => round6((promptTokens * price.promptPerM + completionTokens * price.completionPerM) / 1e6);
export const estimateTokensFromChars = (chars) => Math.ceil(Math.max(0, chars) / 3.5);

// ---- ledger ----
const rowFor = (e) => ({
  id: e.id,
  ts: e.ts,
  bot: e.bot,
  model: e.model,
  prompt_tokens: e.promptTokens,
  completion_tokens: e.completionTokens,
  cost_usd: e.costUsd,
  cost_source: e.costSource,
  run_id: e.runId ?? null,
  ok: e.ok,
});

/** Append one call to the ledger (local file + Supabase mirror). Returns the stored entry. */
export function recordSpend({ bot, model, promptTokens = 0, completionTokens = 0, costUsd = 0, costSource = 'estimated', ok = true, runId = null, ts = new Date().toISOString(), id, mock = false }) {
  const entry = {
    id: id || `spend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts,
    bot: BOTS.includes(bot) ? bot : 'other',
    model: String(model || 'unknown').slice(0, 100),
    promptTokens: Math.max(0, Math.round(promptTokens) || 0),
    completionTokens: Math.max(0, Math.round(completionTokens) || 0),
    costUsd: round6(Math.max(0, Number(costUsd) || 0)),
    costSource: costSource === 'reported' ? 'reported' : 'estimated',
    ok: Boolean(ok),
    runId: runId ?? null,
    ...(mock ? { mock: true } : {}),
  };
  store.setSpend([...store.getSpend(), entry]);
  if (!mock) upsert('ai_spend', rowFor(entry)); // demo calls are free and never pollute the shared ledger
  return entry;
}

const inMonth = (e, now) => {
  const t = Date.parse(e.ts);
  return t >= monthStart(now) && t < nextMonthStart(now);
};

export function monthToDateUsd(now = Date.now()) {
  return round6(store.getSpend().filter((e) => inMonth(e, now)).reduce((s, e) => s + (e.costUsd || 0), 0));
}

/** Recent ok, measured calls for a bot (optionally one model), newest last. */
function recentOk(bot, model, n = 20) {
  const all = store.getSpend().filter((e) => e.ok && !e.mock && e.bot === bot && e.promptTokens + e.completionTokens > 0);
  const same = model ? all.filter((e) => e.model === model) : [];
  return { same: same.slice(-n), any: all.slice(-n) };
}

const avg = (list, f) => (list.length ? list.reduce((s, e) => s + f(e), 0) / list.length : null);

/** Measured average tokens per call for a bot (any model), or the default. */
export function tokenProfile(bot) {
  const { any } = recentOk(bot, null);
  if (any.length) return { prompt: Math.round(avg(any, (e) => e.promptTokens)), completion: Math.round(avg(any, (e) => e.completionTokens)), basis: 'measured', samples: any.length };
  return { ...(DEFAULT_TOKENS[bot] || DEFAULT_TOKENS.other), basis: 'default', samples: 0 };
}

/**
 * Estimated cost of ONE call before making it (governor input): tokens from the actual prompt size and the measured (else default)
 * output size, priced from the catalog (unknown non-free models use a conservative fallback price); if this bot+model has a
 * measured average cost the larger of the two wins.
 */
export function estimateCallCostUsd({ bot, model, promptChars = 0, maxTokens }) {
  const price = priceOf(model) || FALLBACK_PRICE;
  const prof = tokenProfile(bot);
  const inTok = promptChars ? estimateTokensFromChars(promptChars) : prof.prompt;
  let outTok = prof.completion;
  if (Number.isFinite(maxTokens) && maxTokens > 0) outTok = Math.min(outTok, maxTokens);
  const computed = costFromTokens(price, inTok, outTok);
  const { same } = recentOk(bot, model, 10);
  const measured = same.length ? avg(same, (e) => e.costUsd) : null;
  return round6(measured !== null ? Math.max(computed, measured) : computed);
}

/** Throws AiError budget_exhausted when month-to-date + estimate would exceed the cap. */
export function checkBudget(estimateUsd, { now = Date.now() } = {}) {
  const cap = budgetCapUsd();
  const spent = monthToDateUsd(now);
  if (spent + estimateUsd > cap + 1e-9) {
    throw new AiError(
      'budget_exhausted',
      `monthly AI budget reached: $${spent.toFixed(4)} spent of $${cap.toFixed(2)} (this call is estimated at $${estimateUsd.toFixed(4)}). It resets ${new Date(nextMonthStart(now)).toISOString().slice(0, 10)} (UTC), or raise the budget under Settings.`,
      { details: { capUsd: cap, spentUsd: spent, estimateUsd, resetsAt: new Date(nextMonthStart(now)).toISOString() } },
    );
  }
  return { capUsd: cap, spentUsd: spent, estimateUsd };
}

/** GET /api/budget payload. */
export function budgetStatus({ now = Date.now() } = {}) {
  const cap = budgetCapUsd();
  const ledger = store.getSpend();
  const month = ledger.filter((e) => inMonth(e, now));
  const spent = round6(month.reduce((s, e) => s + (e.costUsd || 0), 0));
  const pct = cap > 0 ? Math.round((spent / cap) * 1000) / 10 : spent > 0 ? 100 : 0;
  const level = spent >= cap ? 'blocked' : pct >= WARN_PCT ? 'warn' : 'ok';
  const byBot = Object.fromEntries(BOTS.map((b) => [b, { usd: 0, calls: 0, promptTokens: 0, completionTokens: 0 }]));
  const byModel = {};
  for (const e of month) {
    const b = byBot[e.bot] || byBot.other;
    b.usd = round6(b.usd + e.costUsd);
    b.calls += 1;
    b.promptTokens += e.promptTokens;
    b.completionTokens += e.completionTokens;
    const m = (byModel[e.model] ||= { usd: 0, calls: 0 });
    m.usd = round6(m.usd + e.costUsd);
    m.calls += 1;
  }
  const last7d = [];
  const dayMs = 86_400_000;
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  for (let i = 6; i >= 0; i--) {
    const d = today - i * dayMs;
    const key = dayKey(d);
    last7d.push({ day: key, usd: round6(ledger.filter((e) => String(e.ts).slice(0, 10) === key).reduce((s, e) => s + (e.costUsd || 0), 0)) });
  }
  const withRun = month.filter((e) => e.runId);
  const runIds = new Set(withRun.map((e) => e.runId));
  const startMs = monthStart(now);
  const daysInMonth = (nextMonthStart(now) - startMs) / dayMs;
  const elapsedDays = Math.max((now - startMs) / dayMs, 1);
  return {
    capUsd: cap,
    spentUsd: spent,
    remainingUsd: round6(Math.max(0, cap - spent)),
    pct,
    resetsAt: new Date(nextMonthStart(now)).toISOString(),
    month: new Date(startMs).toISOString().slice(0, 7),
    byBot,
    byModel,
    last7d,
    avgCostPerRun: runIds.size ? round6(withRun.reduce((s, e) => s + e.costUsd, 0) / runIds.size) : null,
    projectedMonthEndUsd: round6((spent / elapsedDays) * daysInMonth),
    estimatedShare: month.length ? Math.round((month.filter((e) => e.costSource === 'estimated').length / month.length) * 100) / 100 : 0,
    level,
  };
}

/** Compact object for /api/status. */
export function budgetCompact(now = Date.now()) {
  const b = budgetStatus({ now });
  return { capUsd: b.capUsd, spentUsd: b.spentUsd, remainingUsd: b.remainingUsd, pct: b.pct, level: b.level, resetsAt: b.resetsAt };
}

// ---- rebuild after a redeploy (ephemeral disk) ----
const tableMissing = (err) => /PGRST205|Could not find the table|does not exist/i.test(String(err?.message));

/** Merge remote rows into the local ledger by id (never duplicates). Returns how many were added. */
export function mergeSpend(entries) {
  const local = store.getSpend();
  const seen = new Set(local.map((e) => e.id));
  const add = entries.filter((e) => e && e.id && !seen.has(e.id));
  if (!add.length) return 0;
  store.setSpend([...local, ...add].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)));
  return add.length;
}

/**
 * Restore month-to-date spend from Supabase so a redeploy can never reset the budget to zero: `ai_spend` first; when that table is
 * missing, from ai_logs.usage (which also carries the cost). `select(table, query)` is injected (defaults to the Supabase client).
 * Returns { source: 'ai_spend'|'ai_logs'|'none', added }.
 */
export async function rebuildSpendFromRemote(select, { now = Date.now() } = {}) {
  const since = new Date(monthStart(now)).toISOString();
  try {
    const rows = await select('ai_spend', `select=*&ts=gte.${encodeURIComponent(since)}&order=ts.asc&limit=5000`);
    const added = mergeSpend(
      rows.map((r) => ({
        id: String(r.id),
        ts: new Date(r.ts).toISOString(),
        bot: BOTS.includes(r.bot) ? r.bot : 'other',
        model: r.model || 'unknown',
        promptTokens: Number(r.prompt_tokens) || 0,
        completionTokens: Number(r.completion_tokens) || 0,
        costUsd: Number(r.cost_usd) || 0,
        costSource: r.cost_source === 'reported' ? 'reported' : 'estimated',
        ok: r.ok !== false,
        runId: r.run_id ?? null,
      })),
    );
    return { source: 'ai_spend', added };
  } catch (err) {
    if (!tableMissing(err)) throw err;
  }
  try {
    const rows = await select('ai_logs', `select=id,ts,bot,model,usage,ok&ts=gte.${encodeURIComponent(since)}&order=ts.asc&limit=5000`);
    const added = mergeSpend(
      rows
        .filter((r) => r.usage && typeof r.usage === 'object' && Number.isFinite(Number(r.usage.cost_usd)))
        .map((r) => ({
          id: `ailog_${r.id ?? Date.parse(r.ts)}`,
          ts: new Date(r.ts).toISOString(),
          bot: BOTS.includes(r.bot) ? r.bot : 'other',
          model: r.model || 'unknown',
          promptTokens: Number(r.usage.prompt_tokens) || 0,
          completionTokens: Number(r.usage.completion_tokens) || 0,
          costUsd: Number(r.usage.cost_usd) || 0,
          costSource: r.usage.cost_source === 'reported' ? 'reported' : 'estimated',
          ok: r.ok !== false,
          runId: r.usage.run_id ?? null,
        })),
    );
    return { source: 'ai_logs', added };
  } catch (err) {
    if (!tableMissing(err)) throw err;
    return { source: 'none', added: 0 };
  }
}
