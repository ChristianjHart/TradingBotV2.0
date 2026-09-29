import { store } from '../db/store.js';
import { gatherMarketData, runScannerBot } from './aiScanner.js';
import { runTraderBot } from './traderBot.js';
import { monitorPositions } from './positions.js';

export const runState = {
  running: false,
  stage: 'idle', // idle | scanning | trading | done | error
  startedAt: null,
  finishedAt: null,
  error: null,
  picks: 0,
  opened: 0,
};

export function startAiRun() {
  if (runState.running) return false;
  Object.assign(runState, {
    running: true,
    stage: 'scanning',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    picks: 0,
    opened: 0,
  });
  (async () => {
    try {
      store.addLog({ level: 'info', message: 'AI run started — scanner bot → trader bot' });
      await monitorPositions();
      const data = await gatherMarketData();
      if (!data.length) throw new Error('no market data available');
      const scan = await runScannerBot(data); // dashboard shows this list as soon as it is saved
      runState.picks = scan.picks.length;
      store.addLog({ level: 'info', message: `scanner bot (${scan.source}) → ${scan.picks.length} picks` });
      runState.stage = 'trading';
      const trades = await runTraderBot(scan.picks);
      runState.opened = trades.opened.length;
      runState.stage = 'done';
    } catch (err) {
      runState.stage = 'error';
      runState.error = err.message;
      store.addLog({ level: 'error', message: `AI run failed: ${err.message}` });
    } finally {
      runState.running = false;
      runState.finishedAt = new Date().toISOString();
    }
  })();
  return true;
}
