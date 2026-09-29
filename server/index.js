import cron from 'node-cron';
import { config } from './config.js';
import { createApp } from './app.js';
import { store } from './db/store.js';
import { startAiRun } from './services/aiRun.js';
import { scorePicks } from './services/pickScoring.js';
import { alpaca } from './services/alpaca.js';
import { monitorPositions } from './services/positions.js';
import { guarded } from './services/jobs.js';
import { warnIfProxyMisconfigured } from './middleware.js';
import { hydrateFromSupabase } from './db/hydrate.js';
import { supabaseEnabled } from './db/supabase.js';

const app = createApp();

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
cron.schedule('*/5 * * * *', guarded('monitor', monitorPositions));

// Score scanner picks whose horizon has passed.
cron.schedule('*/15 * * * *', guarded('score', scorePicks));

// Scheduled AI runs cost OpenRouter credits, so they are opt-in (settings.autoRun).
const minutes = Math.max(5, config.scanIntervalMinutes);
// startAiRun() itself refuses to start while a run is in flight (runState.running).
cron.schedule(
  `*/${minutes} * * * *`,
  guarded('run', () => {
    const settings = store.getSettings();
    if (workerAlive() && settings.autoRun && !startAiRun()) store.addLog({ level: 'warn', message: 'cron run: a run is already in progress, skipping' });
  }),
);

const host = process.env.HOST || '0.0.0.0';
app.listen(config.port, host, () => {
  console.log(`TradingBot V2.0 (paper simulation) → http://${host}:${config.port}`);
  console.log(`Supabase: ${supabaseEnabled ? 'ON' : 'off'}`);
  console.log(`Data mode: ${alpaca.usingMock() ? 'MOCK' : 'ALPACA'}`);
  warnIfProxyMisconfigured((message) => store.addLog({ level: 'warn', message }));
  hydrateFromSupabase().finally(bootWorker);
});
