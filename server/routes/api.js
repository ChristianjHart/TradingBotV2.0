import { Router } from 'express';
import { store } from '../db/store.js';
import { alpaca } from '../services/alpaca.js';
import { config, hasAlpacaCredentials, hasOpenRouterKey } from '../config.js';
import { supabaseEnabled } from '../db/supabase.js';
import { startAiRun, runState } from '../services/aiRun.js';
import { listPositions, closeManually, closeAll } from '../services/positions.js';
import { computePerformance } from '../services/performance.js';
import { pickStats } from '../services/picks.js';
import { usMarketOpen } from '../services/market.js';
import { rateLimit, validateSettings, validSymbol, asyncHandler } from '../middleware.js';
import { UNIVERSE } from '../services/universe.js';
import { resolveAuth, authGate, csrfGuard } from '../auth/index.js';
import { authRouter, accountRouter } from './auth.js';

const router = Router();

// Dashboard polling (GET, not market data) has its own generous bucket; everything else shares a tighter one.
// The credit-spending run trigger is tighter still and is not charged for 200 "already running" replies.
const pollLimit = rateLimit({ windowMs: 60_000, max: 1200, name: 'poll' });
const apiLimit = rateLimit({ windowMs: 60_000, max: 300, name: 'api' });
router.use((req, res, next) => (req.method === 'GET' && !req.path.startsWith('/market') ? pollLimit : apiLimit)(req, res, next));
const runLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, name: 'run', refundWhen: (res) => res.statusCode === 200 });

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
    supabaseConfigured: supabaseEnabled,
    mockData: alpaca.usingMock(),
    fallbacks: alpaca.getFallbacks(),
  });
});


router.use('/auth', authRouter);
router.use(authGate); // from here on a valid session cookie or Bearer ADMIN_TOKEN is required (once an account or ADMIN_TOKEN exists)
router.use('/account', accountRouter);

// A stopped/killed worker must not spend credits or open positions: 409 (exits stay managed by the monitor).
router.post('/run', runLimit, (_req, res) => {
  const ws = store.getWorker().status;
  if (ws === 'stopped' || ws === 'killed') {
    return res.status(409).json({ error: `worker is ${ws}: start the worker before running the AI desk`, code: 'worker_not_running', workerStatus: ws });
  }
  const started = startAiRun();
  res.status(started ? 202 : 200).json({ started, ...runState });
});

router.get('/run/status', (_req, res) => res.json(runState));

router.get('/runs', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
  res.json({ runs: store.getRuns().slice(0, limit) });
});

router.get('/ai/summary', (_req, res) => res.json(store.getRunSummary() || {}));

router.get('/ai/picks', (_req, res) => res.json(store.getAiPicks()));

router.get('/performance', (_req, res) => {
  res.json(
    computePerformance({
      positions: store.getPositions(),
      snapshots: store.getEquity(),
      pickRecords: store.getPickScores(),
      startingEquity: config.paperEquity,
    }),
  );
});

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
      tradingEnabled: false, // hard lock — predictions only
    },
    accuracy: accuracy(),
    alpacaConfigured: hasAlpacaCredentials(),
    openrouterConfigured: hasOpenRouterKey(),
    supabaseConfigured: supabaseEnabled,
    run: runState,
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
  res.json({ ...store.getSettings(), tradingEnabled: false });
});

router.patch('/settings', (req, res) => {
  const { value, error } = validateSettings(req.body);
  if (error) return res.status(400).json({ error });
  const next = {
    ...store.getSettings(),
    ...value,
    tradingEnabled: false, // never allow enabling trades from API
    mode: 'predict',
  };
  store.setSettings(next);
  store.addLog({ level: 'info', message: 'settings updated (trading remains disabled)' });
  res.json(next);
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
    mockData: alpaca.usingMock(),
    fallbacks: alpaca.getFallbacks(),
    horizonHours: store.getSettings().horizonHours,
  });
});

export default router;
