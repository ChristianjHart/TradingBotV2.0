import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { config } from './config.js';
import api from './routes/api.js';
import { store } from './db/store.js';
import { startAiRun } from './services/aiRun.js';
import { scorePicks } from './services/pickScoring.js';
import { alpaca } from './services/alpaca.js';
import { monitorPositions } from './services/positions.js';
import { requestLogger } from './services/http.js';
import { errorHandler } from './middleware.js';
import { hydrateFromSupabase } from './db/hydrate.js';
import { supabaseEnabled } from './db/supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');
// Same-origin by default (no CORS headers); set CORS_ORIGIN to allow one external origin.
if (config.corsOrigin) app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', requestLogger, api);

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use(errorHandler);

function workerAlive() {
  const w = store.getWorker();
  return w.status === 'online' || w.status === 'degraded';
}

function bootWorker() {
  store.setWorker({ ...store.getWorker(), status: 'online' });
  store.addLog({
    level: 'info',
    message: `bot started (paper trading simulation${alpaca.usingMock() ? ', mock data' : ', alpaca'})`,
  });
}

// Position monitoring (stops, targets, trailing, time exit) always runs.
cron.schedule('*/5 * * * *', () => monitorPositions().catch(() => {}));

// Score scanner picks whose horizon has passed.
cron.schedule('*/15 * * * *', () => scorePicks().catch(() => {}));

// Scheduled AI runs cost OpenRouter credits, so they are opt-in (settings.autoRun).
const minutes = Math.max(5, config.scanIntervalMinutes);
cron.schedule(`*/${minutes} * * * *`, () => {
  const settings = store.getSettings();
  if (workerAlive() && settings.autoRun) startAiRun();
});

const host = process.env.HOST || '0.0.0.0';
app.listen(config.port, host, () => {
  console.log(`TradingBot V2.0 (paper simulation) → http://${host}:${config.port}`);
  console.log(`Supabase: ${supabaseEnabled ? 'ON' : 'off'}`);
  console.log(`Data mode: ${alpaca.usingMock() ? 'MOCK' : 'ALPACA'}`);
  hydrateFromSupabase().finally(bootWorker);
});
