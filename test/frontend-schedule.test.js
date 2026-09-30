import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_IDS, skipReasonText, slotView, t12, nextRunView, triggerBadge, lastRunView, testFireMessage, forecastRow, forecastRows, forecastLine,
  experimentRow, validateCustomSlots, validateCryptoRuns, validateEventTriggers, scheduleSummary, isHHMM,
} from '../public/js/schedule-logic.js';

test('skip reasons map to plain words; unknown codes stay readable', () => {
  assert.match(skipReasonText('market_holiday'), /holiday/);
  assert.match(skipReasonText('budget_warn_event_dropped'), /budget/);
  assert.match(skipReasonText('older_than_grace'), /20 minutes/);
  assert.equal(skipReasonText('some_new_code'), 'some new code');
  assert.equal(skipReasonText(''), '');
});

test('slotView: status labels, tones, reason only for skipped/missed', () => {
  assert.deepEqual(['upcoming', 'fired', 'skipped', 'missed'].map((s) => slotView({ id: 'x', timeEt: '09:00', scope: 'stocks', status: s, reason: 'weekend' }).label), ['Upcoming', 'Ran', 'Skipped', 'Missed']);
  const v = slotView({ id: 'a', timeEt: '13:05', scope: 'all', status: 'skipped', reason: 'no_api_key' });
  assert.equal(v.time, '1:05 PM');
  assert.equal(v.scopeText, 'stocks + crypto');
  assert.match(v.reasonText, /OpenRouter/);
  assert.equal(slotView({ timeEt: '09:00', status: 'fired', reason: 'x' }).reasonText, '');
  assert.equal(slotView({ status: 'weird' }).status, 'upcoming');
  assert.equal(slotView({}).time, '—');
});

test('t12 and nextRunView', () => {
  assert.equal(t12('00:05'), '12:05 AM');
  assert.equal(t12('12:00'), '12:00 PM');
  const v = nextRunView('2026-10-01T13:00:00Z', 'America/Los_Angeles');
  assert.match(v.et, /9:00 AM ET$/);
  assert.match(v.local, /6:00 AM your time$/);
  assert.equal(nextRunView('2026-10-01T13:00:00Z', 'America/New_York').local, '');
  assert.deepEqual(nextRunView(null), { et: '', local: '' });
});

test('triggerBadge and lastRunView', () => {
  assert.equal(triggerBadge({ type: 'schedule', plan: 'A' }).label, 'Scheduled');
  assert.equal(triggerBadge({ type: 'event', reason: 'SPY -1.4%' }).detail, 'SPY -1.4%');
  assert.equal(triggerBadge({ type: 'test' }).label, 'Test');
  assert.equal(triggerBadge(null).label, 'Manual');
  const r = lastRunView({ at: 't', trigger: { type: 'schedule' }, status: 'skipped', reason: 'insufficient_budget', costUsd: 0, proposals: 0 });
  assert.equal(r.statusLabel, 'Skipped');
  assert.match(r.reasonText, /budget/);
  assert.equal(r.costText, '$0.00');
  assert.equal(lastRunView({ status: 'ok', costUsd: 0.0042, proposals: 3 }).costText, '$0.0042');
  assert.equal(lastRunView({ status: 'ok' }).costText, '—');
});

test('testFireMessage maps every 409/400/403 code to human text', () => {
  for (const code of ['worker_not_running', 'run_in_progress', 'no_api_key', 'budget_exhausted', 'insufficient_budget', 'unknown_slot']) {
    const m = testFireMessage({ status: code === 'unknown_slot' ? 400 : 409, code, message: 'raw' });
    assert.ok(m.title && m.message && !/raw/.test(m.message), code);
  }
  assert.match(testFireMessage({ status: 403, message: 'csrf' }).title, /Session/);
  assert.match(testFireMessage({ network: true, status: 0 }).title, /reach/);
  assert.match(testFireMessage({ status: 409, message: 'Something odd' }).message, /odd/);
  assert.match(testFireMessage({ status: 500, message: 'boom' }).message, /boom/);
});

test('forecastRow: measured, over budget, and unknown basis never shows made-up numbers', () => {
  const ok = forecastRow({ plan: 'B', runsPerMonth: 21, eventRunsAssumed: 0, estCostPerRunUsd: 0.12, basis: 'measured', projectedMonthlyUsd: 2.52, pctOfBudget: 12.6, fitsBudget: true }, { capUsd: 20, selected: true });
  assert.equal(ok.costText, '~$2.52/month');
  assert.equal(ok.fits.label, 'Fits $20');
  assert.equal(ok.fits.tone, 'ok');
  assert.equal(ok.runsText, '21 runs/month');
  assert.equal(ok.pctText, '13% of budget');
  assert.equal(ok.selected, true);
  const over = forecastRow({ plan: 'D', runsPerMonth: 63, basis: 'estimated', projectedMonthlyUsd: 31.5, pctOfBudget: 157, fitsBudget: false, estCostPerRunUsd: 0.5 });
  assert.equal(over.fits.tone, 'bad');
  assert.equal(over.fits.label, 'Over $20');
  const c = forecastRow({ plan: 'C', runsPerMonth: 25, eventRunsAssumed: 4, basis: 'estimated', projectedMonthlyUsd: 3, fitsBudget: true });
  assert.match(c.runsText, /incl\. ~4 event runs/);
  const unk = forecastRow({ plan: 'A', runsPerMonth: 42, basis: 'unknown', projectedMonthlyUsd: null, estCostPerRunUsd: null, pctOfBudget: null, fitsBudget: null });
  assert.equal(unk.unknown, true);
  assert.equal(unk.costText, 'Cost unknown until your first runs');
  assert.equal(unk.fits.label, 'Cost unknown');
  assert.equal(unk.pctText, '');
  assert.equal(unk.perRunText, '');
  assert.doesNotMatch(unk.costText, /\$\d/);
});

