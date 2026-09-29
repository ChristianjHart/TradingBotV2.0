const pct = (a, b) => (b ? +(((a - b) / b) * 100).toFixed(2) : 0);

/** Daily-timeframe context: 5d/20d returns and distance from the 20-day high/low (%). */
export function dailyContext(daily) {
  if (!daily || daily.length < 21) return null;
  const closes = daily.map((b) => b.c);
  const last = closes[closes.length - 1];
  const win = daily.slice(-20);
  const hi = Math.max(...win.map((b) => b.h));
  const lo = Math.min(...win.map((b) => b.l));
  return {
    ret5d: pct(last, closes[closes.length - 6]),
    ret20d: pct(last, closes[closes.length - 21]),
    distHigh20: pct(last, hi), // <= 0
    distLow20: pct(last, lo), // >= 0
    aboveSma20: last > closes.slice(-20).reduce((a, b) => a + b, 0) / 20,
  };
}

/** Relative strength = symbol's return minus its benchmark's (SPY for equities, BTC for crypto). */
export function relStrength(ctx, bench) {
  if (!ctx || !bench) return null;
  return { rs5d: +(ctx.ret5d - bench.ret5d).toFixed(2), rs20d: +(ctx.ret20d - bench.ret20d).toFixed(2) };
}

/** One-line market regime from benchmark daily context. */
export function marketRegime(spy, btc) {
  const parts = [];
  const score = [];
  for (const [name, c] of [['SPY', spy], ['BTC', btc]]) {
    if (!c) continue;
    parts.push(`${name} 5d ${c.ret5d >= 0 ? '+' : ''}${c.ret5d}% / 20d ${c.ret20d >= 0 ? '+' : ''}${c.ret20d}% (${c.aboveSma20 ? 'above' : 'below'} 20d avg)`);
    score.push((c.ret20d > 0 ? 1 : -1) + (c.aboveSma20 ? 1 : -1));
  }
  const total = score.reduce((a, b) => a + b, 0);
  const label = !score.length ? 'unknown' : total >= 2 ? 'risk-on' : total <= -2 ? 'risk-off' : 'mixed';
  return { label, line: `${label}: ${parts.join('; ') || 'no benchmark data'}` };
}
