import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runProblem, aiBlocked, runDoneText, approveProblem, approveAllOutcome, approveAllPlan, timeLeft, proposalView, axisPos, shadowView, outcomeText,
  budgetLevel, budgetView, validateBudgetInput, validateRange, netEdgeFormula, baselineVerdicts,
} from '../public/js/ai-logic.js';
import { stepperState } from '../public/js/run-logic.js';

test('runProblem maps every server code to an explanation and the right fix', () => {
  assert.equal(runProblem({ stage: 'done' }), null);
  assert.equal(runProblem(null), null);
  const nk = runProblem({ stage: 'blocked', code: 'no_api_key', error: 'No key' });
  assert.equal(nk.tone, 'blocked');
  assert.match(nk.actions[0].label, /OpenRouter key/);
  assert.equal(nk.actions[0].href, '#settings/account');
  assert.equal(nk.detail, 'No key');
  const be = runProblem({ stage: 'blocked', code: 'budget_exhausted' });
  assert.match(be.actions[0].label, /Raise the cap/);
  assert.equal(be.actions[0].href, '#settings/budget');
  for (const code of ['rate_limited', 'timeout', 'model_unavailable', 'upstream_error']) {
    const p = runProblem({ stage: 'error', code, error: 'x' });
    assert.equal(p.tone, 'error');
    assert.ok(p.actions.some((a) => a.href === '#settings/models' && /another model/.test(a.label)), code);
  }
  assert.ok(runProblem({ stage: 'error', code: 'invalid_output' }).actions.some((a) => a.id === 'retry'));
  const unknown = runProblem({ stage: 'error', code: 'weird', error: 'boom' });
  assert.equal(unknown.code, 'run_failed');
  assert.ok(unknown.actions.some((a) => a.id === 'retry'));
});

test('aiBlocked explains why RUN is disabled', () => {
  assert.equal(aiBlocked({ ready: true }), null);
  assert.equal(aiBlocked(undefined), null);
  assert.equal(aiBlocked({ ready: false, blockedReason: 'no_api_key' }).actions[0].href, '#settings/account');
  assert.match(aiBlocked({ ready: false, blockedReason: 'budget_exhausted' }).reason, /budget/i);
});

test('runDoneText never implies trades opened by themselves', () => {
  assert.match(runDoneText({ picks: 20, proposals: 2 }), /2 proposals are waiting for your approval/);
  assert.match(runDoneText({ picks: 20, proposals: 1 }), /1 proposal is waiting/);
  assert.match(runDoneText({ picks: 20, proposals: 0 }), /proposed no trades/);
  assert.doesNotMatch(runDoneText({ picks: 5, proposals: 1, opened: 3 }), /opened/);
});

test('stepperState: blocked runs show no progress and kind blocked', () => {
  const v = stepperState({ stage: 'blocked', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), running: false }, Date.now());
  assert.equal(v.kind, 'blocked');
  assert.ok(v.steps.every((s) => s.state === 'pending'));
});

test('approveProblem maps each 409 code to a clear message with the fix', () => {
  const pm = approveProblem({ status: 409, code: 'price_moved', details: { proposalEntry: 100, freshPrice: 103, driftPct: 3, thresholdPct: 1 } }, 'IWM');
  assert.match(pm.message, /\$100\.00 then, \$103\.00 now/);
  assert.match(pm.message, /\+3\.00%, limit 1%/);
  assert.ok(pm.actions.some((a) => a.id === 'rerun'));
  assert.ok(approveProblem({ code: 'expired' }).refresh);
  assert.match(approveProblem({ code: 'risk_blocked', details: { reason: 'class cap 60% exceeded' } }).message, /class cap 60% exceeded/);
  assert.match(approveProblem({ code: 'stale_quote', details: { symbol: 'AAPL' } }).message, /market is probably closed/);
  const ns = approveProblem({ code: 'no_slots' });
  assert.match(ns.message, /Close a position first/);
  assert.equal(ns.actions[0].target, 'pos-open');
  const w = approveProblem({ code: 'worker_not_running' });
  assert.match(w.message, /START/);
  assert.equal(w.actions[0].id, 'start');
  const ad = approveProblem({ code: 'already_decided', details: { status: 'rejected' } });
  assert.match(ad.message, /already rejected/);
  assert.ok(ad.refresh);
  assert.ok(approveProblem({ status: 404 }).refresh);
  assert.equal(approveProblem({ status: 0, network: true }).code, 'network');
  assert.match(approveProblem({ status: 500, message: 'kaboom' }).message, /kaboom/);
  assert.equal(approveProblem({ data: { code: 'expired' } }).code, 'expired');
});