test('forecastRows marks the current plan; forecastLine handles unknown / disabled', () => {
  const rows = forecastRows({ capUsd: 20, plans: [{ plan: 'A', basis: 'unknown' }, { plan: 'B', basis: 'measured', projectedMonthlyUsd: 1, fitsBudget: true }] }, 'B');
  assert.deepEqual(rows.map((r) => r.selected), [false, true]);
  assert.equal(forecastLine({ enabled: false }), '');
  assert.match(forecastLine({ enabled: true, plan: 'B', basis: 'unknown' }), /unknown/);
  assert.match(forecastLine({ enabled: true, plan: 'B', basis: 'measured', projectedMonthlyUsd: 2.5, fitsBudget: true }), /~\$2\.50\/month, fits/);
  assert.ok(PLAN_IDS.includes('custom'));
});

test('experimentRow: untagged label, min-sample note, edge per dollar only when present', () => {
  const a = experimentRow({ plan: 'none', runs: 3, avgCostUsd: 0.2, proposalsPerRun: 2, approvalRate: 0.5, edgePerDollar: null, scoredProposals: 2, minSampleNote: 'needs 10 runs' }, { runs: 10, scoredProposals: 10 });
  assert.match(a.plan, /Untagged/);
  assert.equal(a.approvalText, '50%');
  assert.equal(a.enough, false);
  assert.equal(a.edgePerDollarText, 'not enough data yet');
  assert.equal(a.note, 'needs 10 runs');
  const b = experimentRow({ plan: 'B', runs: 12, avgCostUsd: 0.1, proposalsPerRun: 1.25, approvalRate: 0.4, edgePerDollar: 3.2, scoredProposals: 14 }, { runs: 10, scoredProposals: 10 });
  assert.equal(b.enough, true);
  assert.match(b.edgePerDollarText, /\+\$3\.20/);
  assert.equal(b.proposalsPerRunText, '1.3');
  assert.match(experimentRow({ plan: 'A' }, { runs: 10, scoredProposals: 10 }).note, /10 runs/);
});

test('validation: custom slots, crypto runs, event triggers', () => {
  assert.ok(isHHMM('09:30') && !isHHMM('9:30') && !isHHMM('24:00'));
  const c = validateCustomSlots([{ time: '09:00', days: 'weekdays', scope: 'stocks' }, { time: '25:00', days: 'daily', scope: 'all' }, { time: '09:00', days: 'weekdays', scope: 'stocks' }]);
  assert.equal(c.ok, false);
  assert.deepEqual(c.errors.map(Boolean), [false, true, true]);
  assert.equal(validateCustomSlots(Array.from({ length: 25 }, () => ({ time: '09:00', days: 'daily', scope: 'all' }))).ok, false);
  assert.deepEqual(validateCustomSlots([{ time: '16:15', days: 'daily', scope: 'crypto' }]).value, [{ time: '16:15', days: 'daily', scope: 'crypto' }]);
  assert.equal(validateCryptoRuns(['09:00', '09:00']).ok, false);
  assert.deepEqual(validateCryptoRuns(['09:00', '21:00']).value, ['09:00', '21:00']);
  assert.equal(validateCryptoRuns([]).ok, true);
  assert.equal(validateCryptoRuns(Array.from({ length: 13 }, (_, i) => `0${i % 10}:00`)).ok, false);
  const good = validateEventTriggers({ enabled: true, spyMovePct: '1', btcMovePct: '2.5', shortlistMovePct: '3', minMinutesBetweenEventRuns: '120', maxEventRunsPerDay: '0' });
  assert.equal(good.ok, true);
  assert.equal(good.value.maxEventRunsPerDay, 0);
  const bad = validateEventTriggers({ enabled: true, spyMovePct: '0.05', btcMovePct: '31', shortlistMovePct: 'x', minMinutesBetweenEventRuns: '4.5', maxEventRunsPerDay: '11' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['btcMovePct', 'maxEventRunsPerDay', 'minMinutesBetweenEventRuns', 'shortlistMovePct', 'spyMovePct']);
});

test('scheduleSummary', () => {
  assert.equal(scheduleSummary({ enabled: false }), 'off');
  assert.equal(scheduleSummary(null), '');
  assert.match(scheduleSummary({ enabled: true, plan: 'B', nextRunAt: '2026-10-01T13:00:00Z' }), /^plan B · next Oct 1, 9:00 AM$/);
  assert.match(scheduleSummary({ enabled: true, plan: 'custom', nextRunAt: null }), /no run pending/);
});
