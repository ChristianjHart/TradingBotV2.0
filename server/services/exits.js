import { stopFill, targetFill } from './fills.js';

export const DEFAULT_HORIZON_H = 24;

export function expiryFor(openedAt, horizonHours = DEFAULT_HORIZON_H) {
  return new Date(new Date(openedAt).getTime() + horizonHours * 3600_000).toISOString();
}

/**
 * Walk bars that started after the position opened and decide whether it exited.
 * Per bar: stop is checked before target (conservative), then the stop is ratcheted
 * (break-even at +1R, optional trail of `trailR` R behind the best price).
 * Returns { exit: {price, reason, at, market}|null, stopLoss, trailing }. `market` exits pay slippage.
 */
export function simulateExit(p, bars, { now = Date.now(), breakEven = true, trailR = 0 } = {}) {
  const long = p.side === 'long';
  const initial = p.initialStop ?? p.stopLoss;
  const R = Math.abs(p.entry - initial);
  let stop = p.stopLoss;
  let trailing = Boolean(p.trailing);
  let best = p.entry; // best favourable price seen so far
  const opened = new Date(p.openedAt).getTime();
  const seq = bars.filter((b) => new Date(b.t).getTime() >= opened);

  for (const b of seq) {
    const stopHit = long ? b.l <= stop : b.h >= stop;
    if (stopHit) {
      const moved = long ? stop > initial : stop < initial;
      return { exit: { price: stopFill(p.side, stop, b), reason: moved ? 'trailing-stop' : 'stop-loss', at: b.t, market: true }, stopLoss: stop, trailing };
    }
    const tpHit = long ? b.h >= p.takeProfit : b.l <= p.takeProfit;
    if (tpHit) return { exit: { price: targetFill(p.side, p.takeProfit, b), reason: 'take-profit', at: b.t, market: false }, stopLoss: stop, trailing };

    best = long ? Math.max(best, b.h) : Math.min(best, b.l);
    if (R > 0 && (breakEven || trailR > 0) && Math.abs(best - p.entry) >= R) {
      let next = p.entry;
      if (trailR > 0) next = long ? Math.max(next, best - trailR * R) : Math.min(next, best + trailR * R);
      const better = long ? next > stop : next < stop;
      if (better) {
        stop = next;
        trailing = true;
      }
    }
  }

  const expires = p.expiresAt ? new Date(p.expiresAt).getTime() : new Date(expiryFor(p.openedAt)).getTime();
  if (now >= expires) {
    const last = bars[bars.length - 1];
    if (last) return { exit: { price: last.c, reason: 'time-exit', at: new Date(now).toISOString(), market: true }, stopLoss: stop, trailing };
  }
  return { exit: null, stopLoss: stop, trailing };
}
