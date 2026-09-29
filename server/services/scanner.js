import { alpaca } from './alpaca.js';
import { predictFromBars, rankCandidates } from './predictor.js';
import { store } from '../db/store.js';
import { config } from '../config.js';

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export async function runMarketScan({ force = false } = {}) {
  const worker = store.getWorker();
  if (worker.scanning) {
    return { ok: false, message: 'scan already running' };
  }

  store.setWorker({ ...worker, scanning: true, status: 'online' });
  store.addLog({ level: 'info', message: 'AI scan started — equities + crypto universe' });

  const settings = store.getSettings();
  const size = settings.watchlistSize || config.watchlistSize;
  const symbols = [...alpaca.universe.stocks, ...alpaca.universe.crypto];
  const predictions = [];
  let scanned = 0;
  let failed = 0;

  try {
    for (const symbol of symbols) {
      try {
        const { bars } = await alpaca.getSnapshot(symbol);
        if (!bars || bars.length < 30) {
          failed += 1;
          store.addLog({
            level: 'warn',
            message: `scan skip ${symbol}: only ${bars?.length || 0} bars (need 30)`,
          });
          continue;
        }
        const pred = predictFromBars(symbol, bars);
        predictions.push(pred);
        scanned += 1;
      } catch (err) {
        failed += 1;
        store.addLog({
          level: 'warn',
          message: `scan skip ${symbol}: ${err.message}`,
        });
      }
    }

    const ranked = rankCandidates(predictions);
    const watchSymbols = ranked.slice(0, size).map((p) => ({
      symbol: p.symbol,
      assetClass: p.assetClass,
      direction: p.direction,
      confidence: p.confidence,
      expectedMovePct: p.expectedMovePct,
      price: p.entryPrice,
      reasons: p.reasons.slice(0, 2),
    }));

    const existing = store.getPredictions();
    const keep = existing.filter((p) => p.status === 'open' || p.status === 'resolved');
    // Replace today's open batch of same horizon with fresh ranked picks
    const fresh = ranked.slice(0, size).map((p) => ({ ...p, status: 'open' }));
    const merged = [...fresh, ...keep.filter((p) => p.status === 'resolved' || !fresh.some((f) => f.symbol === p.symbol && p.status === 'open'))];

    // Deduplicate open by symbol — keep newest
    const openBySymbol = new Map();
    const resolved = [];
    for (const p of merged) {
      if (p.status === 'resolved' || p.status === 'skipped') {
        if (p.status === 'resolved') resolved.push(p);
        continue;
      }
      if (!openBySymbol.has(p.symbol) || openBySymbol.get(p.symbol).createdAt < p.createdAt) {
        openBySymbol.set(p.symbol, p);
      }
    }
    store.setPredictions([...openBySymbol.values(), ...resolved].slice(0, 2000));

    const watchlist = {
      date: todayKey(),
      symbols: watchSymbols,
      updatedAt: new Date().toISOString(),
      scanned,
      failed,
      universe: symbols.length,
      mock: alpaca.usingMock(),
    };
    store.setWatchlist(watchlist);

    store.setWorker({
      ...store.getWorker(),
      scanning: false,
      status: 'online',
      lastScanAt: new Date().toISOString(),
    });

    store.addLog({
      level: 'info',
      message: `AI scan complete: ${scanned}/${symbols.length} symbols → watchlist ${watchSymbols.length} (mock=${alpaca.usingMock()})`,
    });

    return { ok: true, watchlist, predictions: fresh };
  } catch (err) {
    store.setWorker({ ...store.getWorker(), scanning: false, status: 'degraded' });
    store.addLog({ level: 'error', message: `AI cycle failed: ${err.message}` });
    throw err;
  }
}

export async function ensureTodayWatchlist() {
  const wl = store.getWatchlist();
  if (wl.date === todayKey() && wl.symbols?.length) return wl;
  const result = await runMarketScan();
  return result.watchlist;
}
