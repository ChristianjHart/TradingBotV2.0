import { Router } from 'express';
import { store } from '../db/store.js';
import { alpaca } from '../services/alpaca.js';
import { config, hasAlpacaCredentials, hasOpenRouterKey, hasFinnhubKey } from '../config.js';
import { mockNewsEnabled } from '../services/mockNews.js';
import { newsSettings } from '../services/newsNotes.js';
import { supabaseEnabled } from '../db/supabase.js';
import { startAiRun, runState, aiStatus } from '../services/aiRun.js';
import { mockLlmEnabled } from '../services/mockLlm.js';
import { budgetStatus, budgetCompact, budgetCapUsd, priceOf, tokenProfile, costFromTokens } from '../services/spend.js';
import { getCatalog, filterModels, FREE_MODEL_NOTES } from '../services/catalog.js';
import { listProposals, approveProposal, rejectProposal, approveAll, ProposalError, STATUSES } from '../services/proposals.js';
import { listPositions, closeManually, closeAll } from '../services/positions.js';
import { computePerformance } from '../services/performance.js';
import { pickStats } from '../services/picks.js';
import { usMarketOpen } from '../services/market.js';
import { scheduleView, forecast as scheduleForecast, experiments as scheduleExperiments, activeForecast, testFire, slotsForDay, scheduleOf, etDayKey, mergeSchedule, PLANS } from '../services/scheduler.js';
import { rateLimit, validateSettings, validSymbol, asyncHandler } from '../middleware.js';
import { UNIVERSE } from '../services/universe.js';
import { resolveAuth, authGate, csrfGuard, setupGuard } from '../auth/index.js';
import { authRouter, accountRouter } from './auth.js';
import { computeGamify } from '../services/gamify.js';
import { tradeOfTheWeek } from '../services/highlights.js';
import { debateProposal } from '../services/debate.js';
import { validateWhatIf, runWhatIf } from '../services/whatif.js';
import { getCalendar } from '../services/calendar.js';
import { getMood } from '../services/mood.js';
import { personaList } from '../services/personas.js';
import { isAiError } from '../services/aiErrors.js';

const router = Router();

// Dashboard polling (GET, not market data) has its own generous bucket; everything else shares a tighter one.
// The credit-spending run trigger is tighter still and is not charged for 200 "already running" replies.
const pollLimit = rateLimit({ windowMs: 60_000, max: 1200, name: 'poll' });
const apiLimit = rateLimit({ windowMs: 60_000, max: 300, name: 'api' });
router.use((req, res, next) => (req.method === 'GET' && !req.path.startsWith('/market') ? pollLimit : apiLimit)(req, res, next));
const runLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, name: 'run', refundWhen: (res) => res.statusCode === 200 });
// The debate spends AI credits (cached results are free): tight window.
const debateLimit = rateLimit({ windowMs: 10 * 60_000, max: 20, name: 'debate' });
const AI_STATUS = { no_api_key: 409, budget_exhausted: 402, rate_limited: 429, model_unavailable: 502, invalid_output: 502, upstream_error: 502, timeout: 504 };

/** JSON error with the error's own HTTP status when it has one, else `fallback`. */
function sendError(res, err, fallback = 500) {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : fallback;
  res.status(status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
}
/** Market endpoints only serve the scanner universe plus open-position symbols (bounded caches, no arbitrary upstream calls). */
function marketSymbolError(symbol) {
  if (typeof symbol !== 'string' || !validSymbol(symbol)) return 'invalid symbol';
  if (UNIVERSE.includes(symbol)) return null;
  if (store.getPositions().some((p) => p.status === 'open' && p.symbol === symbol)) return null;
  return 'symbol not in the scanner universe or open positions';
}
const wantsForce = (req) => /^(1|true)$/i.test(String(req.query.force ?? req.body?.force ?? ''));

const accuracy = () => pickStats(store.getPickScores(), openPickCount());
const openPickCount = () => store.getPickScores().filter((r) => !r.scored).length;

// Order matters: CSRF -> who is calling -> public routes (health, /auth/*) -> gate -> everything else.
router.use(csrfGuard, resolveAuth);
router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    tradingEnabled: false,
    mode: 'predict',
    alpacaConfigured: hasAlpacaCredentials(),
    openrouterConfigured: hasOpenRouterKey(),
    finnhubConfigured: hasFinnhubKey(),
    supabaseConfigured: supabaseEnabled,
    mockData: alpaca.usingMock(),
    fallbacks: alpaca.getFallbacks(),
    mockLlm: mockLlmEnabled(), // true = MOCK_LLM test fixture active: everything the AI produces is DEMO DATA
    mockNews: mockNewsEnabled(), // true = MOCK_NEWS fixture active: headlines/earnings are canned
  });
});


