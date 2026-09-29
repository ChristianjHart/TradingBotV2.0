import { store } from '../db/store.js';
import { upsert } from '../db/supabase.js';
import { alpaca } from './alpaca.js';
import { gatherMarketData, runScannerBot } from './aiScanner.js';
import { runTraderBot } from './traderBot.js';
import { monitorPositions } from './positions.js';
import { recordPicks, scorePicks } from './pickScoring.js';

const log = (msg) => console.log(`[run] ${msg}`);

export const runState = {
  running: false,
  stage: 'idle', // idle | fetching | scanning | trading | done | error
  runId: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  picks: 0,
  opened: 0,
};

/** Persist a run summary locally (history + latest) and to Supabase. */
function saveRun(summary, { latest = true } = {}) {
  if (latest) store.setRunSummary(summary);
  store.addRun(summary);
  upsert('runs', {
    id: summary.runId,
    at: summary.at,
    ok: !summary.error,
    scanner_source: summary.scannerSource ?? null,
    trader_source: summary.traderSource ?? null,
    picks: summary.picks ?? 0,
    opened: summary.trades?.length ?? 0,
    duration_ms: summary.durationMs ?? null,
    raw: summary,
  });
}

export function startAiRun() {
  if (runState.running) return false;
  const runId = `run_${Date.now()}`;
  Object.assign(runState, {
    running: true,
    stage: 'fetching',
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    picks: 0,
    opened: 0,
  });
  (async () => {
    const t0 = Date.now();
    try {
      store.addLog({ level: 'info', message: 'AI run started — scanner bot → trader bot' });
      const lap = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
      log('started');
      alpaca.clearCache();
      await monitorPositions();
      await scorePicks();
      const { data, regime } = await gatherMarketData();
      log(`market data for ${data.length} symbols (${lap()})`);
      if (!data.length) throw new Error('no market data available');
      runState.stage = 'scanning';
      const scan = await runScannerBot(data, { regime }); // dashboard shows this list as soon as it is saved
      runState.picks = scan.picks.length;
      recordPicks(runId, scan.picks);
      log(`scanner bot ${scan.source} → ${scan.picks.length} picks (${lap()})`);
      store.addLog({ level: 'info', message: `scanner bot (${scan.source}) → ${scan.picks.length} picks` });
      runState.stage = 'trading';
      const trades = await runTraderBot(scan.picks, { regime });
      runState.opened = trades.opened.length;
      saveRun({
        runId,
        at: new Date().toISOString(),
        durationMs: Date.now() - t0,
        picks: scan.picks.length,
        scannerSource: scan.source,
        scannerModel: scan.model,
        regime: regime?.line || null,
        traderSource: trades.source,
        traderModel: trades.model || null,
        proposed: trades.proposed ?? 0,
        note: trades.note || '',
        rejected: trades.skippedList || [],
        trades: trades.opened.map((t) => ({
          symbol: t.symbol,
          side: t.side,
          allocation: t.allocation,
          entry: t.entry,
          stopLoss: t.stopLoss,
          takeProfit: t.takeProfit,
          confidence: t.confidence,
          reason: t.reason,
        })),
      });
      store.setWorker({ ...store.getWorker(), lastScanAt: new Date().toISOString() });
      log(`trader bot ${trades.source} → ${trades.opened.length} opened (${lap()})`);
      runState.stage = 'done';
    } catch (err) {
      runState.stage = 'error';
      runState.error = err.message;
      log(`FAILED: ${err.message}`);
      store.addLog({ level: 'error', message: `AI run failed: ${err.message}` });
      // Failed runs go to history only, so /ai/summary keeps the last good run.
      saveRun(
        { runId, at: new Date().toISOString(), durationMs: Date.now() - t0, error: err.message, picks: runState.picks, trades: [], rejected: [] },
        { latest: false },
      );
    } finally {
      runState.running = false;
      runState.finishedAt = new Date().toISOString();
    }
  })();
  return true;
}
