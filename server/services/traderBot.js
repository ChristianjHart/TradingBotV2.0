import { chatJson } from './openrouter.js';
import { config, hasOpenRouterKey } from '../config.js';
import { store } from '../db/store.js';
import { getAccount, openPosition, livePrices } from './positions.js';
import { applySlippage, feeFor } from './fills.js';
import { limitsFrom, todaysPnl, isHalted, checkEntry } from './risk.js';
import { validSymbol } from '../middleware.js';
import { isCrypto } from './market.js';
import { alpaca } from './alpaca.js';

const MAX_POSITION_PCT = 0.2; // of equity, per trade
const MAX_RISK_PCT = 0.02; // of equity lost if the stop is hit

const SYSTEM = `You are a disciplined risk-aware trading desk. You receive screened candidates (with price and ATR% = hourly average true range as % of price), the account state, and the number of free position slots.
Decide which candidates are actually worth trading and choose AT MOST the given number of slots. For each trade give: symbol, side ("long" or "short"), allocationUsd (dollars of the account to commit), stopLoss (a price that exits the trade if it moves against us, so we never lose the whole allocation), takeProfit (a price at which we lock in the gain), and a one-sentence reason.
Rules: crypto can only be traded long (never short crypto); stopLoss must be below entry for longs and above entry for shorts; takeProfit the opposite; aim for reward:risk of at least 1.5; keep total allocation within available cash; no single trade above ${MAX_POSITION_PCT * 100}% of equity. Use the free slots when there are enough acceptable setups: skip only clearly weak ones, and spread capital across trades (roughly cash divided by the number of trades you take, adjusted up or down for setup quality). Do not stop at a handful of trades if more candidates are reasonable.
The desk enforces portfolio limits (gross/asset-class exposure, sector concentration, daily loss halt), so prefer diversified picks. Reply with ONLY JSON: {"summary":"1-2 sentences on why you chose these trades and what you passed on","trades":[{"symbol":"...","side":"long|short","allocationUsd":0,"stopLoss":0,"takeProfit":0,"reason":"..."}]}`;

/** Confidence-weighted allocation weights (0.35 is the lowest confidence the rules emit, so 0.5 gets ~1/4 of a 0.96 pick's edge). */
export function confidenceWeights(cands) {
  const w = cands.map((c) => Math.max(0.05, (Number(c.confidence) || 0) - 0.35));
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x) => x / sum);
}

function rulesTrades(cands, slots, cash) {
  const picks = cands.slice(0, slots);
  const weights = confidenceWeights(picks);
  return picks.map((c, i) => {
    const atrAbs = c.price * ((c.atrPct || 1.5) / 100);
    const dir = c.direction === 'long' ? 1 : -1;
    return {
      symbol: c.symbol,
      side: c.direction,
      stopLoss: c.price - dir * atrAbs * 2,
      takeProfit: c.price + dir * atrAbs * 3.5,
      allocationUsd: cash * 0.95 * weights[i], // confidence-weighted split; per-trade, risk and portfolio caps applied below
      reason: `rule-based: ${c.reason}`,
    };
  });
}

const MAX_PROPOSED = 100;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? (Number.isFinite(Number(v)) ? Number(v) : undefined) : undefined);

/**
 * Defensive parse of the trader LLM's JSON. Returns { trades, dropped, summary } or null when the overall shape is
 * unusable (not an object, `trades` not an array, or every entry was garbage) so the caller falls back to rules.
 * Kept entries are plain objects with a string symbol and side; numeric fields become finite numbers or undefined
 * (missing levels are repaired later). At most MAX_PROPOSED entries are looked at.
 */
export function sanitizeTrades(json) {
  if (!isPlain(json) || !Array.isArray(json.trades)) return null;
  const trades = [];
  let dropped = Math.max(0, json.trades.length - MAX_PROPOSED);
  for (const t of json.trades.slice(0, MAX_PROPOSED)) {
    if (!isPlain(t) || typeof t.symbol !== 'string' || !validSymbol(t.symbol) || typeof t.side !== 'string') {
      dropped++;
      continue;
    }
    trades.push({
      symbol: t.symbol,
      side: t.side.toLowerCase(),
      allocationUsd: num(t.allocationUsd),
      stopLoss: num(t.stopLoss),
      takeProfit: num(t.takeProfit),
      reason: typeof t.reason === 'string' ? t.reason.slice(0, 300) : '',
    });
  }
  if (!trades.length && dropped > 0) return null;
  return { trades, dropped, summary: typeof json.summary === 'string' ? json.summary.slice(0, 500) : '' };
}

