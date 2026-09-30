import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blendedPrice, formatPrice, formatContext, sortModels, filterModels, paginate, priceLine, validModelId, estimateView, combineEstimates, currentModel, isDefault, catalogStatus,
} from '../public/js/models-logic.js';

const M = [
  { id: 'a/pricey', name: 'Pricey', promptPerM: 10, completionPerM: 30, contextLength: 200000, isFree: false },
  { id: 'b/free:free', name: 'Free One', promptPerM: 0, completionPerM: 0, contextLength: 131072, isFree: true, supportsJson: true },
  { id: 'c/unknown', name: 'Mystery', promptPerM: null, completionPerM: null, contextLength: null, isFree: false },
  { id: 'd/cheap', name: 'Cheap Mini', promptPerM: 0.15, completionPerM: 0.6, contextLength: 128000, isFree: false },
];

test('price and context formatting, with clear unknowns', () => {
  assert.equal(formatPrice(null), 'unknown');
  assert.equal(formatPrice(undefined), 'unknown');
  assert.equal(formatPrice(0), 'Free');
  assert.equal(formatPrice(0.15), '$0.15');
  assert.equal(formatPrice(0.0042), '$0.0042');
  assert.equal(formatPrice(3), '$3.00');
  assert.equal(formatPrice(150), '$150');
  assert.equal(formatContext(131072), '131k');
  assert.equal(formatContext(1_000_000), '1M');
  assert.equal(formatContext(null), '—');
  assert.equal(priceLine(M[0]), '$10.00 in / $30.00 out per 1M');
  assert.equal(priceLine(M[2]), 'price unknown');
  assert.equal(priceLine(M[1]), 'Free');
});

test('sortModels is cheapest first, unknown last, and does not mutate', () => {
  const copy = JSON.stringify(M);
  assert.deepEqual(sortModels(M).map((m) => m.id), ['b/free:free', 'd/cheap', 'a/pricey', 'c/unknown']);
  assert.equal(JSON.stringify(M), copy);
  assert.equal(blendedPrice(M[2]), Infinity);
  assert.equal(blendedPrice(M[1]), 0);
});

test('filterModels: text, free only, max price', () => {
  assert.deepEqual(filterModels(M, { q: 'mini cheap' }).map((m) => m.id), ['d/cheap']);
  assert.deepEqual(filterModels(M, { q: 'B/FREE' }).map((m) => m.id), ['b/free:free']);
  assert.deepEqual(filterModels(M, { freeOnly: true }).map((m) => m.id), ['b/free:free']);
  assert.deepEqual(filterModels(M, { maxPrice: 1 }).map((m) => m.id), ['b/free:free', 'd/cheap']);
  assert.deepEqual(filterModels(M, { maxPrice: '' }).length, 4);
  assert.deepEqual(filterModels(M, { maxPrice: 'abc' }).length, 4);
  assert.deepEqual(filterModels(null, {}), []);
});

test('paginate clamps pages', () => {
  const list = Array.from({ length: 60 }, (_, i) => i);
  const p = paginate(list, 2, 25);
  assert.deepEqual([p.page, p.pages, p.from, p.to, p.items.length], [2, 3, 26, 50, 25]);
  assert.equal(paginate(list, 99, 25).page, 3);
  assert.equal(paginate(list, 0, 25).page, 1);
  assert.deepEqual([paginate([], 1).pages, paginate([], 1).from], [1, 0]);
});

test('estimateView formats per-call cost, runs per month, free and unknown prices', () => {
  const v = estimateView({ basis: 'default', tokens: { prompt: 13000, completion: 1300, samples: 0 }, priceKnown: true, isFree: false, estCostPerRunUsd: 0.0027, estRunsPerMonthAtBudget: 7407, estRunsWithinRemaining: 6100, capUsd: 20 });
  assert.match(v.perCallText, /≈ \$0\.0027 per call/);
  assert.match(v.runsText, /7,?407 calls\/month at \$20\.00/);
  assert.match(v.basisText, /typical/);
  assert.match(estimateView({ basis: 'measured', tokens: { samples: 4 }, priceKnown: true, estCostPerRunUsd: 0.1, capUsd: 20 }).basisText, /4 of your past calls/);
  assert.equal(estimateView({ isFree: true, priceKnown: true }).perCallText, 'Free');
  assert.match(estimateView({ priceKnown: false, estCostPerRunUsd: null }).perCallText, /unknown/);
  assert.equal(estimateView(null).perCallText, '—');
});

test('combineEstimates: a full run is scanner + trader', () => {
  const a = { estCostPerRunUsd: 0.004, capUsd: 20, remainingUsd: 10 };
  const b = { estCostPerRunUsd: 0.006 };
  const c = combineEstimates(a, b);
  assert.equal(c.costUsd, 0.01);
  assert.equal(c.runsPerMonth, 2000);
  assert.equal(c.runsRemaining, 1000);
  assert.match(c.text, /runs\/month/);
  assert.equal(combineEstimates({ isFree: true }, { isFree: true }).free, true);
  assert.equal(combineEstimates({ isFree: true }, { estCostPerRunUsd: 0.01, capUsd: 20 }).costUsd, 0.01);
  assert.equal(combineEstimates({ estCostPerRunUsd: null }, b).known, false);
  assert.equal(combineEstimates(null, b).known, false);
});

test('selection helpers and catalog status', () => {
  const models = { scanner: 'x/one', trader: '', defaults: { scanner: 'x/one', trader: 'y/two' } };
  assert.equal(currentModel(models, 'trader'), 'y/two');
  assert.equal(isDefault(models, 'scanner'), true);
  assert.equal(isDefault({ ...models, scanner: 'other/m' }, 'scanner'), false);
  assert.equal(catalogStatus({ stale: false }).kind, 'ok');
  assert.equal(catalogStatus({ stale: true, error: 'HTTP 503' }).kind, 'stale');
  assert.equal(catalogStatus(null, { status: 502, code: 'catalog_unavailable' }).kind, 'unavailable');
  assert.equal(catalogStatus(null, { network: true }).kind, 'offline');
  assert.equal(validModelId('meta-llama/llama-3.1-70b-instruct:free'), true);
  assert.equal(validModelId('nope'), false);
});
