// Trade of the week: the best closed trade of the last 7 days, with everything a share card needs. Pure (no I/O, no AI cost).
import { rMultiple } from './performance.js';

const DAY = 86_400_000;
const r2 = (n) => Math.round(n * 100) / 100;
const EXIT_TEXT = { 'take-profit': 'hit its target', 'stop-loss': 'was stopped out', 'trailing-stop': 'was closed by the trailing stop', 'time-exit': 'closed at the time limit', manual: 'was closed by hand' };

/** "5h 20m", "2d 3h", "45m". */
export function heldText(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

const money = (n) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const price = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })}`;

/** One-sentence plain-language recap built from the numbers (templated, so it costs nothing and cannot hallucinate). */
export function captionFor(t) {
  const verb = t.side === 'short' ? ['Shorted', 'covered'] : ['Bought', 'sold'];
  const sign = t.pnl >= 0 ? '+' : '-';
  const r = t.r != null ? `, ${t.r.toFixed(1)}R` : '';
  return `${verb[0]} ${t.symbol} at ${price(t.entry)}, ${verb[1]} at ${price(t.exitPrice)}: ${sign}${money(t.pnl)} (${sign}${Math.abs(t.pnlPct).toFixed(2)}%) in ${t.held}${r}. The trade ${EXIT_TEXT[t.exitReason] || 'closed'}.`;
}

/**
 * Best profitable closed trade in the 7 days before `now`, by net P&L. Returns { trade, window, candidates }; `trade` is null when
 * nothing closed in profit in that window.
 */
export function tradeOfTheWeek(positions, now = Date.now()) {
  const from = now - 7 * DAY;
  const inWindow = positions.filter((p) => p.status === 'closed' && Number.isFinite(Date.parse(p.closedAt)) && Date.parse(p.closedAt) >= from && Date.parse(p.closedAt) <= now);
  const winners = inWindow.filter((p) => p.pnl > 0);
  const window = { from: new Date(from).toISOString(), to: new Date(now).toISOString() };
  if (!winners.length) return { trade: null, window, candidates: inWindow.length };
  const best = winners.reduce((a, b) => (b.pnl > a.pnl ? b : a));
  const r = rMultiple(best);
  const trade = {
    id: best.id,
    symbol: best.symbol,
    side: best.side,
    entry: best.entry,
    exitPrice: best.exitPrice,
    stopLoss: best.initialStop ?? best.stopLoss,
    takeProfit: best.takeProfit,
    allocation: best.allocation,
    pnl: r2(best.pnl),
    pnlPct: best.pnlPct ?? r2((best.pnl / best.allocation) * 100),
    r: r == null ? null : r2(r),
    exitReason: best.exitReason ?? null,
    openedAt: best.openedAt,
    closedAt: best.closedAt,
    held: heldText(Date.parse(best.closedAt) - Date.parse(best.openedAt)),
    reason: best.reason || '',
    source: best.source || 'ai',
  };
  trade.caption = captionFor(trade);
  return { trade, window, candidates: inWindow.length };
}
