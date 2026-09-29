import { Router } from 'express';
import { store } from '../db/store.js';
import { alpaca } from '../services/alpaca.js';
import { config, hasAlpacaCredentials, hasOpenRouterKey } from '../config.js';
import { supabaseEnabled } from '../db/supabase.js';
import { startAiRun, runState } from '../services/aiRun.js';
import { scorePicks } from '../services/pickScoring.js';
import { listPositions, closeManually, closeAll } from '../services/positions.js';
import { computePerformance } from '../services/performance.js';
import { pickStats, toLegacyPrediction } from '../services/picks.js';
import { usMarketOpen } from '../services/market.js';
import { requireAdmin, rateLimit, validateSettings, validSymbol } from '../middleware.js';

const router = Router();

// Generous global cap for the whole API, tight one for the credit-spending run trigger.
router.use(rateLimit({ windowMs: 60_000, max: 300, name: 'api' }));
const runLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, name: 'run' });

const accuracy = () => pickStats(store.getPickScores(), openPickCount());
const openPickCount = () => store.getPickScores().filter((r) => !r.scored).length;
const legacyPicks = () => store.getPickScores().map(toLegacyPrediction);

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

router.get('/auth/status', (_req, res) => res.json({ required: Boolean(config.adminToken) }));

router.post('/run', requireAdmin, runLimit, (_req, res) => {
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

router.get('/positions', async (_req, res) => {
  try {
    res.json(await listPositions());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/positions/close-all', requireAdmin, async (_req, res) => {
  try {
    res.json({ closed: await closeAll() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/positions/:id/close', requireAdmin, async (req, res) => {
  const p = await closeManually(req.params.id).catch(() => null);
  if (!p) return res.status(404).json({ error: 'open position not found' });
  res.json(p);
});

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

// --- Legacy endpoints: same shapes as before, now backed by the scanner bot's picks. ---

function watchlistView() {
  const ai = store.getAiPicks();
  const size = store.getSettings().watchlistSize || config.watchlistSize;
  return {
    date: ai.updatedAt ? ai.updatedAt.slice(0, 10) : null,
    updatedAt: ai.updatedAt,
    symbols: (ai.picks || []).slice(0, size).map((p) => ({
      symbol: p.symbol,
      assetClass: p.symbol.includes('/') ? 'crypto' : 'equity',
      direction: p.direction,
      confidence: p.confidence,
      price: p.price,
      reasons: p.reason ? [p.reason] : [],
    })),
    scanned: ai.scanned ?? 0,
    universe: ai.universe ?? 0,
    mock: alpaca.usingMock(),
  };
}

router.get('/watchlist', (_req, res) => res.json(watchlistView()));

// Legacy "scan" now triggers the one real pipeline (scanner bot → trader bot).
router.post('/scan', requireAdmin, runLimit, (_req, res) => {
  const started = startAiRun();
  res.status(started ? 202 : 200).json({ started, ...runState });
});

router.get('/predictions', (req, res) => {
  let list = legacyPicks();
  if (req.query.status) list = list.filter((p) => p.status === req.query.status);
  res.json({ predictions: list.slice(0, 200) });
});

router.get('/predictions/open', (_req, res) => {
  res.json({ predictions: legacyPicks().filter((p) => p.status === 'open').slice(0, 200) });
});

router.get('/accuracy', (_req, res) => res.json(accuracy()));

router.post('/evaluate', requireAdmin, async (_req, res) => {
  try {
    const r = await scorePicks();
    res.json({ resolved: r.scored, correct: r.hits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/train', requireAdmin, (_req, res) => {
  res.json({ deprecated: true, message: 'the self-training loop was retired; picks are scored and calibrated instead (see /api/performance)' });
});

router.get('/model', (_req, res) => {
  res.json({ deprecated: true, version: null, weights: {}, trainedOn: 0, lastTrainedAt: null });
});

router.get('/logs', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json({ logs: store.getLogs().slice(0, limit) });
});

router.get('/market/quote/:symbol', async (req, res) => {
  const symbol = decodeURIComponent(req.params.symbol);
  if (!validSymbol(symbol)) return res.status(400).json({ error: 'invalid symbol' });
  try {
    res.json(await alpaca.getQuote(symbol));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/market/bars/:symbol', async (req, res) => {
  const symbol = decodeURIComponent(req.params.symbol);
  if (!validSymbol(symbol)) return res.status(400).json({ error: 'invalid symbol' });
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({ symbol, bars: await alpaca.getBars(symbol, { limit }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/market/quotes', async (req, res) => {
  const symbols = String(req.query.symbols || 'SPY,QQQ,IWM')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (symbols.length > 30 || !symbols.every(validSymbol)) return res.status(400).json({ error: 'invalid symbols' });
  try {
    res.json({ quotes: await alpaca.getQuotes(symbols) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/settings', (_req, res) => {
  res.json({ ...store.getSettings(), tradingEnabled: false });
});

router.patch('/settings', requireAdmin, (req, res) => {
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

router.post('/worker/stop', requireAdmin, (_req, res) => {
  store.setWorker({ ...store.getWorker(), status: 'stopped', scanning: false });
  store.addLog({ level: 'info', message: 'worker stopped (scheduled runs paused)' });
  res.json(store.getWorker());
});

router.post('/worker/start', requireAdmin, (_req, res) => {
  store.setWorker({ ...store.getWorker(), status: 'online' });
  store.addLog({ level: 'info', message: 'worker online' });
  res.json(store.getWorker());
});

router.post('/worker/kill', requireAdmin, (_req, res) => {
  store.setWorker({ ...store.getWorker(), status: 'killed', scanning: false });
  store.addLog({ level: 'warn', message: 'worker KILL — scheduled runs halted' });
  res.json(store.getWorker());
});

router.get('/dashboard', (_req, res) => {
  const recs = legacyPicks();
  const open = recs.filter((p) => p.status === 'open');
  const wl = watchlistView();
  const shorts = open.filter((p) => p.direction === 'short').length;
  res.json({
    watchlist: wl,
    openPredictions: open.slice(0, 200),
    recentResolved: recs.filter((p) => p.status === 'resolved').slice(0, 20),
    accuracy: accuracy(),
    worker: store.getWorker(),
    model: { deprecated: true, version: null, weights: {}, trainedOn: 0, lastTrainedAt: null },
    logs: store.getLogs().slice(0, 40),
    allocation: [
      { label: 'LONG', value: open.length - shorts, color: '#22c55e' },
      { label: 'SHORT', value: shorts, color: '#ef4444' },
    ],
    tradingEnabled: false,
    mockData: alpaca.usingMock(),
    fallbacks: alpaca.getFallbacks(),
    horizonHours: store.getSettings().horizonHours,
  });
});

export default router;
