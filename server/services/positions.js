import { alpaca } from './alpaca.js';
import { config } from '../config.js';
import { store } from '../db/store.js';
import { upsert } from '../db/supabase.js';

function syncRow(p) {
  upsert('positions', {
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    status: p.status,
    entry: p.entry,
    stop_loss: p.stopLoss,
    take_profit: p.takeProfit,
    allocation: p.allocation,
    qty: p.qty,
    confidence: p.confidence,
    reason: p.reason,
    source: p.source,
    model: p.model,
    opened_at: p.openedAt,
    closed_at: p.closedAt ?? null,
    exit_price: p.exitPrice ?? null,
    exit_reason: p.exitReason ?? null,
    pnl: p.pnl ?? null,
    pnl_pct: p.pnlPct ?? null,
    raw: p,
    updated_at: new Date().toISOString(),
  });
}

// All positions are SIMULATED (paper). No orders are ever sent anywhere.

function pnlFor(p, price) {
  const move = p.side === 'long' ? price - p.entry : p.entry - price;
  return +(move * p.qty).toFixed(2);
}

export function getAccount(livePrices = {}) {
  const all = store.getPositions();
  const open = all.filter((p) => p.status === 'open');
  const closed = all.filter((p) => p.status === 'closed');
  const realized = closed.reduce((s, p) => s + (p.pnl || 0), 0);
  const allocated = open.reduce((s, p) => s + p.allocation, 0);
  const unrealized = open.reduce((s, p) => s + pnlFor(p, livePrices[p.symbol] ?? p.entry), 0);
  const base = config.paperEquity + realized;
  return {
    startingEquity: config.paperEquity,
    realizedPnl: +realized.toFixed(2),
    unrealizedPnl: +unrealized.toFixed(2),
    equity: +(base + unrealized).toFixed(2),
    cash: +(base - allocated).toFixed(2),
    allocated: +allocated.toFixed(2),
    openCount: open.length,
    closedCount: closed.length,
    wins: closed.filter((p) => p.pnl > 0).length,
  };
}

export function openPosition(t) {
  const positions = store.getPositions();
  const pos = {
    id: `pos_${Date.now()}_${t.symbol.replace(/\W/g, '')}`,
    status: 'open',
    openedAt: new Date().toISOString(),
    ...t,
  };
  positions.unshift(pos);
  store.setPositions(positions.slice(0, 1000));
  syncRow(pos);
}

function closeIn(list, p, exitPrice, reason) {
  p.status = 'closed';
  p.exitPrice = +exitPrice.toFixed(4);
  p.exitReason = reason;
  p.closedAt = new Date().toISOString();
  p.pnl = pnlFor(p, exitPrice);
  p.pnlPct = +((p.pnl / p.allocation) * 100).toFixed(2);
  syncRow(p);
  store.addLog({
    level: p.pnl >= 0 ? 'info' : 'warn',
    message: `position closed ${p.side.toUpperCase()} ${p.symbol} @ ${p.exitPrice} (${reason}) P&L ${p.pnl}`,
  });
}

/** Close positions whose stop-loss / take-profit was touched since they opened. */
export async function monitorPositions() {
  const positions = store.getPositions();
  let changed = false;
  for (const p of positions) {
    if (p.status !== 'open') continue;
    try {
      const bars = await alpaca.getBars(p.symbol, { limit: 48 });
      const since = new Date(p.openedAt).getTime() - 3600_000;
      const recent = bars.filter((b) => new Date(b.t).getTime() >= since);
      for (const b of recent) {
        const stopHit = p.side === 'long' ? b.l <= p.stopLoss : b.h >= p.stopLoss;
        const tpHit = p.side === 'long' ? b.h >= p.takeProfit : b.l <= p.takeProfit;
        if (stopHit) {
          closeIn(positions, p, p.stopLoss, 'stop-loss');
          changed = true;
          break;
        }
        if (tpHit) {
          closeIn(positions, p, p.takeProfit, 'take-profit');
          changed = true;
          break;
        }
      }
    } catch {
      /* try again next cycle */
    }
  }
  if (changed) store.setPositions(positions);
}

export async function closeManually(id) {
  const positions = store.getPositions();
  const p = positions.find((x) => x.id === id && x.status === 'open');
  if (!p) return null;
  const q = await alpaca.getQuote(p.symbol);
  closeIn(positions, p, q?.price ?? p.entry, 'manual');
  store.setPositions(positions);
  return p;
}

export async function listPositions() {
  const all = store.getPositions();
  const open = all.filter((p) => p.status === 'open');
  const prices = {};
  await Promise.all(
    open.map(async (p) => {
      try {
        prices[p.symbol] = (await alpaca.getQuote(p.symbol))?.price;
      } catch {
        /* leave undefined */
      }
    }),
  );
  return {
    account: getAccount(prices),
    open: open.map((p) => {
      const price = prices[p.symbol] ?? p.entry;
      return { ...p, price, pnl: pnlFor(p, price), pnlPct: +((pnlFor(p, price) / p.allocation) * 100).toFixed(2) };
    }),
    closed: all.filter((p) => p.status === 'closed').slice(0, 30),
  };
}