router.use('/auth', authRouter);
router.use(setupGuard); // production with no account and no ADMIN_TOKEN: 503 setup_required (fail closed)
router.use(authGate); // from here on a valid session cookie or Bearer ADMIN_TOKEN is required (once an account or ADMIN_TOKEN exists)
router.use('/account', accountRouter);

// A stopped/killed worker must not spend credits or open positions: 409 (exits stay managed by the monitor).
router.post('/run', runLimit, (_req, res) => {
  const ws = store.getWorker().status;
  if (ws === 'stopped' || ws === 'killed') {
    return res.status(409).json({ error: `worker is ${ws}: start the worker before running the AI desk`, code: 'worker_not_running', workerStatus: ws });
  }
  const started = startAiRun({ trigger: { type: 'manual', plan: scheduleOf().plan } });
  res.status(started ? 202 : 200).json({ started, ...runState });
});

router.get('/run/status', (_req, res) => res.json(runState));

router.get('/runs', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
  res.json({ runs: store.getRuns().slice(0, limit).map((r) => ({ ...r, news: r.news ?? null, trigger: r.trigger ?? { type: 'manual', plan: null, slot: null, reason: null } })) });
});

router.get('/ai/summary', (_req, res) => res.json(store.getRunSummary() || {}));

router.get('/ai/picks', (_req, res) => res.json(store.getAiPicks()));

router.get('/performance', (_req, res) => {
  res.json(
    computePerformance({
      positions: store.getPositions(),
      snapshots: store.getEquity(),
      pickRecords: store.getPickScores(),
      proposals: store.getProposals(),
      settings: store.getSettings(),
      startingEquity: config.paperEquity,
    }),
  );
});

// ---- fun stuff: streaks & badges, trade of the week, what-if replay, calendar, market mood ----
router.get('/gamify', (_req, res) => {
  const positions = store.getPositions();
  const proposals = store.getProposals();
  const perf = computePerformance({ positions, snapshots: store.getEquity(), pickRecords: store.getPickScores(), proposals, settings: store.getSettings(), startingEquity: config.paperEquity });
  res.json(computeGamify({ positions, proposals, perf }));
});

router.get('/trade-of-the-week', (_req, res) => res.json(tradeOfTheWeek(store.getPositions())));

router.post('/whatif', asyncHandler(async (req, res) => {
  const { value, error } = validateWhatIf(req.body);
  if (error) return res.status(400).json({ error, code: 'invalid_params' });
  res.json(await runWhatIf(value));
}));

router.get('/calendar', asyncHandler(async (req, res) => res.json(await getCalendar({ days: req.query.days }))));

router.get('/mood', asyncHandler(async (_req, res) => res.json(await getMood())));

// ---- budget + model catalog ----
router.get('/budget', (_req, res) => res.json(budgetStatus()));

const truthy = (v) => /^(1|true|yes)$/i.test(String(v ?? ''));
const BOT_MODEL = { scanner: () => config.openrouter.scannerModel, trader: () => config.openrouter.traderModel, news: () => config.openrouter.newsModel };
const MODEL_ID = /^[\w.\-:/]{1,100}$/;

router.get('/models', asyncHandler(async (req, res) => {
  try {
    const c = await getCatalog();
    const models = filterModels(c.models, { free: truthy(req.query.free), q: req.query.q, maxPrice: req.query.maxPrice, limit: Number(req.query.limit) });
    res.json({
      models,
      count: models.length,
      total: c.models.length,
      fetchedAt: new Date(c.fetchedAt).toISOString(),
      stale: c.stale,
      ...(c.error ? { error: c.error } : {}),
      selected: { scanner: BOT_MODEL.scanner(), trader: BOT_MODEL.trader(), news: BOT_MODEL.news() },
      notes: FREE_MODEL_NOTES,
    });
  } catch (err) {
    res.status(502).json({ error: `model catalog unavailable: ${err.message}`, code: 'catalog_unavailable' });
  }
}));

