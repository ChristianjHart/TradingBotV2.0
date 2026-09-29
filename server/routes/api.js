import { Router } from 'express';
import { store } from '../db/store.js';
import { alpaca } from '../services/alpaca.js';
import { runMarketScan, ensureTodayWatchlist } from '../services/scanner.js';
import { evaluateOpenPredictions, getAccuracyStats } from '../services/evaluator.js';
import { config, hasAlpacaCredentials, hasOpenRouterKey } from '../config.js';
import { trainFromOutcomes } from '../services/trainer.js';
import { supabaseEnabled } from '../db/supabase.js';
import { startAiRun, runState } from '../services/aiRun.js';
import { listPositions, closeManually } from '../services/positions.js';

const router = Router();

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

router.post('/run', (_req, res) => {
  const started = startAiRun();
  res.status(started ? 202 : 200).json({ started, ...runState });
});

router.get('/run/status', (_req, res) => res.json(runState));

router.get('/ai/summary', (_req, res) => res.json(store.getRunSummary() || {}));

router.get('/ai/picks', (_req, res) => res.json(store.getAiPicks()));

router.get('/positions', async (_req, res) => {
  try {
    res.json(await listPositions());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/positions/:id/close', async (req, res) => {
  const p = await closeManually(req.params.id).catch(() => null);
  if (!p) return res.status(404).json({ error: 'open position not found' });
  res.json(p);
});

router.get('/status', (_req, res) => {
  const worker = store.getWorker();
  const settings = store.getSettings();
  const stats = getAccuracyStats();
  res.json({
    worker,
    settings: {
      ...settings,
      tradingEnabled: false, // hard lock — predictions only
    },
    accuracy: stats,
    alpacaConfigured: hasAlpacaCredentials(),
    openrouterConfigured: hasOpenRouterKey(),
    supabaseConfigured: supabaseEnabled,
    run: runState,
    mockData: alpaca.usingMock(),
    dataMode: alpaca.usingMock() ? 'mock' : 'alpaca',
    fallbacks: alpaca.getFallbacks(),
  });
});

router.get('/watchlist', async (_req, res) => {
  try {
    const wl = await ensureTodayWatchlist();
    res.json(wl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/scan', async (_req, res) => {
  try {
    const result = await runMarketScan({ force: true });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/predictions', (req, res) => {
  const status = req.query.status;
  let list = store.getPredictions();
  if (status) list = list.filter((p) => p.status === status);
  res.json({ predictions: list.slice(0, 200) });
});

router.get('/predictions/open', (_req, res) => {
  res.json({
    predictions: store.getPredictions().filter((p) => p.status === 'open'),
  });
});

router.get('/accuracy', (_req, res) => {
  res.json(getAccuracyStats());
});

router.post('/evaluate', async (_req, res) => {
  try {
    const result = await evaluateOpenPredictions();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/train', (_req, res) => {
  const model = trainFromOutcomes();
  store.addLog({ level: 'info', message: `manual train → model v${model.version}` });
  res.json(model);
});

router.get('/model', (_req, res) => {
  res.json(store.getModel());
});

router.get('/logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ logs: store.getLogs().slice(0, limit) });
});

router.get('/market/quote/:symbol', async (req, res) => {
  try {
    const symbol = decodeURIComponent(req.params.symbol);
    const quote = await alpaca.getQuote(symbol);
    res.json(quote);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/market/bars/:symbol', async (req, res) => {
  try {
    const symbol = decodeURIComponent(req.params.symbol);
    const limit = Number(req.query.limit) || 100;
    const bars = await alpaca.getBars(symbol, { limit });
    res.json({ symbol, bars });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/market/quotes', async (req, res) => {
  try {
    const symbols = (req.query.symbols || 'SPY,QQQ,IWM')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const quotes = await alpaca.getQuotes(symbols);
    res.json({ quotes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/settings', (_req, res) => {
  res.json({ ...store.getSettings(), tradingEnabled: false });
});

router.patch('/settings', (req, res) => {
  const current = store.getSettings();
  const next = {
    ...current,
    ...req.body,
    tradingEnabled: false, // never allow enabling trades from API
    mode: 'predict',
  };
  store.setSettings(next);
  store.addLog({ level: 'info', message: 'settings updated (trading remains disabled)' });
  res.json(next);
});

router.post('/worker/stop', (_req, res) => {
  store.setWorker({ ...store.getWorker(), status: 'stopped', scanning: false });
  store.addLog({ level: 'info', message: 'worker stopped (predictions paused)' });
  res.json(store.getWorker());
});

router.post('/worker/start', (_req, res) => {
  store.setWorker({ ...store.getWorker(), status: 'online' });
  store.addLog({ level: 'info', message: 'worker online (predict mode)' });
  res.json(store.getWorker());
});

router.post('/worker/kill', (_req, res) => {
  store.setWorker({ ...store.getWorker(), status: 'killed', scanning: false });
  store.addLog({ level: 'warn', message: 'worker KILL — all cycles halted' });
  res.json(store.getWorker());
});

router.get('/dashboard', async (_req, res) => {
  try {
    const wl = store.getWatchlist();
    const open = store.getPredictions().filter((p) => p.status === 'open');
    const recent = store.getPredictions().filter((p) => p.status === 'resolved').slice(0, 20);
    const stats = getAccuracyStats();
    const worker = store.getWorker();
    const model = store.getModel();
    const logs = store.getLogs().slice(0, 40);

    // Allocation by direction on open predictions
    const longs = open.filter((p) => p.direction === 'long');
    const shorts = open.filter((p) => p.direction === 'short');
    const allocation = [
      { label: 'LONG', value: longs.length, color: '#22c55e' },
      { label: 'SHORT', value: shorts.length, color: '#ef4444' },
      { label: 'WATCH', value: Math.max(0, (wl.symbols?.length || 0) - open.length), color: '#8b5cf6' },
    ];

    res.json({
      watchlist: wl,
      openPredictions: open,
      recentResolved: recent,
      accuracy: stats,
      worker,
      model,
      logs,
      allocation,
      tradingEnabled: false,
      mockData: alpaca.usingMock(),
      fallbacks: alpaca.getFallbacks(),
      horizonHours: config.predictionHorizonHours,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
