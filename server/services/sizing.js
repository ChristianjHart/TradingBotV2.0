// Shared trade sizing + portfolio risk for PROPOSAL time and APPROVAL time (same rules, run twice: the second time with a fresh quote).
import { applySlippage, feeFor } from './fills.js';
import { checkEntry } from './risk.js';
import { assetClassOf } from './market.js';
import { groupOf } from './universe.js';

export const MAX_POSITION_PCT = 0.2; // of equity, per trade
export const MAX_RISK_PCT = 0.02; // of equity lost if the stop is hit
export const MIN_ALLOC = 100;

/**
 * Size one trade and run the portfolio gate.
 *  - repair=true  (proposal time): missing / wrong-side / out-of-range levels are replaced by ATR levels (noted in `adjusted`).
 *  - repair=false (approval time): the proposal's levels must still make sense at the fresh price, otherwise the trade is refused
 *    (code 'price_moved' for a level on the wrong side, 'risk_blocked' for out-of-range stops / caps).
 * `open` = [{symbol, allocation}] of positions (and, at proposal time, trades already proposed in this run).
 * Returns { ok:true, quoted, entry, stop, target, alloc, fee, adjusted, riskCheck } or { ok:false, code, reason }.
 */
export function sizeTrade({ symbol, side, quoted, atrPct, stopLoss, takeProfit, allocationUsd, equity, cash, open, settings, limits, repair = true }) {
  const long = side === 'long';
  const entry = applySlippage(quoted, side, 'entry', settings.slippageBps);
  const atrAbs = entry * ((atrPct || 1.5) / 100);
  const adjusted = [];
  let stop = Number(stopLoss);
  let target = Number(takeProfit);
  const stopBad = !Number.isFinite(stop) || (long ? stop >= entry : stop <= entry);
  const targetBad = !Number.isFinite(target) || (long ? target <= entry : target >= entry);
  if (stopBad || targetBad) {
    if (!repair) return { ok: false, code: 'price_moved', reason: `the price moved through the proposed ${stopBad ? 'stop' : 'target'} (${stopBad ? stopLoss : takeProfit}) at ${entry.toFixed(4)}` };
    if (stopBad) {
      stop = entry + (long ? -2 : 2) * atrAbs;
      adjusted.push(`${symbol}: stop ${stopLoss ?? 'missing'} on wrong side/invalid -> 2 ATR (${stop.toFixed(4)})`);
    }
    if (targetBad) {
      target = entry + (long ? 3.5 : -3.5) * atrAbs;
      adjusted.push(`${symbol}: target ${takeProfit ?? 'missing'} invalid -> 3.5 ATR (${target.toFixed(4)})`);
    }
  }
  const stopDist = Math.abs(entry - stop) / entry;
  if (stopDist < 0.003 || stopDist > 0.15) {
    if (!repair) return { ok: false, code: 'risk_blocked', reason: `stop is ${(stopDist * 100).toFixed(2)}% from the fresh entry (allowed 0.3%-15%)` };
    const before = stop;
    stop = entry + (long ? -2 : 2) * atrAbs;
    adjusted.push(`${symbol}: stop ${before.toFixed(4)} out of range (${(stopDist * 100).toFixed(2)}% from entry) -> 2 ATR (${stop.toFixed(4)})`);
  }
  const riskDist = Math.abs(entry - stop) / entry;
  // Loss if the stop is hit = stop distance + exit slippage + entry and exit fees (as a fraction of allocation).
  const lossFrac = riskDist + (settings.slippageBps + 2 * settings.feeBps) / 10_000;
  let alloc = Number(allocationUsd);
  if (!Number.isFinite(alloc)) alloc = Infinity;
  alloc = Math.min(alloc, equity * MAX_POSITION_PCT, (equity * MAX_RISK_PCT) / lossFrac, cash / (1 + settings.feeBps / 10_000));
  const gate = checkEntry({ open, equity, symbol, alloc, limits });
  if (!gate.ok) return { ok: false, code: 'risk_blocked', reason: gate.reason };
  alloc = gate.alloc;
  if (!(alloc >= MIN_ALLOC)) return { ok: false, code: 'risk_blocked', reason: 'no cash left' };
  const fee = feeFor(alloc, settings.feeBps);
  const gross = open.reduce((s, p) => s + p.allocation, 0);
  const cls = assetClassOf(symbol);
  const classExp = open.filter((p) => assetClassOf(p.symbol) === cls).reduce((s, p) => s + p.allocation, 0);
  const riskUsd = alloc * lossFrac;
  const riskCheck = {
    ok: true,
    grossExposureAfterUsd: +(gross + alloc).toFixed(2),
    grossExposureAfterPct: +(((gross + alloc) / equity) * 100).toFixed(2),
    assetClass: cls,
    classExposureAfterUsd: +(classExp + alloc).toFixed(2),
    classExposureAfterPct: +(((classExp + alloc) / equity) * 100).toFixed(2),
    group: groupOf(symbol),
    riskUsd: +riskUsd.toFixed(2),
    riskPct: +((riskUsd / equity) * 100).toFixed(3),
    limits: { maxGrossPct: +(limits.maxGross * 100).toFixed(1), maxClassPct: +(limits.maxClass * 100).toFixed(1), maxPerGroup: limits.maxPerGroup },
    notes: [...adjusted, ...(alloc < Number(allocationUsd) - 0.5 ? [`allocation cut from $${Number(allocationUsd).toFixed(0)} to $${alloc.toFixed(0)} by the risk caps`] : [])],
  };
  return { ok: true, quoted, entry, stop, target, alloc, fee, adjusted, riskCheck };
}
