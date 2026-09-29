import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STEPS, stepperState, progressOf, riskOf, sortRows, donutGradient, pctOf, calibrationBar, aggregateBars, toTvSymbol, classifyApiError,
} from '../public/js/run-logic.js';
import { fmtDuration, fmtMoney, fmtPct, clsPos, escapeHtml } from '../public/js/api.js';

const T0 = Date.parse('2026-01-01T10:00:00Z');
const states = (v) => v.steps.map((s) => s.state);

test('stepperState: idle / missing run is hidden', () => {
  assert.equal(stepperState(null, T0).visible, false);
  assert.equal(stepperState({ stage: 'idle', startedAt: 'x' }, T0).visible, false);
  assert.equal(stepperState({ stage: 'fetching' }, T0).visible, false);
});

test('stepperState: resumes mid-run at the scanning stage with live elapsed', () => {
  const run = { running: true, stage: 'scanning', startedAt: new Date(T0).toISOString() };
  const v = stepperState(run, T0 + 95_000);
  assert.deepEqual(states(v), ['done', 'active', 'pending']);
  assert.equal(v.kind, 'running');
  assert.equal(v.elapsedMs, 95_000);
  assert.equal(v.steps.length, STEPS.length);
});

test('stepperState: done marks all steps done and freezes elapsed at finishedAt', () => {
  const run = { running: false, stage: 'done', startedAt: new Date(T0).toISOString(), finishedAt: new Date(T0 + 60_000).toISOString() };
  const v = stepperState(run, T0 + 999_999);
  assert.deepEqual(states(v), ['done', 'done', 'done']);
  assert.equal(v.kind, 'done');
  assert.equal(v.elapsedMs, 60_000);
});

test('stepperState: error places the failure on the last running stage', () => {
  const run = { running: false, stage: 'error', startedAt: new Date(T0).toISOString(), finishedAt: new Date(T0 + 1000).toISOString() };
  assert.deepEqual(states(stepperState(run, T0, 'scanning')), ['done', 'error', 'pending']);
  assert.deepEqual(states(stepperState(run, T0)), ['error', 'pending', 'pending']);
  assert.equal(stepperState(run, T0, 'trading').kind, 'error');
});

test('stepperState: elapsed never negative on clock skew', () => {
  const v = stepperState({ running: true, stage: 'fetching', startedAt: new Date(T0 + 5000).toISOString() }, T0);
  assert.equal(v.elapsedMs, 0);
});

test('progressOf clamps to 0..1 and handles degenerate span', () => {
  const p = { stopLoss: 90, takeProfit: 110, entry: 100 };
  assert.equal(progressOf(p), 0.5);
  assert.equal(progressOf({ ...p, price: 200 }), 1);
  assert.equal(progressOf({ ...p, price: 50 }), 0);
  assert.equal(progressOf({ stopLoss: 100, takeProfit: 100, entry: 100 }), 0.5);
});

test('riskOf uses qty or falls back to allocation/entry', () => {
  assert.equal(riskOf({ entry: 100, stopLoss: 95, qty: 10 }), 50);
  assert.equal(riskOf({ entry: 100, stopLoss: 95, allocation: 1000 }), 50);
});

test('sortRows sorts strings and numbers, nulls last in both directions, without mutating', () => {
  const rows = [{ s: 'b', n: 2 }, { s: 'a', n: null }, { s: 'c', n: 9 }];
  const copy = JSON.stringify(rows);
  assert.deepEqual(sortRows(rows, (r) => r.s, 'asc').map((r) => r.s), ['a', 'b', 'c']);
  assert.deepEqual(sortRows(rows, (r) => r.n, 'desc').map((r) => r.n), [9, 2, null]);
  assert.deepEqual(sortRows(rows, (r) => r.n, 'asc').map((r) => r.n), [2, 9, null]);
  assert.equal(JSON.stringify(rows), copy);
});

test('donutGradient builds contiguous 360deg conic stops and survives zero total', () => {
  const g = donutGradient([{ value: 1, color: 'red' }, { value: 3, color: 'blue' }]);
  assert.equal(g, 'conic-gradient(red 0deg 90deg, blue 90deg 360deg)');
  assert.match(donutGradient([{ value: 0, color: 'x' }]), /^conic-gradient\(x 0deg 0deg\)$/);
});

test('pctOf accepts fractions and percents', () => {
  assert.ok(Math.abs(pctOf(0.55) - 55) < 1e-9);
  assert.equal(pctOf(55), 55);
  assert.equal(pctOf(null), null);
});

test('calibrationBar: midpoint, width clamp and overconfidence flag', () => {
  assert.deepEqual(calibrationBar({ bucket: '60-70%', hitRate: 0.5, n: 4 }), { mid: 65, hitRate: 50, width: 50, overconfident: true });
  const hi = calibrationBar({ bucket: '70–80', hitRate: 90, n: 2 });
  assert.equal(hi.mid, 75);
  assert.equal(hi.overconfident, false);
  assert.equal(calibrationBar({ bucket: 'weird', hitRate: 250 }).width, 100);
  assert.equal(calibrationBar({ bucket: 'weird', hitRate: undefined }).mid, null);
});

test('aggregateBars: 1H passthrough, 4H grouping aligned to end, daily by date', () => {
  const mk = (t, o, h, l, c, v = 1) => ({ t, o, h, l, c, v });
  const hours = Array.from({ length: 9 }, (_, i) => mk(`2026-01-0${1 + Math.floor(i / 5)}T0${i % 5}:00:00Z`, i, i + 2, i - 1, i + 1));
  assert.equal(aggregateBars(hours, '1H'), hours);
  const four = aggregateBars(hours, '4H');
  assert.equal(four.length, 2);
  assert.equal(four[0].o, 1);
  assert.equal(four[0].c, 5);
  assert.equal(four[0].v, 4);
  const day = aggregateBars(hours, '1D');
  assert.equal(day.length, 2);
  assert.equal(day[0].h, Math.max(...hours.slice(0, 5).map((b) => b.h)));
  assert.deepEqual(aggregateBars([], '4H'), []);
});

test('toTvSymbol maps crypto pairs to Binance and leaves equities alone', () => {
  assert.equal(toTvSymbol('BTC/USD'), 'BINANCE:BTCUSDT');
  assert.equal(toTvSymbol('ETH/EUR'), 'BINANCE:ETHEUR');
  assert.equal(toTvSymbol('SPY'), 'SPY');
});

test('classifyApiError recognises 409 worker-stopped and 400 untracked symbol', () => {
  assert.equal(classifyApiError({ status: 409, message: 'worker stopped' }), 'worker-stopped');
  assert.equal(classifyApiError({ status: 400, message: 'symbol not in universe' }), 'untracked');
  assert.equal(classifyApiError({ status: 500, message: 'boom' }), 'other');
  assert.equal(classifyApiError(null), 'other');
});

test('formatters: money, pct, duration, class, escaping', () => {
  assert.equal(fmtPct(1.234), '+1.23%');
  assert.equal(fmtPct(-0.5), '-0.50%');
  assert.equal(fmtPct(null), '—');
  assert.match(fmtMoney(1234.5, 0), /1,?23[45]/);
  assert.equal(fmtMoney(undefined), '—');
  assert.equal(fmtDuration(65_000), '1m 05s');
  assert.equal(fmtDuration(3_720_000), '1h 02m');
  assert.equal(fmtDuration(-5000), '-5s');
  assert.equal(clsPos(3), 'pos');
  assert.equal(clsPos(-3), 'neg');
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});
