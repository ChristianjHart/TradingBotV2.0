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

import { forecastFacts } from '../public/js/kronos-logic.js';
import { MORE_STORE_KEY, parseMore, SECONDARY_KEYS } from '../public/js/collapse-logic.js';

test('forecastFacts explains an odd 0%: the median falls while a long needs a rise', () => {
  const f = forecastFacts({ side: 'long', entry: 100, stopLoss: 98, takeProfit: 103.5, lastClose: 100, horizonHours: 3, band: { p10: [99.2, 98.8, 98.4], p50: [99.7, 99.5, 99.2], p90: [100.1, 100.2, 100.3] } });
  assert.equal(f.helps, false);
  assert.ok(f.median < 0 && Math.abs(f.target - 3.5) < 1e-9 && Math.abs(f.stop + 2) < 1e-9);
  assert.match(f.sentence, /expects the price to fall over 3h/);
  assert.match(f.sentence, /works against this trade/);
  assert.equal(f.warning, '');
});

test('forecastFacts flags a flat forecast and identical paths', () => {
  const flat = forecastFacts({ side: 'short', entry: 100, stopLoss: 102, takeProfit: 96, lastClose: 100, band: { p10: [100, 100], p50: [100, 100], p90: [100, 100] } });
  assert.match(flat.sentence, /stay about flat/);
  assert.match(flat.sentence, /ends slightly behind after costs/);
  assert.match(flat.warning, /almost identical/);
  assert.equal(forecastFacts({ band: null }), null);
});

test('chartSvg with levels keeps far-away stop and target in view', () => {
  const it = { side: 'long', entry: 100, stopLoss: 90, takeProfit: 120, lastClose: 100, band: { p10: [99, 99], p50: [100, 100], p90: [101, 101] }, actual: [] };
  assert.doesNotMatch(chartSvg(it), /kr-stop|kr-tgt/);
  assert.match(chartSvg(it, { levels: true }), /kr-stop/);
  assert.match(chartSvg(it, { levels: true }), /kr-tgt/);
});

test('"More sections": eight secondary sections, off unless remembered', () => {
  assert.equal(SECONDARY_KEYS.length, 8);
  assert.ok(!SECONDARY_KEYS.includes('pos') && !SECONDARY_KEYS.includes('perf') && !SECONDARY_KEYS.includes('review'));
  assert.equal(parseMore('1'), true);
  assert.equal(parseMore(null), false);
  assert.equal(parseMore('garbage'), false);
  assert.equal(MORE_STORE_KEY, 'tb_dash_more');
});

test('forecastFacts notices when wicks, not closes, hit the stop', () => {
  const base = { side: 'long', entry: 100, stopLoss: 97, takeProfit: 104, lastClose: 100, horizonHours: 2, band: { p10: [99.5, 99.2], p50: [100, 100], p90: [100.5, 100.8] } };
  assert.match(forecastFacts({ ...base, stats: { pStop: 0.8 } }).wicks, /short spikes/);
  assert.equal(forecastFacts({ ...base, stats: { pStop: 0.2 } }).wicks, '');
  assert.equal(forecastFacts({ ...base, stats: { pStop: 0.8 }, stopLoss: 99.9 }).wicks, '');
});
