#!/usr/bin/env node
// How trustworthy is the loss review? This script measures it.
//   node scripts/review-sim.mjs            (about 1 minute)
// 1. FALSE ALARMS: trades whose results are pure luck. How often does the review still name a leak or an edge?
// 2. DETECTION: trades where one group (shorts in a rising market) really is worse. How often does the review find it?
// Win/loss is simple on purpose: a win pays +1.5R, a loss costs -1R. A 40% win rate is exactly break-even.
import { buildReview } from '../server/services/review.js';

let seed = 12345;
const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const SYMS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'TSLA', 'META', 'JPM', 'XOM', 'COIN', 'BTC/USD', 'ETH/USD', 'LLY', 'CAT', 'WMT'];
const REG = ['risk-on', 'risk-off', 'mixed'];

function make(n, leak = null) {
  const t0 = Date.parse('2026-09-20T14:00:00Z');
  return Array.from({ length: n }, (_, i) => {
    const symbol = pick(SYMS);
    const side = symbol.includes('/') ? 'long' : pick(['long', 'short']);
    const confidence = 0.55 + rnd() * 0.4;
    const regime = pick(REG);
    const win = rnd() < (leak && leak(side, regime) ? 0.15 : 0.4);
    const dir = side === 'long' ? 1 : -1;
    return {
      id: `p${i}`, symbol, side, status: i % 2 ? 'approved' : 'rejected', decidedBy: 'user', entry: 100, stopLoss: 100 - dir * 2, takeProfit: 100 + dir * 3.5, allocationUsd: 5000,
      confidence, createdAt: new Date(t0 + i * 3 * 3600e3).toISOString(), regime: `${regime}: x`, notes: { sentiment: rnd() * 2 - 1 }, setup: { rsi: 30 + rnd() * 50 },
      shadow: { hypotheticalPnl: (win ? 1.5 : -1) * 100, exitReason: win ? 'take-profit' : 'stop-loss' },
    };
  });
}

const TRIALS = 500;
const pct = (x) => `${((100 * x) / TRIALS).toFixed(0)}%`;
console.log('FALSE ALARMS (results are pure luck):');
for (const n of [30, 60, 120, 240, 400]) {
  let flagged = 0;
  for (let k = 0; k < TRIALS; k++) {
    const r = buildReview({ proposals: make(n) });
    if (r.leaks.length || r.edges.length) flagged++;
  }
  console.log(`  ${String(n).padStart(3)} scored outcomes: a pattern was named in ${pct(flagged)} of reviews`);
}
console.log('DETECTION (shorts in a risk-on market win 15% of the time instead of 40%):');
for (const n of [30, 60, 120, 240, 400]) {
  let found = 0;
  for (let k = 0; k < TRIALS; k++) {
    const r = buildReview({ proposals: make(n, (side, regime) => side === 'short' && regime === 'risk-on') });
    if (r.leaks.some((l) => /Shorts/.test(l.label))) found++;
  }
  console.log(`  ${String(n).padStart(3)} scored outcomes: found in ${pct(found)} of reviews`);
}
