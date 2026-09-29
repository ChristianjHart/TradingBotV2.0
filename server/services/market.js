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
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

/** Regular US equity session (Mon-Fri 09:30-16:00 ET). Exchange holidays are not modelled; bar-age staleness covers them. */
export function usMarketOpen(date = new Date()) {
  const parts = Object.fromEntries(etFmt.formatToParts(date).map((p) => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

const HOUR = 3600_000;

/** A quote is stale when equity data is not from a live session, or any last bar is old. Bar `t` is the bar start. */
export function isStale(symbol, lastBarT, now = new Date()) {
  const age = now.getTime() - new Date(lastBarT).getTime();
  if (isCrypto(symbol)) return age > 3 * HOUR;
  return !usMarketOpen(now) || age > 3 * HOUR;
}
