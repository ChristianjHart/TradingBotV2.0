import test from 'node:test';
import assert from 'node:assert/strict';
import { chartSvg, compareSummary, itemView } from '../public/js/kronos-logic.js';

const item = (over = {}) => ({ symbol: 'NVDA', side: 'long', call: 'take', meanP: 0.6, lastClose: 100, horizonHours: 3, entry: 100, stopLoss: 96, takeProfit: 104, complete: true, band: { p10: [99, 98.5, 98], p50: [100.4, 100.8, 101.2], p90: [101.5, 102.5, 103.5] }, actual: [{ c: 100.2 }, { c: 101 }, { c: 102 }], score: { hours: 3, inside: 1, direction: true, medianErrorPct: -0.8 }, ...over });

test('chartSvg draws band, median and real line, and no NaN', () => {
  const svg = chartSvg(item());
  assert.match(svg, /kr-band/);
  assert.match(svg, /kr-med/);
  assert.match(svg, /kr-real/);
  assert.doesNotMatch(svg, /NaN|undefined/);
});

test('chartSvg hides lines outside the price range and the real line when no prices yet', () => {
  const svg = chartSvg(item({ stopLoss: 50, actual: [] }));
  assert.doesNotMatch(svg, /kr-stop/);
  assert.doesNotMatch(svg, /kr-real/);
  assert.match(chartSvg(item({ takeProfit: 102.5 })), /kr-tgt/);
  assert.equal(chartSvg({}), '');
  assert.doesNotMatch(chartSvg(item({ band: { p10: [5, 5], p50: [5, 5], p90: [5, 5] }, lastClose: 5, actual: [] })), /NaN/);
});

test('itemView words', () => {
  const v = itemView(item());
  assert.equal(v.head, 'NVDA long · Kronos said TAKE (60% chance of profit)');
  assert.equal(v.state, 'Finished');
  assert.match(v.detail, /real price \+2\.0%/);
  assert.equal(v.right, 'right direction');
  assert.equal(itemView(item({ complete: false, actual: [] })).state, 'Waiting for prices');
  assert.equal(itemView(item({ score: { ...item().score, direction: false } })).right, 'wrong direction');
});

test('compareSummary is honest about small samples', () => {
  assert.match(compareSummary({ forecasts: 0 }), /No forecasts/);
  assert.match(compareSummary({ forecasts: 4, complete: 0 }), /nothing to score/);
  assert.match(compareSummary({ forecasts: 9, complete: 5, inside: 0.72, directionRight: 0.6 }), /72%.*60%.*hint, not proof/);
});
