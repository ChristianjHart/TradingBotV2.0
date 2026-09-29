import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { config } from './config.js';
import api from './routes/api.js';
import { store } from './db/store.js';
import { runMarketScan } from './services/scanner.js';
import { evaluateOpenPredictions } from './services/evaluator.js';
import { alpaca } from './services/alpaca.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', api);

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

function workerAlive() {
  const w = store.getWorker();
  return w.status === 'online' || w.status === 'degraded';
}

async function bootScan() {
  store.setWorker({ ...store.getWorker(), status: 'online' });
  store.addLog({
    level: 'info',
    message: `bot started (predict-only${alpaca.usingMock() ? ', mock data' : ', alpaca'})`,
  });
  try {
    await runMarketScan();
    await evaluateOpenPredictions();
  } catch (err) {
    store.addLog({ level: 'error', message: `boot scan failed: ${err.message}` });
  }
}

const minutes = Math.max(5, config.scanIntervalMinutes);
cron.schedule(`*/${minutes} * * * *`, async () => {
  if (!workerAlive()) return;
  const settings = store.getSettings();
  if (!settings.autoScan) return;
  try {
    await runMarketScan();
  } catch (err) {
    store.addLog({ level: 'error', message: `AI cycle failed: ${err.message}` });
  }
});

cron.schedule('*/15 * * * *', async () => {
  if (!workerAlive()) return;
  try {
    await evaluateOpenPredictions();
  } catch (err) {
    store.addLog({ level: 'error', message: `evaluate failed: ${err.message}` });
  }
});

app.listen(config.port, () => {
  console.log(`TradingBot V2.0 (predict-only) → http://localhost:${config.port}`);
  console.log(`Data mode: ${alpaca.usingMock() ? 'MOCK' : 'ALPACA'}`);
  bootScan();
});