test('approveAllOutcome and approveAllPlan', () => {
  const o = approveAllOutcome({ approved: [{ id: 'a', symbol: 'A' }], failed: [{ id: 'b', symbol: 'B', code: 'no_slots', error: 'x' }] });
  assert.equal(o.tone, 'warn');
  assert.equal(o.failures[0].code, 'no_slots');
  assert.match(o.headline, /Approved 1, 1 could not/);
  assert.equal(approveAllOutcome({ approved: [], failed: [{ id: 'b', code: 'expired' }] }).tone, 'error');
  assert.equal(approveAllOutcome({ approved: [{}, {}], failed: [] }).tone, 'success');
  const now = Date.now();
  const plan = approveAllPlan([
    { symbol: 'A', side: 'long', allocationUsd: 100, expiresAt: new Date(now + 1e6).toISOString() },
    { symbol: 'B', side: 'short', allocationUsd: 50, expiresAt: new Date(now - 1).toISOString() },
    { symbol: 'C', side: 'long', allocationUsd: 70, expiresAt: new Date(now + 1e6).toISOString(), riskCheck: { ok: false, notes: ['class cap'] } },
  ], now);
  assert.deepEqual(plan.will.map((x) => x.symbol), ['A']);
  assert.deepEqual(plan.wont.map((x) => [x.symbol, x.why]), [['B', 'expired'], ['C', 'class cap']]);
  assert.equal(plan.totalUsd, 100);
});

test('timeLeft formats the countdown and levels', () => {
  const now = 1_000_000;
  assert.deepEqual(timeLeft(new Date(now + 5 * 3600e3 + 59 * 60e3).toISOString(), now).text, '5h 59m');
  assert.equal(timeLeft(new Date(now + 4 * 60e3 + 12e3).toISOString(), now).text, '4m 12s');
  assert.equal(timeLeft(new Date(now + 4 * 60e3).toISOString(), now).level, 'urgent');
  assert.equal(timeLeft(new Date(now + 20 * 60e3).toISOString(), now).level, 'soon');
  assert.equal(timeLeft(new Date(now + 3 * 3600e3).toISOString(), now).level, 'ok');
  assert.deepEqual([timeLeft(new Date(now - 5).toISOString(), now).text, timeLeft(new Date(now - 5).toISOString(), now).level], ['expired', 'expired']);
  assert.equal(timeLeft('', now).text, '—');
  assert.equal(timeLeft('garbage', now).text, '—');
});

test('proposalView builds the card view-model for longs and shorts', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const v = proposalView({
    id: 'p1', symbol: 'IWM', side: 'long', allocationUsd: 5000, entry: 100, stopLoss: 98, takeProfit: 106, confidence: 0.76, reason: '<b>x</b>', source: 'demo', models: { trader: 'mock-llm' },
    expiresAt: new Date(now + 3600e3).toISOString(), riskCheck: { ok: true, grossExposureAfterPct: 15, riskUsd: 110, riskPct: 0.11, assetClass: 'equity', classExposureAfterPct: 15, limits: { maxGrossPct: 80, maxClassPct: 60 }, notes: ['n1'] },
  }, now);
  assert.equal(v.stopPct, 2);
  assert.equal(v.targetPct, 6);
  assert.equal(v.rr, 3);
  assert.equal(v.confidencePct, 76);
  assert.equal(v.demo, true);
  assert.equal(v.reason, '<b>x</b>'); // raw: escaping happens at render time
  assert.ok(Math.abs(v.entryAt - 0.25) < 1e-9);
  assert.equal(v.risk.ok, true);
  assert.equal(v.risk.lines.length, 3);
  assert.equal(v.left.text, '1h 00m');
  const s = proposalView({ id: 's', symbol: 'X', side: 'short', entry: 100, stopLoss: 103, takeProfit: 94, allocationUsd: 1 }, now);
  assert.ok(Math.abs(s.entryAt - 3 / 9) < 1e-9); // stop is always the left end of the bar
  assert.equal(proposalView({ id: 'z', entry: null }, now).rr, null);
  assert.equal(axisPos(50, 10, 10), 0.5);
  assert.equal(axisPos(500, 0, 100), 1);
  assert.equal(proposalView({ id: 'r', riskCheck: { ok: false, notes: [] } }, now).risk.ok, false);
});

test('shadowView uses avoided-loss / missed-gain language', () => {
  const sh = (pnl, extra = {}) => ({ scoredAt: 'x', hypotheticalPnl: pnl, spyPnl: 5, ...extra });
  const rej = shadowView({ status: 'rejected', shadow: sh(-120.5) });
  assert.deepEqual([rej.tone, rej.label, rej.amount], ['good', 'Avoided loss', 120.5]);
  const miss = shadowView({ status: 'expired', shadow: sh(64) });
  assert.deepEqual([miss.tone, miss.label], ['bad', 'Missed gain']);
  assert.match(miss.detail, /SPY buy-and-hold: \+\$5\.00/);
  assert.equal(shadowView({ status: 'superseded', shadow: sh(0) }).tone, 'neutral');
  assert.equal(shadowView({ status: 'approved', shadow: sh(10) }).label, 'Result at horizon');
  assert.equal(shadowView({ status: 'rejected', shadow: { unscorable: true } }).label, 'Can’t be scored');
  assert.equal(shadowView({ status: 'rejected', shadow: null }).tone, 'pending');
  assert.equal(shadowView({ status: 'pending' }).tone, 'none');
  assert.match(shadowView({ status: 'rejected', shadow: sh(-1, { partial: true }) }).detail, /partial/);
});

