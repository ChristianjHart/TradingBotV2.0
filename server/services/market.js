// Market-hours / asset-class helpers (no I/O).
const CRYPTO_BASES = ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'DOGE', 'DOT', 'LTC', 'UNI', 'AAVE', 'XRP', 'BCH', 'SHIB', 'CRV', 'GRT', 'BAT', 'SUSHI', 'YFI', 'XTZ'];

export function isCrypto(symbol) {
  if (symbol.includes('/')) return true;
  return symbol.endsWith('USD') && CRYPTO_BASES.some((c) => symbol.startsWith(c));
}

export function assetClassOf(symbol) {
  return isCrypto(symbol) ? 'crypto' : 'equity';
}

const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

const etParts = (date) => Object.fromEntries(etFmt.formatToParts(date).map((p) => [p.type, p.value]));

// NYSE full-day closures and 13:00 ET early closes, 2025-2028 (static; extend yearly).
// Outside this range only weekends are modelled and bar-age staleness is the fallback.
export const NYSE_HOLIDAYS = new Set([
  // 2025 (includes the Jan 9 national day of mourning)
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  // 2028: New Year's Day falls on a Saturday, and NYSE does NOT observe it on Fri 2027-12-31 (market open that day).
  // MLK Jan 17, Presidents Feb 21, Good Friday Apr 14 (Easter Apr 16), Memorial May 29, Juneteenth Jun 19, Jul 4, Labor Sep 4, Thanksgiving Nov 23, Christmas Dec 25.
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);
// 2028: Mon Jul 3 and Fri Nov 24 close at 13:00; Dec 24 is a Sunday so there is no Christmas Eve early close.
export const NYSE_HALF_DAYS = new Set(['2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);

/** Regular US equity session (Mon-Fri 09:30-16:00 ET; 13:00 close on half-days; NYSE holidays closed). */
export function usMarketOpen(date = new Date()) {
  const p = etParts(date);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const day = `${p.year}-${p.month}-${p.day}`;
  if (NYSE_HOLIDAYS.has(day)) return false;
  const mins = Number(p.hour) * 60 + Number(p.minute);
  const close = NYSE_HALF_DAYS.has(day) ? 13 * 60 : 16 * 60;
  return mins >= 9 * 60 + 30 && mins < close;
}

/** Epoch ms of 00:00 America/New_York on the ET calendar day containing `date`. */
export function etDayStart(date = new Date()) {
  const p = etParts(date);
  const guess = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  const w = etParts(new Date(guess));
  const wall = Date.UTC(Number(w.year), Number(w.month) - 1, Number(w.day), Number(w.hour), Number(w.minute), Number(w.second));
  return guess - (wall - guess);
}

const HOUR = 3600_000;
const MIN = 60_000;

/**
 * Regular-session minutes (09:30-16:00 ET, 13:00 close on half days, no weekends/holidays) between two instants.
 * Capped at 14 ET days of lookback (returns a large number beyond that: the data is stale either way).
 */
export function sessionMinutesBetween(fromMs, toMs) {
  if (toMs <= fromMs) return 0;
  if (toMs - fromMs > 14 * 86_400_000) return Infinity;
  let total = 0;
  for (let d = etDayStart(new Date(fromMs)); d < toMs; d = etDayStart(new Date(d + 36 * HOUR))) {
    const p = etParts(new Date(d + 12 * HOUR)); // midday: unambiguous weekday/date
    if (p.weekday === 'Sat' || p.weekday === 'Sun') continue;
    const day = `${p.year}-${p.month}-${p.day}`;
    if (NYSE_HOLIDAYS.has(day)) continue;
    // DST switches happen on Sundays, so midnight + wall-clock offset is exact on trading days.
    const open = d + (9 * 60 + 30) * MIN;
    const close = d + (NYSE_HALF_DAYS.has(day) ? 13 * 60 : 16 * 60) * MIN;
    const lo = Math.max(open, fromMs);
    const hi = Math.min(close, toMs);
    if (hi > lo) total += (hi - lo) / MIN;
  }
  return total;
}

/** Hourly bars a live feed may miss before a quote counts as stale (thin IEX stocks legitimately skip bars). */
export const STALE_MISSED_BARS = 2;

/**
 * Staleness for ENTRIES and time exits (stops/targets on real past bars still work on stale data).
 * Equities: always stale outside the regular session; inside it, stale only when more than STALE_MISSED_BARS
 * hourly bars of session time have passed since the last bar ended (so the first minutes of a session, or an
 * illiquid IEX name skipping an hour, are not flagged). Crypto trades 24/7: stale after the same number of missed bars.
 * Bar `t` is the bar start.
 */
export function isStale(symbol, lastBarT, now = new Date()) {
  const end = new Date(lastBarT).getTime() + HOUR;
  if (!Number.isFinite(end)) return true;
  if (isCrypto(symbol)) return now.getTime() - end > STALE_MISSED_BARS * HOUR;
  if (!usMarketOpen(now)) return true;
  return sessionMinutesBetween(end, now.getTime()) > STALE_MISSED_BARS * 60;
}
