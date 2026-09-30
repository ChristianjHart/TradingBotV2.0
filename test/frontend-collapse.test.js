import test from 'node:test';
import assert from 'node:assert/strict';
import { isSectionOpen, parseSectionPrefs, SECTION_KEYS, sectionLabel, sectionSummary, withSection } from '../public/js/collapse-logic.js';

test('defaults: only positions is open', () => {
  assert.deepEqual(SECTION_KEYS.filter((k) => isSectionOpen({}, k)), ['pos']);
});

test('parseSectionPrefs tolerates corrupt, foreign and non-boolean input', () => {
  assert.deepEqual(parseSectionPrefs(null), {});
  assert.deepEqual(parseSectionPrefs('{nope'), {});
  assert.deepEqual(parseSectionPrefs('[1]'), {});
  assert.deepEqual(parseSectionPrefs('{"budget":true,"pos":"no","evil":true}'), { budget: true });
});

test('withSection keeps only non-default values and ignores unknown keys', () => {
  let p = withSection({}, 'budget', true);
  assert.deepEqual(p, { budget: true });
  assert.equal(isSectionOpen(p, 'budget'), true);
  p = withSection(p, 'budget', false);
  assert.deepEqual(p, {});
  p = withSection(p, 'pos', false);
  assert.equal(isSectionOpen(p, 'pos'), false);
  assert.deepEqual(withSection({ pos: false }, 'nope', true), { pos: false });
});

test('sectionSummary shows the key number', () => {
  assert.equal(sectionSummary('budget', { spentText: '$0.00', capText: '$20' }), '$0.00 of $20');
  assert.equal(sectionSummary('budget', {}), '');
  assert.equal(sectionSummary('pos', { openCount: 3, unrealized: 42.4 }), '3 open · +$42');
  assert.equal(sectionSummary('pos', { openCount: 2, unrealized: -10 }), '2 open · -$10');
  assert.equal(sectionSummary('pos', { openCount: 0 }), 'none open');
  assert.equal(sectionSummary('pos', { openCount: null }), '');
  assert.equal(sectionSummary('perf', { netEdge: 0 }), 'net edge $0');
  assert.equal(sectionSummary('perf', { netEdge: NaN, closed: 0 }), 'no closed trades yet');
  assert.equal(sectionSummary('picks', { picksCount: 20 }), '20');
  assert.equal(sectionSummary('acc', { closed: 4, winRatePct: 62.5 }), '63% win rate');
  assert.equal(sectionSummary('alloc', { cashPct: 90.4 }), '90% cash');
  assert.equal(sectionSummary('sum', { proposalCount: 3 }), '3 proposed');
});

test('sectionLabel joins title and summary', () => {
  assert.equal(sectionLabel('budget', '$1 of $20'), 'Budget, $1 of $20');
  assert.equal(sectionLabel('picks', ''), 'Top picks');
});