test('outcomeText', () => {
  assert.match(outcomeText({ status: 'approved', decidedBy: 'auto', positionId: 'p' }), /Approved by auto-approve: position opened/);
  assert.match(outcomeText({ status: 'rejected', decidedBy: 'user', rejectReason: 'too risky' }), /Rejected by you: too risky/);
  assert.match(outcomeText({ status: 'expired' }), /Expired/);
  assert.match(outcomeText({ status: 'superseded' }), /newer run/);
});

test('budget level derivation and view', () => {
  assert.equal(budgetLevel(0), 'ok');
  assert.equal(budgetLevel(69.9), 'ok');
  assert.equal(budgetLevel(70), 'warn');
  assert.equal(budgetLevel(99.9), 'warn');
  assert.equal(budgetLevel(100), 'blocked');
  assert.equal(budgetLevel(NaN), 'ok');
  const v = budgetView({ capUsd: 20, spentUsd: 14.5, pct: 72.5, projectedMonthEndUsd: 25, avgCostPerRun: 0.25, resetsAt: '2026-10-01T00:00:00Z', last7d: [{ day: '2026-09-29', usd: 1 }, { day: '2026-09-30', usd: 0 }] });
  assert.equal(v.level, 'warn');
  assert.equal(v.levelLabel, 'Getting high');
  assert.equal(v.projectedOver, true);
  assert.equal(v.bars[0].h, 100);
  assert.equal(v.bars[1].h, 2);
  assert.match(v.ariaText, /73 percent|72 percent/);
  assert.equal(budgetView({ capUsd: 20, spentUsd: 25 }).pct, 100);
  assert.equal(budgetView({ capUsd: 20, spentUsd: 25 }).level, 'blocked');
  assert.equal(budgetView(null), null);
  assert.equal(budgetView({ capUsd: 20, spentUsd: 1, level: 'ok', pct: 99 }).level, 'ok'); // the server's level wins
});

test('cap and range validation', () => {
  assert.deepEqual(validateBudgetInput('20'), { ok: true, value: 20, needsConfirm: false, error: '' });
  assert.equal(validateBudgetInput('$25.5').needsConfirm, true);
  assert.equal(validateBudgetInput('20.001').ok, false);
  assert.equal(validateBudgetInput('').ok, false);
  assert.equal(validateBudgetInput('-3').ok, false);
  assert.equal(validateBudgetInput('1001').ok, false);
  assert.equal(validateBudgetInput('0').ok, true);
  assert.equal(validateRange('5', { min: 0.1, max: 25, label: 'x' }).value, 5);
  assert.match(validateRange('26', { min: 0.1, max: 25, label: 'Max' }).error, /between 0.1 and 25/);
  assert.equal(validateRange('abc', { min: 0, max: 1, label: 'x' }).ok, false);
  assert.equal(validateRange('1.5', { min: 0, max: 10, label: 'x', integer: true }).ok, false);
});

test('net edge formula and baseline verdicts guard small samples', () => {
  assert.match(netEdgeFormula({ drawdown: 0.5, avoided: 1 }), /0.5 × max drawdown \+ 1 × avoided loss/);
  const low = baselineVerdicts({ ai: { n: 2 }, spyHold: { n: 30 }, randomPicks: { n: 30 }, beats: { spyHold: true, randomPicks: false } });
  assert.ok(low.every((v) => v.tone === 'neutral' && /Not enough data/.test(v.text)));
  const ok = baselineVerdicts({ ai: { n: 20 }, spyHold: { n: 20 }, randomPicks: { n: 20 }, beats: { spyHold: true, randomPicks: false } });
  assert.deepEqual(ok.map((v) => v.tone), ['good', 'bad']);
  assert.match(ok[0].text, /ahead of SPY hold/);
  assert.equal(baselineVerdicts({ ai: { n: 20 }, spyHold: { n: 20 }, randomPicks: { n: 20 }, beats: { spyHold: null, randomPicks: null } })[0].tone, 'neutral');
  assert.deepEqual(baselineVerdicts(null), []);
});

test('runDoneText reflects proposals already decided', () => {
  assert.match(runDoneText({ picks: 9, proposals: 2 }, 0), /none are waiting now/);
});
