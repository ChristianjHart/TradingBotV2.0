// Bar validation: drop malformed/duplicate bars, report data-quality issues.
export function validateBars(raw) {
  const seen = new Set();
  let dropped = 0;
  const bars = (raw || [])
    .filter((b) => {
      const ok =
        b &&
        b.t &&
        [b.o, b.h, b.l, b.c].every((n) => Number.isFinite(n) && n > 0) &&
        b.h >= b.l &&
        b.h >= Math.max(b.o, b.c) - 1e-9 &&
        b.l <= Math.min(b.o, b.c) + 1e-9 &&
        !seen.has(b.t);
      if (ok) seen.add(b.t);
      else dropped += 1;
      return ok;
    })
    .map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: Number.isFinite(b.v) ? b.v : 0 }))
    .sort((a, b) => new Date(a.t) - new Date(b.t));
  const zeroVol = bars.filter((b) => !b.v).length;
  return { bars, dropped, zeroVolPct: bars.length ? +((zeroVol / bars.length) * 100).toFixed(1) : 0 };
}