router.get('/models/estimate', asyncHandler(async (req, res) => {
  const bot = String(req.query.bot ?? '');
  if (!Object.hasOwn(BOT_MODEL, bot)) return res.status(400).json({ error: "bot must be 'scanner', 'trader' or 'news'" });
  const model = req.query.model === undefined ? BOT_MODEL[bot]() : String(req.query.model);
  if (!MODEL_ID.test(model)) return res.status(400).json({ error: 'invalid model id' });
  await getCatalog().catch(() => null); // best effort; cached
  const price = priceOf(model);
  const prof = tokenProfile(bot);
  const est = price ? costFromTokens(price, prof.prompt, prof.completion) : null;
  const cap = budgetCapUsd();
  const remaining = budgetStatus().remainingUsd;
  const free = Boolean(price && price.promptPerM === 0 && price.completionPerM === 0);
  res.json({
    bot,
    model,
    basis: prof.basis, // 'measured' (average tokens of your recent calls) | 'default'
    tokens: { prompt: prof.prompt, completion: prof.completion, samples: prof.samples },
    priceKnown: Boolean(price),
    promptPerM: price ? price.promptPerM : null,
    completionPerM: price ? price.completionPerM : null,
    isFree: free,
    estCostPerRunUsd: est, // one call of this bot (a full RUN = scanner call + trader call + news call when the news stage is enabled)
    estRunsPerMonthAtBudget: est === null || est === 0 ? null : Math.floor(cap / est), // null = unlimited (free) or unknown price
    estRunsWithinRemaining: est === null || est === 0 ? null : Math.floor(remaining / est),
    capUsd: cap,
    remainingUsd: remaining,
    notes: [...(free ? FREE_MODEL_NOTES : []), ...(price ? [] : ['This model is not in the loaded catalog, so its price is unknown and the governor will assume a conservative price.'])],
  });
}));

