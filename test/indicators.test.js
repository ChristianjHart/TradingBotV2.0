import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, atr, macd } from '../server/services/indicators.js';

test('sma / ema basics', () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([1], 2), null);
  assert.equal(ema([5, 5, 5, 5, 5], 3), 5);
});

test('rsi is 100 for a pure uptrend and low for a downtrend', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(rsi(up), 100);
  assert.ok(rsi(down) < 5);
  assert.equal(rsi([1, 2]), null);
});

test('atr averages true range', () => {
  const bars = Array.from({ length: 20 }, () => ({ o: 10, h: 12, l: 10, c: 11, v: 1 }));
  assert.equal(atr(bars), 2);
  assert.equal(atr(bars.slice(0, 5)), null);
});

test('macd needs enough data', () => {
  assert.equal(macd([1, 2, 3]), null);
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  assert.ok(Number.isFinite(macd(closes).hist));
});
