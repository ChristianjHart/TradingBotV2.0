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

// NYSE full-day closures and 13:00 ET early closes, 2025-2027 (static; extend yearly).
// Outside this range only weekends are modelled and bar-age staleness is the fallback.
export const NYSE_HOLIDAYS = new Set([
  // 2025 (includes the Jan 9 national day of mourning)
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
export const NYSE_HALF_DAYS = new Set(['2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24', '2027-11-26']);

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

/** A quote is stale when equity data is not from a live session, or any last bar is old. Bar `t` is the bar start. */
export function isStale(symbol, lastBarT, now = new Date()) {
  const age = now.getTime() - new Date(lastBarT).getTime();
  if (isCrypto(symbol)) return age > 3 * HOUR;
  return !usMarketOpen(now) || age > 3 * HOUR;
}
