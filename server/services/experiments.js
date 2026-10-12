// Experiments: replay your past proposals under a few ready-made rule changes and show which would have done better.
// It reuses the what-if engine, so it uses the same exit simulation, costs and price history. Nothing here changes any setting.
//
// Trying several ideas on the SAME trades flatters the winner (it was picked after seeing the data). So every result is marked
// "in-sample", and an idea only gets the "holds" mark when it also helped in BOTH halves of the timeline.
import { store } from '../db/store.js';
import { replayTrades, fetchBars } from './whatif.js';

export const PRESETS = [
  { id: 'stop15', title: 'Stops 1.5 times wider', why: 'Stops sit at about 2 hourly ATRs, but trades run 24 hours. Wider stops may survive normal swings.', params: { stopMult: 1.5 } },
  { id: 'stop2', title: 'Stops 2 times wider', why: 'Same idea, stronger.', params: { stopMult: 2 } },
  { id: 'wide', title: 'Stops and targets 1.5 times wider', why: 'Give each trade more room both ways.', params: { stopMult: 1.5, targetMult: 1.5 } },
  { id: 'tgt07', title: 'Targets 30% nearer', why: 'Take profit sooner, win more often.', params: { targetMult: 0.7 } },
  { id: 'nobe', title: 'No break-even stop', why: 'Moving the stop to entry can end a winner early.', params: { breakEven: false } },
  { id: 'hold48', title: 'Hold up to 48 hours', why: 'Give the trade a second day to work.', params: { horizonHours: 48 } },
  { id: 'half', title: 'Half the position size', why: 'Smaller bets cut the size of every loss.', params: { sizeMult: 0.5 } },
];

/** Pure core: the same inputs as replayTrades, one result row per preset, best first. */
export function experimentsFrom({ proposals, barsBy, settings, now, startEquity }) {
  const results = PRESETS.map((p) => {
    const r = replayTrades({ proposals, barsBy, params: { ...p.params }, settings, now, startEquity });
    const h = r.halves;
    return {
      id: p.id,
      title: p.title,
      why: p.why,
      replayed: r.replayed,
      realPnl: r.baseline.pnl,
      newPnl: r.scenario.pnl,
      delta: r.delta.pnl,
      realWinRate: r.baseline.winRate,
      newWinRate: r.scenario.winRate,
      worstDipReal: r.baseline.maxDrawdownUsd,
      worstDipNew: r.scenario.maxDrawdownUsd,
      halves: h,
      holds: Boolean(h && r.delta.pnl > 0 && h.first > 0 && h.second > 0),
    };
  }).sort((a, b) => b.delta - a.delta);
  const n = Math.max(0, ...results.map((r) => r.replayed));
  return {
    replayed: n,
    results,
    inSample: true,
    enough: n >= 20,
    note: 'These ideas were tested on the same trades they are judged on, so the best one looks better than it will be. "Holds" means it also helped in both halves of the timeline. Try an idea on new trades before you trust it.',
  };
}

export async function runExperiments() {
  const settings = store.getSettings();
  const proposals = store.getProposals().filter((x) => x.status !== 'pending').slice(0, 200);
  const barsBy = await fetchBars(new Set(proposals.map((x) => x.symbol)));
  return experimentsFrom({ proposals, barsBy, settings });
}
