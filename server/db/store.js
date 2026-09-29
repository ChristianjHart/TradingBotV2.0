import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { insert } from './supabase.js';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return structuredClone(fallback);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const defaults = {
  watchlist: { date: null, symbols: [], updatedAt: null },
  predictions: [],
  model: {
    version: 1,
    weights: {
      momentum: 1,
      rsi: 1,
      macd: 1,
      volume: 1,
      volatility: 1,
      trend: 1,
    },
    bias: 0,
    trainedOn: 0,
    lastTrainedAt: null,
  },
  logs: [],
  settings: {
    mode: 'predict', // predict only — never trade
    paper: true,
    tradingEnabled: false,
    autoScan: true,
    watchlistSize: config.watchlistSize,
    horizonHours: config.predictionHorizonHours,
  },
  worker: {
    status: 'online',
    lastScanAt: null,
    lastEvaluateAt: null,
    scanning: false,
  },
};

ensureDir(config.dataDir);

const files = {
  watchlist: path.join(config.dataDir, 'watchlist.json'),
  predictions: path.join(config.dataDir, 'predictions.json'),
  model: path.join(config.dataDir, 'model.json'),
  logs: path.join(config.dataDir, 'logs.json'),
  settings: path.join(config.dataDir, 'settings.json'),
  worker: path.join(config.dataDir, 'worker.json'),
  aiPicks: path.join(config.dataDir, 'ai-picks.json'),
  positions: path.join(config.dataDir, 'positions.json'),
  runSummary: path.join(config.dataDir, 'run-summary.json'),
};

export const store = {
  getWatchlist() {
    return readJson(files.watchlist, defaults.watchlist);
  },
  setWatchlist(data) {
    writeJson(files.watchlist, data);
  },

  getPredictions() {
    return readJson(files.predictions, defaults.predictions);
  },
  setPredictions(data) {
    writeJson(files.predictions, data);
  },
  upsertPrediction(pred) {
    const all = this.getPredictions();
    const idx = all.findIndex((p) => p.id === pred.id);
    if (idx >= 0) all[idx] = pred;
    else all.unshift(pred);
    this.setPredictions(all.slice(0, 2000));
    return pred;
  },

  getModel() {
    return readJson(files.model, defaults.model);
  },
  setModel(data) {
    writeJson(files.model, data);
  },

  getLogs() {
    return readJson(files.logs, defaults.logs);
  },
  addLog(entry) {
    const logs = this.getLogs();
    logs.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString(),
      level: entry.level || 'info',
      message: entry.message,
    });
    writeJson(files.logs, logs.slice(0, 500));
    insert('app_logs', { ts: logs[0].ts, level: logs[0].level, message: logs[0].message });
  },

  getSettings() {
    return { ...defaults.settings, ...readJson(files.settings, defaults.settings) };
  },
  setSettings(data) {
    writeJson(files.settings, data);
  },

  getAiPicks() {
    return readJson(files.aiPicks, { picks: [], updatedAt: null });
  },
  setAiPicks(data) {
    writeJson(files.aiPicks, data);
  },

  getRunSummary() {
    return readJson(files.runSummary, null);
  },
  setRunSummary(data) {
    writeJson(files.runSummary, data);
  },

  getPositions() {
    return readJson(files.positions, []);
  },
  setPositions(data) {
    writeJson(files.positions, data);
  },

  getWorker() {
    return { ...defaults.worker, ...readJson(files.worker, defaults.worker) };
  },
  setWorker(data) {
    writeJson(files.worker, data);
  },
};
