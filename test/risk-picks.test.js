import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEntry, dailyPnl, isHalted, limitsFrom } from '../server/services/risk.js';
import { cleanPicks, calibration, pickAccuracy, priceAt, scorePick } from '../server/services/picks.js';
import { computePerformance, maxDrawdownPct } from '../server/services/performance.js';

const limits = limitsFrom({});
const openPos = (symbol, allocation) => ({ symbol, allocation, status: 'open' });

test('checkEntry enforces group count and exposure headroom', () => {
  const tech = ['AAPL', 'MSFT', 'NVDA'].map((s) => openPos(s, 1000));
  assert.equal(checkEntry({ open: tech, equity: 100_000, symbol: 'AMD', alloc: 1000, limits }).ok, false);
  const r = checkEntry({ open: [openPos('JPM', 55_000)], equity: 100_000, symbol: 'XOM', alloc: 20_000, limits });
  assert.equal(r.ok, true);
  assert.equal(r.alloc, 5000); // 60% equity-class cap
  assert.equal(checkEntry({ open: [openPos('JPM', 60_000)], equity: 100_000, symbol: 'XOM', alloc: 1000, limits }).ok, false);
});

test('daily loss halt', () => {
  const closed = [{ status: 'closed', closedAt: new Date().toISOString(), pnl: -2500 }];
  assert.equal(isHalted(dailyPnl(closed, -600), 100_000, limits), true);
  assert.equal(isHalted(dailyPnl(closed, 0), 100_000, limits), false);
});

test('cleanPicks removes crypto shorts, duplicates and caps one-sided books', () => {
  const mk = (symbol, direction, confidence) => ({ symbol, direction, confidence });
  const out = cleanPicks([mk('BTC/USD', 'short', 0.9), mk('AAPL', 'long', 0.8), mk('AAPL', 'long', 0.7)]);
  assert.deepEqual(out.map((p) => p.symbol), ['AAPL']);
  const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((s, i) => mk(s, 'long', 0.9 - i * 0.01));
  assert.equal(cleanPicks(many, { maxShare: 0.7 }).length, 7);
});

test('pick scoring, calibration and accuracy', () => {
  const bars = [{ t: '2026-01-01T00:00:00Z', o: 1, c: 2 }, { t: '2026-01-01T01:00:00Z', o: 3, c: 4 }];
  assert.equal(priceAt(bars, Date.parse('2026-01-01T00:30:00Z')), 3);
  assert.equal(priceAt(bars, Date.parse('2026-01-01T01:30:00Z')), 4);
  assert.equal(priceAt(bars, Date.parse('2026-01-02T00:00:00Z')), null);
  const hit = scorePick({ direction: 'long', price: 100, confidence: 0.65 }, 102);
  const miss = scorePick({ direction: 'short', price: 100, confidence: 0.62 }, 102);
  assert.equal(hit.hit, true);
  assert.equal(miss.hit, false);
  assert.deepEqual(calibration([hit, miss, { scored: false, confidence: 0.9 }]), [{ bucket: '60-70%', n: 2, hitRate: 0.5 }]);
  assert.deepEqual(pickAccuracy([hit, miss]), { hits: 1, total: 2 });
});

test('computePerformance summarises closed trades and drawdown', () => {
  const p = (pnl, source, t) => ({ status: 'closed', pnl, source, entry: 100, stopLoss: 95, initialStop: 95, qty: 10, openedAt: t, closedAt: t });
  const perf = computePerformance({
    positions: [p(100, 'ai', '2026-01-01T00:00:00Z'), p(-50, 'demo', '2026-01-02T00:00:00Z')],
    startingEquity: 1000,
  });
  assert.equal(perf.closed, 2);
  assert.equal(perf.winRate, 0.5);
  assert.equal(perf.realizedPnl, 50);
  assert.equal(perf.avgR, 0.5); // (100/50 + -50/50)/2
  assert.equal(perf.byBot.ai.pnl, 100);
  assert.equal(perf.equityCurve.at(-1).equity, 1050);
  assert.equal(maxDrawdownPct([{ equity: 100 }, { equity: 80 }, { equity: 90 }]), 20);
});
