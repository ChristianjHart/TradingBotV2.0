import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeView, checkAllPlan, scorecardView, judgeProblem, JUDGE_ERRORS, pct } from '../public/js/judge-logic.js';

const run = (verdict, p, extra = {}) => ({ verdict, pProfit: p, keyRisk: 'gap risk', reason: 'ok', ...extra });
const judge = (over = {}) => ({
  at: '2026-10-01T15:00:00Z', model: 'vendor/m', source: 'ai', runsRequested: 3, failed: 0, costUsd: 0.0012, breakEvenWinRate: 0.364,
  runs: [run('take', 0.6), run('take', 0.7), run('skip', 0.4)],
  stats: { n: 3, take: 2, skip: 1, call: 'take', agreement: 0.667, consensus: 'majority', meanP: 0.567, minP: 0.4, maxP: 0.7, sdP: 0.15, stable: false, edge: 0.2, incoherent: false },
  ...over,
});

test('judgeView: verdict, probability, range, agreement and the break-even bar in plain words', () => {
  assert.equal(judgeView(null), null);
  assert.equal(judgeView({}), null);
  const v = judgeView(judge());
  assert.deepEqual([v.label, v.tone, v.pText, v.rangeText], ['TAKE', 'good', '57%', '40% to 70%']);
  assert.equal(v.agreeText, '2 of 3 agree');
  assert.equal(v.needText, '36% needed to break even');
  assert.equal(v.stableText, 'The runs gave very different numbers.');
  assert.equal(v.steady, false);
  assert.equal(v.costText, 'Cost $0.0012.');
  assert.equal(v.summary, 'TAKE 57%');
  assert.equal(v.runs.length, 3);
  assert.deepEqual(v.runs.map((r) => [r.label, r.pText]), [['TAKE', '60%'], ['TAKE', '70%'], ['SKIP', '40%']]);
});

test('judgeView: skip, split, single run, failed runs, contradictions and demo mode', () => {
  const skip = judgeView(judge({ stats: { ...judge().stats, call: 'skip', take: 1, skip: 2, meanP: 0.3, minP: 0.3, maxP: 0.3 } }));
  assert.deepEqual([skip.label, skip.tone, skip.rangeText], ['SKIP', 'bad', '']);
  const split = judgeView(judge({ runs: [run('take', 0.5), run('skip', 0.3)], stats: { n: 2, take: 1, skip: 1, call: 'split', meanP: 0.4, minP: 0.3, maxP: 0.5, stable: true } }));
  assert.deepEqual([split.label, split.tone, split.agreeText], ['SPLIT', 'warn', '1 say take, 1 say skip']);
  const one = judgeView(judge({ runs: [run('take', 0.6)], stats: { n: 1, take: 1, skip: 0, call: 'take', meanP: 0.6, minP: 0.6, maxP: 0.6 } }));
  assert.equal(one.agreeText, 'one run only');
  assert.equal(one.stableText, '');
  assert.equal(one.steady, false);
  const steady = judgeView(judge({ stats: { ...judge().stats, stable: true } }));
  assert.deepEqual([steady.steady, steady.stableText], [true, ''], 'good news is not a warning');
  assert.equal(judgeView(judge({ failed: 1 })).failedText, '1 of 3 runs failed.');
  assert.match(judgeView(judge({ stats: { ...judge().stats, incoherent: true } })).incoherentText, /says TAKE but puts the chance of profit below break-even/);
  assert.match(judgeView(judge({ stats: { ...judge().stats, call: 'skip', incoherent: true } })).incoherentText, /says SKIP but puts the chance of profit above break-even/);
  assert.equal(judgeView(judge({ source: 'demo', costUsd: 0 })).demo, true);
  assert.equal(judgeView(judge({ costUsd: 0 })).costText, '');
});

test('checkAllPlan counts only pending proposals that have no check yet', () => {
  const list = [{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending', judge: {} }, { id: 'c', status: 'approved' }, { id: 'd', status: 'pending' }];
  assert.deepEqual(checkAllPlan(list, 3), { count: 2, calls: 6, ids: ['a', 'd'] });
  assert.deepEqual(checkAllPlan([], 3), { count: 0, calls: 0, ids: [] });
  assert.equal(checkAllPlan(null).count, 0);
});

const card = (over = {}) => ({
  enough: true, judged: 50, late: 0, split: 0, difference: 1.1, pValue: 0.004, verdict: 'v',
  take: { n: 30, wins: 20, winRate: 0.667, avgR: 0.5, pnl: 2000 }, skip: { n: 20, wins: 4, winRate: 0.2, avgR: -0.6, pnl: -1000 },
  filter: { allPnl: 1000, takeOnlyPnl: 2000, change: 1000 }, calibration: { skill: 0.12, baseWinRate: 0.48, avgSaid: 0.5 }, ...over,
});

test('scorecardView: every sentence is plain and honest about luck, the filter effect and late checks', () => {
  assert.equal(scorecardView(null), null);
  const v = scorecardView(card());
  assert.equal(v.tone, 'good');
  assert.equal(v.take.text, '30 trades · 20 won (67%) · average +0.50R');
  assert.equal(v.skip.pnl, '−$1,000');
  assert.equal(v.luck, 'Chance the gap is luck: under 1 in 100.');
  assert.equal(v.filterText, 'Taking only the TAKE calls would have made +$2,000 instead of +$1,000 (better by $1,000).');
  assert.match(v.calText, /beat just guessing the average win rate \(48%\)\. It said 50% on average\./);
  assert.equal(v.lateText, '');
  assert.equal(scorecardView(card({ late: 4 })).lateText, '4 checks were made after the result was known and are not counted.');
  assert.equal(scorecardView(card({ split: 2 })).splitText, '2 split calls are left out.');
  assert.equal(scorecardView(card({ pValue: 0.2 })).tone, 'warn');
  assert.equal(scorecardView(card({ difference: -0.3, pValue: 0.5 })).tone, 'bad');
  assert.match(scorecardView(card({ calibration: { skill: -0.05, baseWinRate: 0.5, avgSaid: 0.6 } })).calText, /did not beat/);
  const small = scorecardView(card({ enough: false, pValue: null }));
  assert.equal(small.tone, 'none');
  assert.equal(small.luck, '');
  assert.equal(small.filterText, '');
});

test('judgeProblem gives plain words for each failure and never shows raw codes to the user', () => {
  for (const code of Object.keys(JUDGE_ERRORS)) assert.equal(judgeProblem({ code }), JUDGE_ERRORS[code]);
  assert.match(judgeProblem({ network: true }), /Cannot reach the server/);
  assert.equal(judgeProblem({ message: 'boom' }), 'boom');
  assert.equal(judgeProblem(null), 'The check could not run.');
  assert.equal(pct(0.567), '57%');
  assert.equal(pct(null), '—');
});
