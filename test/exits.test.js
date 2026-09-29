import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateExit, expiryFor } from '../server/services/exits.js';
import { applySlippage, feeFor, stopFill, targetFill } from '../server/services/fills.js';

const T0 = new Date('2026-01-05T15:00:00Z').getTime();
const bar = (h, o, hi, lo, c) => ({ t: new Date(T0 + h * 3600_000).toISOString(), o, h: hi, l: lo, c, v: 1 });
const pos = (over = {}) => ({
  side: 'long', entry: 100, stopLoss: 95, initialStop: 95, takeProfit: 110, qty: 1,
  openedAt: new Date(T0).toISOString(), expiresAt: expiryFor(new Date(T0).toISOString(), 24), ...over,
});

test('slippage is adverse on both legs; fees scale with notional', () => {
  assert.ok(applySlippage(100, 'long', 'entry', 10) > 100);
  assert.ok(applySlippage(100, 'long', 'exit', 10) < 100);
  assert.ok(applySlippage(100, 'short', 'entry', 10) < 100);
  assert.ok(applySlippage(100, 'short', 'exit', 10) > 100);
  assert.equal(feeFor(10_000, 5), 5);
});

test('gap-aware fills use the open when it is beyond the level', () => {
  assert.equal(stopFill('long', 95, { o: 90 }), 90);
  assert.equal(stopFill('long', 95, { o: 97 }), 95);
  assert.equal(stopFill('short', 105, { o: 110 }), 110);
  assert.equal(targetFill('long', 110, { o: 115 }), 115);
  assert.equal(targetFill('short', 90, { o: 88 }), 88);
});

test('stop-loss triggers and fills at a gap-down open', () => {
  const r = simulateExit(pos(), [bar(1, 90, 91, 88, 89)], { now: T0 + 2 * 3600_000 });
  assert.equal(r.exit.reason, 'stop-loss');
  assert.equal(r.exit.price, 90);
});

test('take-profit triggers for shorts', () => {
  const r = simulateExit(pos({ side: 'short', stopLoss: 105, initialStop: 105, takeProfit: 90 }), [bar(1, 99, 100, 89, 91)], { now: T0 });
  assert.equal(r.exit.reason, 'take-profit');
  assert.equal(r.exit.price, 90);
});

test('bars before the position opened are ignored', () => {
  const r = simulateExit(pos(), [bar(-1, 90, 91, 80, 85)], { now: T0 });
  assert.equal(r.exit, null);
});

test('stop moves to break-even after +1R and then exits as trailing-stop', () => {
  const bars = [bar(1, 100, 106, 100, 105), bar(2, 105, 106, 99, 100)];
  const r = simulateExit(pos(), bars, { now: T0 + 3 * 3600_000 });
  assert.equal(r.exit.reason, 'trailing-stop');
  assert.equal(r.exit.price, 100);
  const r2 = simulateExit(pos(), [bars[0]], { now: T0 + 3600_000 });
  assert.equal(r2.exit, null);
  assert.equal(r2.stopLoss, 100);
  assert.equal(r2.trailing, true);
});

test('trailR trails behind the best price', () => {
  const r = simulateExit(pos(), [bar(1, 100, 108, 100, 107)], { now: T0, trailR: 1 });
  assert.equal(r.stopLoss, 103); // 108 - 1R(5)
});

test('time-exit once the horizon passes, at the latest close', () => {
  const r = simulateExit(pos(), [bar(1, 100, 101, 99, 100.5)], { now: T0 + 25 * 3600_000 });
  assert.equal(r.exit.reason, 'time-exit');
  assert.equal(r.exit.price, 100.5);
});
