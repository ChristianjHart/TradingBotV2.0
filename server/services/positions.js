import { alpaca } from './alpaca.js';
import { config } from '../config.js';
import { store } from '../db/store.js';
import { upsert, insert } from '../db/supabase.js';
import { applySlippage, feeFor } from './fills.js';
import { simulateExit, expiryFor } from './exits.js';

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

/** Gross (pre-fee) P&L at `price`. */
function pnlFor(p, price) {
  const move = p.side === 'long' ? price - p.entry : p.entry - price;
  return +(move * p.qty).toFixed(2);
}

const openNet = (p, price) => +(pnlFor(p, price) - (p.fees || 0)).toFixed(2);

export function getAccount(livePrices = {}) {
  const all = store.getPositions();
  const open = all.filter((p) => p.status === 'open');
  const closed = all.filter((p) => p.status === 'closed');
  const realized = closed.reduce((s, p) => s + (p.pnl || 0), 0);
  const allocated = open.reduce((s, p) => s + p.allocation, 0);
  const unrealized = open.reduce((s, p) => s + openNet(p, livePrices[p.symbol] ?? p.entry), 0);
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

/** Latest price per open symbol (bars are cached, so this is cheap inside a run). */
export async function livePrices(open = store.getPositions().filter((p) => p.status === 'open')) {
  const prices = {};
  await Promise.all(
    [...new Set(open.map((p) => p.symbol))].map(async (sym) => {
      try {
        prices[sym] = (await alpaca.getQuote(sym))?.price;
      } catch {
        /* leave undefined */
      }
    }),
  );
  return prices;
}

/** Append an equity snapshot when it changed (or every 30 min) — feeds the equity curve. */
export function recordEquity(prices = {}) {
  const eq = getAccount(prices).equity;
  const snaps = store.getEquity();
  const last = snaps[snaps.length - 1];
  const now = Date.now();
  if (last && Math.abs(last.equity - eq) < 0.01 && now - new Date(last.t).getTime() < 30 * 60_000) return;
  const snap = { t: new Date(now).toISOString(), equity: eq };
  store.setEquity([...snaps, snap]);
  insert('equity_snapshots', snap);
}

export function openPosition(t) {
  const positions = store.getPositions();
  const openedAt = new Date().toISOString();
  const pos = {
    id: `pos_${Date.now()}_${t.symbol.replace(/\W/g, '')}`,
    status: 'open',
    openedAt,
    expiresAt: expiryFor(openedAt, store.getSettings().horizonHours),
    initialStop: t.stopLoss,
    trailing: false,
    fees: 0,
    slippage: 0,
    ...t,
  };
  positions.unshift(pos);
  store.setPositions(positions.slice(0, 1000));
  syncRow(pos);
  recordEquity();
}

/** Close at `rawPrice`; market-type exits (stop, time, manual) pay slippage, limit fills (target) do not. */
function closeIn(p, rawPrice, reason, { market = true } = {}) {
  const s = store.getSettings();
  const price = market ? applySlippage(rawPrice, p.side, 'exit', s.slippageBps) : rawPrice;
  p.status = 'closed';
  p.exitPrice = +price.toFixed(4);
  p.exitReason = reason;
  p.closedAt = new Date().toISOString();
  p.fees = +((p.fees || 0) + feeFor(price * p.qty, s.feeBps)).toFixed(2);
  p.slippage = +((p.slippage || 0) + Math.abs(price - rawPrice) * p.qty).toFixed(2);
  p.pnl = +(pnlFor(p, price) - p.fees).toFixed(2);
  p.pnlPct = +((p.pnl / p.allocation) * 100).toFixed(2);
  syncRow(p);
  store.addLog({
    level: p.pnl >= 0 ? 'info' : 'warn',
    message: `position closed ${p.side.toUpperCase()} ${p.symbol} @ ${p.exitPrice} (${reason}) P&L ${p.pnl}`,
  });
}

/**
 * Apply stop-loss / take-profit / trailing / time-exit rules to every open position.
 * Stock positions are skipped while their data is stale (market closed): no stop decisions on old prices.
 */
export async function monitorPositions() {
  const positions = store.getPositions();
  const settings = store.getSettings();
  let changed = false;
  const prices = {};
  for (const p of positions) {
    if (p.status !== 'open') continue;
    try {
      const bars = await alpaca.getBars(p.symbol, { limit: 120 });
      if (bars.length) prices[p.symbol] = bars[bars.length - 1].c;
      if (alpaca.isStale(p.symbol)) continue;
      if (!p.expiresAt) {
        p.expiresAt = expiryFor(p.openedAt, settings.horizonHours);
        changed = true;
      }
      const r = simulateExit(p, bars, { breakEven: settings.breakEven, trailR: settings.trailR });
      if (r.stopLoss !== p.stopLoss || r.trailing !== p.trailing) {
        p.initialStop ??= p.stopLoss;
        p.stopLoss = +r.stopLoss.toFixed(4);
        p.trailing = r.trailing;
        changed = true;
        if (!r.exit) syncRow(p);
      }
      if (r.exit) {
        closeIn(p, r.exit.price, r.exit.reason, { market: r.exit.market });
        changed = true;
      }
    } catch {
      /* try again next cycle */
    }
  }
  if (changed) store.setPositions(positions);
  recordEquity(prices);
}

export async function closeManually(id) {
  const positions = store.getPositions();
  const p = positions.find((x) => x.id === id && x.status === 'open');
  if (!p) return null;
  const q = await alpaca.getQuote(p.symbol);
  closeIn(p, q?.price ?? p.entry, 'manual');
  store.setPositions(positions);
  recordEquity();
  return p;
}

export async function closeAll() {
  const positions = store.getPositions();
  let closed = 0;
  for (const p of positions.filter((x) => x.status === 'open')) {
    const q = await alpaca.getQuote(p.symbol).catch(() => null);
    closeIn(p, q?.price ?? p.entry, 'manual');
    closed += 1;
  }
  if (closed) {
    store.setPositions(positions);
    recordEquity();
  }
  return closed;
}

export async function listPositions() {
  const all = store.getPositions();
  const open = all.filter((p) => p.status === 'open');
  const prices = await livePrices(open);
  return {
    account: getAccount(prices),
    open: open.map((p) => {
      const price = prices[p.symbol] ?? p.entry;
      const pnl = openNet(p, price);
      return { ...p, price, pnl, pnlPct: +((pnl / p.allocation) * 100).toFixed(2), stale: alpaca.isStale(p.symbol) };
    }),
    closed: all.filter((p) => p.status === 'closed').slice(0, 30),
  };
}
