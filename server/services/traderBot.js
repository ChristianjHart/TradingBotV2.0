import { chatJson } from './openrouter.js';
import { config, hasOpenRouterKey } from '../config.js';
import { store } from '../db/store.js';
import { getAccount, openPosition } from './positions.js';

const MAX_POSITION_PCT = 0.2; // of equity, per trade
const MAX_RISK_PCT = 0.02; // of equity lost if the stop is hit

const SYSTEM = `You are a disciplined risk-aware trading desk. You receive screened candidates (with price and ATR% = hourly average true range as % of price), the account state, and the number of free position slots.
Decide which candidates are actually worth trading and choose AT MOST the given number of slots. For each trade give: symbol, side ("long" or "short"), allocationUsd (dollars of the account to commit), stopLoss (a price that exits the trade if it moves against us, so we never lose the whole allocation), takeProfit (a price at which we lock in the gain), and a one-sentence reason.
Rules: stopLoss must be below entry for longs and above entry for shorts; takeProfit the opposite; aim for reward:risk of at least 1.5; keep total allocation within available cash; no single trade above ${MAX_POSITION_PCT * 100}% of equity. Use the free slots when there are enough acceptable setups: skip only clearly weak ones, and spread capital across trades (roughly cash divided by the number of trades you take, adjusted up or down for setup quality). Do not stop at a handful of trades if more candidates are reasonable.
Reply with ONLY JSON: {"trades":[{"symbol":"...","side":"long|short","allocationUsd":0,"stopLoss":0,"takeProfit":0,"reason":"..."}]}`;

function rulesTrades(cands, slots, cash) {
  const picks = cands.slice(0, slots);
  return picks.map((c) => {
    const atrAbs = c.price * ((c.atrPct || 1.5) / 100);
    const dir = c.direction === 'long' ? 1 : -1;
    return {
      symbol: c.symbol,
      side: c.direction,
      stopLoss: c.price - dir * atrAbs * 2,
      takeProfit: c.price + dir * atrAbs * 3.5,
      allocationUsd: (cash * 0.95) / picks.length, // equal split; risk-capped below
      reason: `rule-based: ${c.reason}`,
    };
  });
}

/** Validate/clamp whatever the model proposed, then open simulated positions. */
export async function runTraderBot(picks) {
  const open = store.getPositions().filter((p) => p.status === 'open');
  const slots = Math.max(0, config.maxOpenPositions - open.length);
  const openSyms = new Set(open.map((p) => p.symbol));
  const cands = picks
    .filter((p) => !openSyms.has(p.symbol))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 30);
  if (!slots || !cands.length) {
    return { source: 'none', opened: [], skipped: slots ? 'no candidates' : 'position slots full' };
  }

  const account = getAccount();
  let proposed;
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
      proposed = json.trades || [];
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
    const entry = c.price;
    let stop = Number(t.stopLoss);
    let target = Number(t.takeProfit);
    const long = t.side === 'long';
    const atrAbs = entry * ((c.atrPct || 1.5) / 100);
    // Repair missing / wrong-side levels instead of trusting the model blindly.
    if (!Number.isFinite(stop) || (long ? stop >= entry : stop <= entry)) stop = entry + (long ? -2 : 2) * atrAbs;
    if (!Number.isFinite(target) || (long ? target <= entry : target >= entry)) target = entry + (long ? 3.5 : -3.5) * atrAbs;
    const stopDist = Math.abs(entry - stop) / entry;
    if (stopDist < 0.003 || stopDist > 0.15) {
      stop = entry + (long ? -2 : 2) * atrAbs;
    }
    const riskDist = Math.abs(entry - stop) / entry;

    let alloc = Number(t.allocationUsd);
    if (!Number.isFinite(alloc)) alloc = Infinity;
    alloc = Math.min(alloc, account.equity * MAX_POSITION_PCT, (account.equity * MAX_RISK_PCT) / riskDist, cash);
    if (!(alloc >= 100)) {
      skipped.push(`${t.symbol} (no cash left)`);
      continue;
    }

    cash -= alloc;
    const pos = {
      symbol: t.symbol,
      side: t.side,
      entry: +entry.toFixed(4),
      stopLoss: +stop.toFixed(4),
      takeProfit: +target.toFixed(4),
      allocation: +alloc.toFixed(2),
      qty: +(alloc / entry).toFixed(6),
      confidence: c.confidence,
      reason: String(t.reason || c.reason).slice(0, 300),
      source,
      model,
    };
    openPosition(pos);
    opened.push(pos);
  }
  store.addLog({
    level: 'info',
    message: `trader bot (${source}): model proposed ${proposed.length} of ${cands.length} candidates, opened ${opened.length} (slots ${slots})${skipped.length ? `; rejected: ${skipped.join(', ')}` : ''}`,
  });
  return { source, model, opened };
}