// ---- news & earnings research notes ----
const RUN_ID = /^[\w.\-]{1,120}$/;
const pubNote = (n) => ({ symbol: n.symbol, runId: n.runId, at: n.at, sentiment: n.sentiment, catalyst: n.catalyst, earningsInDays: n.earningsInDays ?? null, riskFlags: n.riskFlags ?? [], summary: n.summary, sources: n.sources ?? [] });
router.get('/research', (req, res) => {
  const { runId, symbol } = req.query;
  if (runId !== undefined && (typeof runId !== 'string' || !RUN_ID.test(runId))) return res.status(400).json({ error: 'invalid runId', code: 'invalid_run_id' });
  if (symbol !== undefined && (typeof symbol !== 'string' || !validSymbol(symbol))) return res.status(400).json({ error: 'invalid symbol', code: 'invalid_symbol' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const canon = (s) => String(s).toUpperCase().replace('/', '');
  const notes = store.getResearch().filter((n) => (runId === undefined || n.runId === runId) && (symbol === undefined || canon(n.symbol) === canon(symbol))).slice(0, limit).map(pubNote);
  res.json({ notes, count: notes.length });
});
router.get('/research/latest', (_req, res) => {
  const seen = new Set();
  const notes = [];
  for (const n of store.getResearch()) {
    const k = String(n.symbol).toUpperCase().replace('/', '');
    if (seen.has(k)) continue;
    seen.add(k);
    notes.push(pubNote(n));
  }
  res.json({ notes, count: notes.length });
});

// ---- trade proposals (approval queue) ----
const PROPOSAL_ID = /^[\w.\-]{1,120}$/;
async function proposalCall(res, fn) {
  try {
    res.json(await fn());
  } catch (err) {
    if (err instanceof ProposalError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
    throw err;
  }
}
router.get('/proposals', (req, res) => {
  const status = req.query.status === undefined ? '' : String(req.query.status);
  if (status && status !== 'all' && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}, all` });
  res.json(listProposals({ status, limit: Number(req.query.limit) || 100 }));
});
router.post('/proposals/approve-all', asyncHandler(async (_req, res) => res.json(await approveAll({ by: 'user' }))));
router.post('/proposals/:id/approve', asyncHandler((req, res) => (PROPOSAL_ID.test(req.params.id) ? proposalCall(res, () => approveProposal(req.params.id, { by: 'user' })) : res.status(404).json({ error: 'proposal not found', code: 'not_found' }))));
router.post('/proposals/:id/reject', asyncHandler((req, res) => (PROPOSAL_ID.test(req.params.id) ? proposalCall(res, async () => rejectProposal(req.params.id, { reason: req.body?.reason, by: 'user' })) : res.status(404).json({ error: 'proposal not found', code: 'not_found' }))));

// Bull-vs-bear debate for one proposal: ONE AI call, cached on the proposal (re-run with ?force=1), budget-governed, no fallback.
router.post('/proposals/:id/debate', debateLimit, asyncHandler(async (req, res) => {
  if (!PROPOSAL_ID.test(req.params.id)) return res.status(404).json({ error: 'proposal not found', code: 'not_found' });
  try {
    res.json(await debateProposal(req.params.id, { force: wantsForce(req) }));
  } catch (err) {
    if (isAiError(err)) return res.status(AI_STATUS[err.code] ?? 502).json({ error: err.message, code: err.code });
    sendError(res, err);
  }
}));

router.get('/positions', asyncHandler(async (_req, res) => {
  res.json(await listPositions());
}));

// Body/query `force` closes at the last (stale) price. Errors: 409 stale quote, 502 no quote (nothing closed).
router.post('/positions/close-all', asyncHandler(async (req, res) => {
  try {
    const r = await closeAll({ force: wantsForce(req) });
    if (r.failed.length && !r.closed) {
      const first = r.failed[0];
      return res.status(r.failed.some((f) => f.status === 409) ? 409 : first.status).json({ error: first.error, code: first.code, closed: 0, failed: r.failed });
    }
    res.json(r);
  } catch (err) {
    sendError(res, err);
  }
}));

router.post('/positions/:id/close', asyncHandler(async (req, res) => {
  try {
    res.json(await closeManually(req.params.id, { force: wantsForce(req) }));
  } catch (err) {
    sendError(res, err);
  }
}));

router.get('/status', (_req, res) => {
  const worker = store.getWorker();
  const settings = store.getSettings();
  res.json({
    worker,
    settings: {
      ...settings,
      news: newsSettings(settings),
      tradingEnabled: false, // hard lock — predictions only
    },
    news: { enabled: newsSettings(settings).enabled, headlinesAvailable: mockNewsEnabled() || hasAlpacaCredentials(), earningsAvailable: mockNewsEnabled() || hasFinnhubKey(), mock: mockNewsEnabled(), model: config.openrouter.newsModel },
    accuracy: accuracy(),
    alpacaConfigured: hasAlpacaCredentials(),
    openrouterConfigured: hasOpenRouterKey(),
    supabaseConfigured: supabaseEnabled,
    run: runState,
    ai: aiStatus(), // { required:true, ready, blockedReason?, demo }
    budget: { ...budgetCompact(), projectedMonthEndUsd: budgetStatus().projectedMonthEndUsd, forecast: activeForecast() },
    proposalsPending: store.getProposals().filter((p) => p.status === 'pending').length,
    personas: personaList(),
    mockData: alpaca.usingMock(),
    dataMode: alpaca.usingMock() ? 'mock' : 'alpaca',
    fallbacks: alpaca.getFallbacks(),
    marketOpen: usMarketOpen(),
    staleSymbols: alpaca.getStale(),
  });
});

router.get('/logs', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json({ logs: store.getLogs().slice(0, limit) });
});

router.get('/market/quote/:symbol', asyncHandler(async (req, res) => {
  const symbol = req.params.symbol; // Express already decodes params once (a malformed escape is a 400 from the router)
  const bad = marketSymbolError(symbol);
  if (bad) return res.status(400).json({ error: bad });
  try {
    res.json(await alpaca.getQuote(symbol));
  } catch (err) {
    sendError(res, err, 502);
  }
}));

router.get('/market/bars/:symbol', asyncHandler(async (req, res) => {
  const symbol = req.params.symbol;
  const bad = marketSymbolError(symbol);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({ symbol, bars: await alpaca.getBars(symbol, { limit }) });
  } catch (err) {
    sendError(res, err, 502);
  }
}));

router.get('/market/quotes', asyncHandler(async (req, res) => {
  const symbols = String(req.query.symbols || 'SPY,QQQ,IWM')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = symbols.map(marketSymbolError).find(Boolean);
  if (symbols.length > 30 || bad) return res.status(400).json({ error: bad || 'too many symbols' });
  try {
    res.json({ quotes: await alpaca.getQuotes(symbols) });
  } catch (err) {
    sendError(res, err, 502);
  }
}));

router.get('/settings', (_req, res) => {
  const s = store.getSettings();
  res.json({ ...s, news: newsSettings(s), tradingEnabled: false });
});

router.patch('/settings', (req, res) => {
  const { value, error } = validateSettings(req.body);
  if (error) return res.status(400).json({ error });
  const current = store.getSettings();
  if (value.schedule) value.schedule = mergeSchedule(current.schedule, value.schedule);
  if (value.news) value.news = { ...newsSettings(current), ...value.news };
  const next = {
    ...current,
    ...value,
    tradingEnabled: false, // never allow enabling trades from API
    mode: 'predict',
  };
  store.setSettings(next);
  store.addLog({ level: 'info', message: 'settings updated (trading remains disabled)' });
  res.json({ ...next, news: newsSettings(next) });
});

// ---- run schedules, forecast, experiments ----
router.get('/schedule', (_req, res) => res.json(scheduleView()));

router.get('/schedule/forecast', (req, res) => {
  const plan = req.query.plan;
  if (plan !== undefined && !PLANS.includes(plan)) return res.status(400).json({ error: `unknown plan (one of ${PLANS.join(', ')})`, code: 'invalid_plan' });
  res.json(scheduleForecast({ plan }));
});

router.get('/schedule/experiments', (_req, res) => res.json(scheduleExperiments()));

const TEST_FIRE_STATUS = { worker_not_running: 'worker_not_running', run_in_progress: 'run_in_progress' };
router.post('/schedule/test-fire', runLimit, (req, res) => {
  const slotId = req.body?.slotId ?? null;
  if (slotId !== null && (typeof slotId !== 'string' || !slotsForDay(etDayKey(Date.now()), scheduleOf()).some((s) => s.id === slotId))) {
    return res.status(400).json({ error: 'unknown slotId (use an id from GET /api/schedule slotsToday)', code: 'unknown_slot' });
  }
  const r = testFire({ slotId });
  if (r.started) return res.status(202).json({ started: true, trigger: r.trigger, run: runState });
  const code = TEST_FIRE_STATUS[r.reason] || r.reason;
  res.status(409).json({ started: false, error: r.detail ? `${r.reason}: ${r.detail}` : `test run not started: ${r.reason}`, code, workerStatus: store.getWorker().status });
});

router.post('/worker/stop', (_req, res) => {
  store.setWorker({ ...store.getWorker(), status: 'stopped', scanning: false });
  store.addLog({ level: 'info', message: 'worker stopped (scheduled runs paused)' });
  res.json(store.getWorker());
});

router.post('/worker/start', (_req, res) => {
  store.setWorker({ ...store.getWorker(), status: 'online' });
  store.addLog({ level: 'info', message: 'worker online' });
  res.json(store.getWorker());
});

router.post('/worker/kill', (_req, res) => {
  store.setWorker({ ...store.getWorker(), status: 'killed', scanning: false });
  store.addLog({ level: 'warn', message: 'worker KILL — scheduled runs halted' });
  res.json(store.getWorker());
});

// Slim summary kept for the frontend's log fallback; the old prediction/watchlist/model fields are gone.
router.get('/dashboard', (_req, res) => {
  res.json({
    accuracy: accuracy(),
    worker: store.getWorker(),
    logs: store.getLogs().slice(0, 40),
    tradingEnabled: false,
    ai: aiStatus(),
    budget: budgetCompact(),
    proposalsPending: store.getProposals().filter((p) => p.status === 'pending').length,
    mockData: alpaca.usingMock(),
    fallbacks: alpaca.getFallbacks(),
    horizonHours: store.getSettings().horizonHours,
  });
});

// Unknown /api paths are a JSON 404 (never the SPA's index.html).
router.use((_req, res) => res.status(404).json({ error: 'not found' }));

export default router;
