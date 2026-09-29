// Simulated execution model: slippage, fees and gap-aware fills. Pure functions.

/** Price actually paid/received. Longs buy high & sell low, shorts the reverse. */
export function applySlippage(price, side, leg, bps) {
  const adverse = (side === 'long') === (leg === 'entry') ? 1 : -1;
  return price * (1 + (adverse * bps) / 10_000);
}

export function feeFor(notional, bps) {
  return +((Math.abs(notional) * bps) / 10_000).toFixed(4);
}

/** Stop fill: if the bar opens beyond the stop, we get the (worse) open, not the stop. */
export function stopFill(side, stop, bar) {
  return side === 'long' ? Math.min(stop, bar.o) : Math.max(stop, bar.o);
}

/** Target fill: a favourable gap fills at the (better) open. */
export function targetFill(side, target, bar) {
  return side === 'long' ? Math.max(target, bar.o) : Math.min(target, bar.o);
}
