import test from 'node:test';
import assert from 'node:assert/strict';
import { usMarketOpen, isCrypto, isStale } from '../server/services/market.js';
import { validateBars } from '../server/services/bars.js';
import { backoffMs } from '../server/services/alpaca.js';

test('usMarketOpen follows the ET session', () => {
  assert.equal(usMarketOpen(new Date('2026-09-29T15:00:00Z')), true); // Tue 11:00 ET
  assert.equal(usMarketOpen(new Date('2026-09-29T12:00:00Z')), false); // 08:00 ET
  assert.equal(usMarketOpen(new Date('2026-09-29T21:00:00Z')), false); // 17:00 ET
  assert.equal(usMarketOpen(new Date('2026-09-26T15:00:00Z')), false); // Saturday
});

test('crypto detection and staleness', () => {
  assert.equal(isCrypto('BTC/USD'), true);
  assert.equal(isCrypto('AAPL'), false);
  const now = new Date('2026-09-26T15:00:00Z'); // Saturday
  assert.equal(isStale('AAPL', '2026-09-25T19:00:00Z', now), true);
  assert.equal(isStale('BTC/USD', '2026-09-26T14:00:00Z', now), false);
  assert.equal(isStale('BTC/USD', '2026-09-26T09:00:00Z', now), true);
});

test('validateBars drops malformed, duplicate bars and sorts', () => {
  const good = { t: '2026-01-01T01:00:00Z', o: 10, h: 11, l: 9, c: 10.5, v: 100 };
  const { bars, dropped, zeroVolPct } = validateBars([
    { ...good, t: '2026-01-01T02:00:00Z', v: 0 },
    good,
    good, // duplicate
    { ...good, t: 'x1', h: 8 }, // high below low
    { ...good, t: 'x2', c: NaN },
    { ...good, t: 'x3', o: 0 },
  ]);
  assert.equal(bars.length, 2);
  assert.equal(dropped, 4);
  assert.equal(bars[0].t, good.t);
  assert.equal(zeroVolPct, 50);
});

test('backoffMs honours Retry-After and grows exponentially', () => {
  assert.equal(backoffMs(0, '2'), 2000);
  assert.equal(backoffMs(0, '999'), 15_000);
  const zero = () => 0;
  assert.ok(backoffMs(2, undefined, zero) > backoffMs(1, undefined, zero));
  assert.ok(backoffMs(10, undefined, zero) <= 8000);
});