/** Validate/clamp whatever the model proposed, then open simulated positions. */
export async function runTraderBot(picks, { regime } = {}) {
  const open = store.getPositions().filter((p) => p.status === 'open');
  const slots = Math.max(0, config.maxOpenPositions - open.length);
  const openSyms = new Set(open.map((p) => p.symbol));
  const cands = picks
    .filter((p) => !openSyms.has(p.symbol))
    .filter((p) => !(p.direction === 'short' && isCrypto(p.symbol)))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 30);
  if (!slots || !cands.length) {
    return { source: 'none', opened: [], skippedList: [], note: slots ? 'no candidates to trade' : 'all position slots are full' };
  }

  const workerStatus = store.getWorker().status;
  if (workerStatus === 'stopped' || workerStatus === 'killed') {
    const note = `worker is ${workerStatus} — no new positions are opened (exits are still managed by the monitor)`;
    store.addLog({ level: 'warn', message: `trader bot: ${note}` });
    return { source: 'none', opened: [], skippedList: [], note, workerStatus };
  }

  const settings = store.getSettings();
  const limits = limitsFrom(settings);
  const prices = await livePrices(open);
  const account = getAccount(prices);
  const pnlToday = todaysPnl(account.equity);
  if (isHalted(pnlToday, account.equity, limits)) {
    const note = `daily loss halt: today's P&L is below -${settings.dailyLossHaltPct}% of equity — no new trades`;
    store.addLog({ level: 'warn', message: `trader bot: ${note}` });
    return { source: 'none', opened: [], skippedList: [], note, halted: true };
  }
  let proposed;
  let note = '';
  let source = 'ai';
  let model = config.openrouter.traderModel;
  if (hasOpenRouterKey()) {
    try {
      const { json } = await chatJson({
        bot: 'trader',
        model,
        system: SYSTEM,
        user: JSON.stringify({
          account: { equity: account.equity, cash: account.cash },
          freeSlots: slots,
          regime: regime?.line,
          candidates: cands.map((c) => ({
            symbol: c.symbol,
            direction: c.direction,
            confidence: c.confidence,
            price: c.price,
            atrPct: c.atrPct,
            reason: c.reason,
          })),
        }),
        maxTokens: 4000,
        timeoutMs: 90_000,
      });
      const clean = sanitizeTrades(json);
      if (!clean) throw new Error('model returned an unusable JSON shape');
      if (clean.dropped) store.addLog({ level: 'warn', message: `trader bot: dropped ${clean.dropped} malformed trade entries from the model` });
      proposed = clean.trades;
      note = clean.summary;
    } catch (err) {
      store.addLog({ level: 'warn', message: `trader bot AI failed (${err.message}) — using rule-based fallback` });
    }
  }
  if (!proposed) {
    proposed = rulesTrades(cands, slots, account.cash);
    source = 'rules';
    model = null;
  }

  const byCand = new Map(cands.map((c) => [c.symbol, c]));
  let cash = account.cash;
  const opened = [];
  const skipped = [];
  const adjusted = [];
  for (const t of proposed) {
    if (opened.length >= slots) break;
    const c = byCand.get(t.symbol);
    if (!c || !['long', 'short'].includes(t.side)) {
      skipped.push(`${t.symbol} (unknown symbol or bad side)`);
      continue;
    }
    if (opened.some((o) => o.symbol === t.symbol)) {
      skipped.push(`${t.symbol} (duplicate)`);
      continue;
    }
    if (t.side === 'short' && isCrypto(t.symbol)) {
      skipped.push(`${t.symbol} (crypto cannot be shorted)`);
      continue;
    }
    // The scanner's price can be minutes old: refetch, and refuse to open on stale/unavailable data.
    let q = null;
    let qErr = null;
    try {
      q = await alpaca.getQuote(t.symbol);
    } catch (err) {
      qErr = err; // live data failure: candidate rejected, never priced from mock data
    }
    if (!q || !Number.isFinite(q.price) || q.stale) {
      skipped.push(`${t.symbol} (stale quote${q && q.stale ? ': market closed or old data' : qErr?.code === 'market_data_unavailable' ? ': market data unavailable' : ': unavailable'})`);
      continue;
    }
    const quoted = q.price;
    const entry = applySlippage(quoted, t.side, 'entry', settings.slippageBps);
    let stop = Number(t.stopLoss);
    let target = Number(t.takeProfit);
    const long = t.side === 'long';
    const atrAbs = entry * ((c.atrPct || 1.5) / 100);
    // Repair missing / wrong-side levels instead of trusting the model blindly.
    const proposedStop = t.stopLoss;
    if (!Number.isFinite(stop) || (long ? stop >= entry : stop <= entry)) {
      stop = entry + (long ? -2 : 2) * atrAbs;
      adjusted.push(`${t.symbol}: stop ${proposedStop ?? 'missing'} on wrong side/invalid -> 2 ATR (${stop.toFixed(4)})`);
    }
    if (!Number.isFinite(target) || (long ? target <= entry : target >= entry)) {
      target = entry + (long ? 3.5 : -3.5) * atrAbs;
      adjusted.push(`${t.symbol}: target ${t.takeProfit ?? 'missing'} invalid -> 3.5 ATR (${target.toFixed(4)})`);
    }
    const stopDist = Math.abs(entry - stop) / entry;
    if (stopDist < 0.003 || stopDist > 0.15) {
      const before = stop;
      stop = entry + (long ? -2 : 2) * atrAbs;
      adjusted.push(`${t.symbol}: stop ${before.toFixed(4)} out of range (${(stopDist * 100).toFixed(2)}% from entry) -> 2 ATR (${stop.toFixed(4)})`);
    }
    const riskDist = Math.abs(entry - stop) / entry;

    let alloc = Number(t.allocationUsd);
    if (!Number.isFinite(alloc)) alloc = Infinity;
    // Loss if the stop is hit = stop distance + exit slippage + entry and exit fees (all as a fraction of allocation).
    const lossFrac = riskDist + (settings.slippageBps + 2 * settings.feeBps) / 10_000;
    // Leave room in cash for the entry fee (paid on top of the allocation).
    alloc = Math.min(alloc, account.equity * MAX_POSITION_PCT, (account.equity * MAX_RISK_PCT) / lossFrac, cash / (1 + settings.feeBps / 10_000));
    const gate = checkEntry({ open: [...open, ...opened], equity: account.equity, symbol: t.symbol, alloc, limits });
    if (!gate.ok) {
      skipped.push(`${t.symbol} (${gate.reason})`);
      continue;
    }
    alloc = gate.alloc;
    if (!(alloc >= 100)) {
      skipped.push(`${t.symbol} (no cash left)`);
      continue;
    }

    const fee = feeFor(alloc, settings.feeBps);
    cash -= alloc + fee;
    const pos = {
      symbol: t.symbol,
      side: t.side,
      entry: +entry.toFixed(4),
      stopLoss: +stop.toFixed(4),
      takeProfit: +target.toFixed(4),
      allocation: +alloc.toFixed(2),
      qty: +(alloc / entry).toFixed(6),
      fees: fee, // entry fee; the exit fee is added on close and both land in realized P&L once
      slippage: +(Math.abs(entry - quoted) * (alloc / entry)).toFixed(2),
      confidence: c.confidence,
      reason: String(t.reason || c.reason).slice(0, 300),
      source,
      model,
    };
    openPosition(pos);
    opened.push(pos);
  }
  if (adjusted.length) {
    note = `${note}${note ? ' ' : ''}[levels replaced: ${adjusted.join('; ')}]`.slice(0, 1500);
    store.addLog({ level: 'info', message: `trader bot replaced levels: ${adjusted.join('; ')}` });
  }
  store.addLog({
    level: 'info',
    message: `trader bot (${source}): model proposed ${proposed.length} of ${cands.length} candidates, opened ${opened.length} (slots ${slots})${skipped.length ? `; rejected: ${skipped.join(', ')}` : ''}`,
  });
  return { source, model, opened, skippedList: skipped, adjustedList: adjusted, proposed: proposed.length, note };
}
