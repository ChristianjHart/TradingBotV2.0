import { alpaca } from './alpaca.js';
import { store } from '../db/store.js';
import { trainFromOutcomes } from './trainer.js';

export async function evaluateOpenPredictions() {
  const all = store.getPredictions();
  const now = Date.now();
  let resolved = 0;
  let correct = 0;

  for (const pred of all) {
    if (pred.status !== 'open') continue;
    const due = new Date(pred.resolveAt).getTime();
    if (due > now) continue;

    try {
      const quote = await alpaca.getQuote(pred.symbol);
      if (!quote) continue;
      const actual = quote.price;
      const actualMovePct = ((actual - pred.entryPrice) / pred.entryPrice) * 100;
      let isCorrect = false;
      if (pred.direction === 'long') isCorrect = actualMovePct > 0;
      else if (pred.direction === 'short') isCorrect = actualMovePct < 0;

      pred.status = 'resolved';
      pred.outcome = isCorrect ? 'hit' : 'miss';
      pred.correct = isCorrect;
      pred.actualPrice = +actual.toFixed(4);
      pred.actualMovePct = +actualMovePct.toFixed(3);
      pred.resolvedAt = new Date().toISOString();
      resolved += 1;
      if (isCorrect) correct += 1;
    } catch (err) {
      store.addLog({
        level: 'warn',
        message: `evaluate ${pred.symbol} failed: ${err.message}`,
      });
    }
  }

  if (resolved > 0) {
    store.setPredictions(all);
    const trained = trainFromOutcomes();
    store.setWorker({
      ...store.getWorker(),
      lastEvaluateAt: new Date().toISOString(),
    });
    store.addLog({
      level: 'info',
      message: `evaluated ${resolved} predictions (${correct} correct) — model v${trained.version}`,
    });
  }

  return { resolved, correct };
}

export function getAccuracyStats() {
  const all = store.getPredictions().filter((p) => p.status === 'resolved');
  const total = all.length;
  const hits = all.filter((p) => p.correct).length;
  const longs = all.filter((p) => p.direction === 'long');
  const shorts = all.filter((p) => p.direction === 'short');
  const byAsset = { equity: { total: 0, hits: 0 }, crypto: { total: 0, hits: 0 } };
  for (const p of all) {
    const key = p.assetClass === 'crypto' ? 'crypto' : 'equity';
    byAsset[key].total += 1;
    if (p.correct) byAsset[key].hits += 1;
  }

  // Build daily accuracy series (last 14 days)
  const byDay = {};
  for (const p of all) {
    const day = (p.resolvedAt || p.resolveAt || p.createdAt).slice(0, 10);
    if (!byDay[day]) byDay[day] = { total: 0, hits: 0 };
    byDay[day].total += 1;
    if (p.correct) byDay[day].hits += 1;
  }
  const series = Object.keys(byDay)
    .sort()
    .slice(-14)
    .map((day) => ({
      day,
      accuracy: byDay[day].total ? byDay[day].hits / byDay[day].total : 0,
      total: byDay[day].total,
      hits: byDay[day].hits,
    }));

  return {
    total,
    hits,
    misses: total - hits,
    accuracy: total ? hits / total : null,
    longAccuracy: longs.length ? longs.filter((p) => p.correct).length / longs.length : null,
    shortAccuracy: shorts.length ? shorts.filter((p) => p.correct).length / shorts.length : null,
    byAsset,
    series,
    open: store.getPredictions().filter((p) => p.status === 'open').length,
  };
}
