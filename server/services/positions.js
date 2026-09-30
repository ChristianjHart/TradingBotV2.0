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
  const openFees = open.reduce((s, p) => s + (p.fees || 0), 0);
  const base = config.paperEquity + realized;
  return {
    startingEquity: config.paperEquity,
    realizedPnl: +realized.toFixed(2),
    unrealizedPnl: +unrealized.toFixed(2),
    equity: +(base + unrealized).toFixed(2),
    // Entry fees on open positions are paid out of cash; equity = cash + allocated + gross unrealized,
    // so each fee is deducted exactly once (open: in cash and in net unrealized; closed: in realized pnl).
    cash: +(base - allocated - openFees).toFixed(2),
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
  store.setPositions(positions);
  syncRow(pos);
  recordEquity();
  return pos;
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

export class PositionError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Fresh, non-stale-checked quote for closing. Throws PositionError 502 (no quote) / 409 (stale, unless force). */
async function closingQuote(p, force) {
  const q = await alpaca.getQuote(p.symbol).catch(() => null);
  if (!q || !Number.isFinite(q.price)) throw new PositionError(502, `no quote available for ${p.symbol}; position left open`, 'no_quote');
  if (q.stale && !force) {
    throw new PositionError(409, `quote for ${p.symbol} is stale (market closed or old data); retry with force=1 to close at the last price`, 'stale_quote');
  }
  return q;
}

/**
 * Concurrency model: network I/O happens on a snapshot, but every write re-reads the store and merges
 * by id in one synchronous section (no await between read and write), so concurrent openPosition /
 * manual close / monitor cycles never overwrite each other. Concurrent monitor cycles are coalesced.
 */
let monitorInFlight = null;

export function monitorPositions() {
  monitorInFlight ||= runMonitor().finally(() => {
    monitorInFlight = null;
  });
  return monitorInFlight;
}

/**
 * Apply stop-loss / take-profit / trailing / time-exit rules to every open position.
 * Worker status does not matter here: the monitor ALWAYS manages exits (stopped/killed only blocks NEW opens,
 * which happen exclusively in runs, see runTraderBot / POST /run). It never opens positions itself.
 * Exits are evaluated on the last known real bars even when the quote is stale (closed market / thin symbol):
 * a stop or target hit inside a real bar is a real event. Only the time exit (a market order at the last close)
 * waits for a fresh bar. Positions whose data cannot be fetched are skipped (never priced from mock data) and
 * reported in ONE log line per cycle. Expired positions are flagged (expiredAt) immediately.
 */
async function runMonitor() {
  const settings = store.getSettings();
  const decisions = new Map(); // id -> patch
  const prices = {};
  const snapshot = store.getPositions().filter((p) => p.status === 'open');
  const skipped = [];
  for (const p of snapshot) {
    try {
      const bars = await alpaca.getBars(p.symbol, { limit: 120 });
      if (bars.length) prices[p.symbol] = bars[bars.length - 1].c;
      const stale = alpaca.isStale(p.symbol);
      const r = simulateExit(p, bars, { breakEven: settings.breakEven, trailR: settings.trailR, fresh: !stale });
      const patch = { expired: r.expired, expiresAt: r.expiresAt };
      Object.assign(patch, { stopLoss: r.stopLoss, trailing: r.trailing, exit: r.exit, checkedAt: new Date().toISOString(), stale });
      decisions.set(p.id, patch);
    } catch (err) {
      skipped.push(`${p.symbol} (${err.message})`);
    }
  }
  if (skipped.length) {
    store.addLog({ level: 'warn', message: `monitor: skipped ${skipped.length} position(s), market data unavailable: ${skipped.join('; ').slice(0, 600)} (retrying next cycle)` });
  }
  // Synchronous merge onto the latest store contents.
  const positions = store.getPositions();
  let changed = false;
  for (const p of positions) {
    const d = p.status === 'open' && decisions.get(p.id);
    if (!d) continue;
    if (!p.expiresAt) {
      p.expiresAt = d.expiresAt;
      changed = true;
    }
    if (d.expired && !p.expiredAt) {
      p.expiredAt = p.expiresAt;
      changed = true;
    }
    if (d.checkedAt) {
      p.lastCheckedAt = d.checkedAt;
      p.lastCheckedStale = Boolean(d.stale);
      if (d.stopLoss !== p.stopLoss || d.trailing !== p.trailing) {
        p.initialStop ??= p.stopLoss;
        p.stopLoss = +d.stopLoss.toFixed(4);
        p.trailing = d.trailing;
        changed = true;
        if (!d.exit) syncRow(p);
      }
      if (d.exit) {
        closeIn(p, d.exit.price, d.exit.reason, { market: d.exit.market });
        changed = true;
      }
    }
  }
  if (changed) store.setPositions(positions);
  recordEquity(prices);
}

/** Close one open position at a live quote. Throws PositionError (404 unknown, 409 stale, 502 no quote). */
export async function closeManually(id, { force = false } = {}) {
  const snap = store.getPositions().find((x) => x.id === id && x.status === 'open');
  if (!snap) throw new PositionError(404, 'open position not found', 'not_found');
  const q = await closingQuote(snap, force);
  const positions = store.getPositions();
  const p = positions.find((x) => x.id === id && x.status === 'open');
  if (!p) throw new PositionError(404, 'position was already closed', 'not_found');
  closeIn(p, q.price, 'manual');
  if (q.stale) p.staleExit = true;
  store.setPositions(positions);
  recordEquity();
  return p;
}

/** Close every open position. Returns { closed, failed:[{id,symbol,status,code,error}] }; failures leave positions open. */
export async function closeAll({ force = false } = {}) {
  const quotes = new Map();
  const failed = [];
  for (const p of store.getPositions().filter((x) => x.status === 'open')) {
    try {
      quotes.set(p.id, await closingQuote(p, force));
    } catch (err) {
      failed.push({ id: p.id, symbol: p.symbol, status: err.status || 502, code: err.code || 'error', error: err.message });
    }
  }
  const positions = store.getPositions();
  let closed = 0;
  for (const p of positions) {
    const q = p.status === 'open' && quotes.get(p.id);
    if (!q) continue;
    closeIn(p, q.price, 'manual');
    if (q.stale) p.staleExit = true;
    closed += 1;
  }
  if (closed) {
    store.setPositions(positions);
    recordEquity();
  }
  return { closed, failed };
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
      const expired = Boolean(p.expiredAt) || (p.expiresAt ? Date.now() >= new Date(p.expiresAt).getTime() : false);
      return { ...p, price, pnl, pnlPct: +((pnl / p.allocation) * 100).toFixed(2), stale: alpaca.isStale(p.symbol), expired };
    }),
    closed: all.filter((p) => p.status === 'closed').slice(0, 30),
  };
}
