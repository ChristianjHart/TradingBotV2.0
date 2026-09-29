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

/** Atomic write: temp file + rename so a crash never leaves half a JSON file. */
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const defaults = {
  logs: [],
  settings: {
    mode: 'predict', // predict only — never trade
    paper: true,
    tradingEnabled: false,
    autoScan: true, // keep monitoring positions on a schedule
    autoRun: false, // scheduled AI runs (costs OpenRouter credits) — opt in
    watchlistSize: config.watchlistSize,
    horizonHours: config.predictionHorizonHours,
    slippageBps: config.trading.slippageBps,
    feeBps: config.trading.feeBps,
    breakEven: true,
    trailR: 0, // >0 trails the stop this many R behind the best price
    maxGrossPct: config.trading.maxGrossPct,
    maxClassPct: config.trading.maxClassPct,
    maxPerGroup: config.trading.maxPerGroup,
    dailyLossHaltPct: config.trading.dailyLossHaltPct,
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
  logs: path.join(config.dataDir, 'logs.json'),
  settings: path.join(config.dataDir, 'settings.json'),
  worker: path.join(config.dataDir, 'worker.json'),
  aiPicks: path.join(config.dataDir, 'ai-picks.json'),
  positions: path.join(config.dataDir, 'positions.json'),
  runSummary: path.join(config.dataDir, 'run-summary.json'),
  runs: path.join(config.dataDir, 'runs.json'),
  equity: path.join(config.dataDir, 'equity.json'),
  pickScores: path.join(config.dataDir, 'pick-scores.json'),
  positionsArchive: path.join(config.dataDir, 'positions-archive.json'),
};

export const MAX_POSITIONS = 1000;

// Write-through cache: each file is parsed once, then served from memory. Getters hand out clones
// so callers may mutate freely; only set*() (which also writes the file) changes the cache.
const cache = new Map();
function cached(key, file, fallback) {
  if (!cache.has(key)) cache.set(key, readJson(file, fallback));
  return structuredClone(cache.get(key));
}
function put(key, file, data) {
  writeJson(file, data);
  cache.set(key, structuredClone(data));
}

// Logs are hot: keep them in memory and write to disk at most every LOG_FLUSH_MS.
const LOG_FLUSH_MS = 1000;
let logCache = null;
let logTimer = null;

function flushLogs() {
  clearTimeout(logTimer);
  logTimer = null;
  if (logCache) writeJson(files.logs, logCache);
}
process.on('exit', () => {
  try {
    if (logTimer) flushLogs();
  } catch {
    /* best effort */
  }
});

export const store = {
  getLogs() {
    logCache ||= readJson(files.logs, defaults.logs);
    return logCache;
  },
  addLog(entry) {
    const logs = this.getLogs();
    const row = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString(),
      level: entry.level || 'info',
      message: entry.message,
    };
    logs.unshift(row);
    logs.length = Math.min(logs.length, 500);
    logTimer ||= setTimeout(flushLogs, LOG_FLUSH_MS);
    logTimer.unref?.();
    insert('app_logs', { ts: row.ts, level: row.level, message: row.message });
  },
  flush() {
    if (logTimer) flushLogs();
  },

  getSettings() {
    return { ...defaults.settings, ...cached('settings', files.settings, defaults.settings) };
  },
  setSettings(data) {
    put('settings', files.settings, data);
  },

  getAiPicks() {
    return cached('aiPicks', files.aiPicks, { picks: [], updatedAt: null });
  },
  setAiPicks(data) {
    put('aiPicks', files.aiPicks, data);
  },

  getRunSummary() {
    return cached('runSummary', files.runSummary, null);
  },
  setRunSummary(data) {
    put('runSummary', files.runSummary, data);
  },

  /** Run history, newest first (successful and failed runs). */
  getRuns() {
    return cached('runs', files.runs, []);
  },
  setRuns(data) {
    put('runs', files.runs, data.slice(0, 200));
  },
  addRun(run) {
    this.setRuns([run, ...this.getRuns()]);
  },

  /** Equity snapshots [{t, equity}] ascending. */
  getEquity() {
    return cached('equity', files.equity, []);
  },
  setEquity(data) {
    put('equity', files.equity, data.slice(-3000));
  },

  /** Scanner picks with their horizon outcome (see services/picks.js). */
  getPickScores() {
    return cached('pickScores', files.pickScores, []);
  },
  setPickScores(data) {
    put('pickScores', files.pickScores, data.slice(0, 5000));
  },

  /** Positions, newest first. */
  getPositions() {
    return cached('positions', files.positions, []);
  },
  /**
   * Keeps every open position plus the newest closed ones up to MAX_POSITIONS; older closed
   * positions are appended to positions-archive.json instead of being dropped.
   */
  setPositions(data) {
    let keep = data;
    if (data.length > MAX_POSITIONS) {
      const room = Math.max(0, MAX_POSITIONS - data.filter((p) => p.status === 'open').length);
      let closedSeen = 0;
      keep = [];
      const overflow = [];
      for (const p of data) {
        if (p.status === 'open' || closedSeen++ < room) keep.push(p);
        else overflow.push(p);
      }
      if (overflow.length) {
        const archive = readJson(files.positionsArchive, []);
        const seen = new Set(archive.map((p) => p.id));
        writeJson(files.positionsArchive, [...archive, ...overflow.filter((p) => !seen.has(p.id))]);
      }
    }
    put('positions', files.positions, keep);
  },
  getPositionsArchive() {
    return readJson(files.positionsArchive, []);
  },

  getWorker() {
    return { ...defaults.worker, ...cached('worker', files.worker, defaults.worker) };
  },
  setWorker(data) {
    put('worker', files.worker, data);
  },
};
