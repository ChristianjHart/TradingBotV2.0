// Streaks & badges. Everything here is DERIVED from data the app already stores (closed positions, decided proposals and their
// shadow scores, baselines), so there is nothing to persist and nothing that can drift out of sync. Pure functions only.
import { rMultiple } from './performance.js';

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (n) => Math.round(n * 100) / 100;

/** Longest and trailing run of `true` in a list of booleans. */
export function runs(flags) {
  let best = 0;
  let cur = 0;
  for (const f of flags) {
    cur = f ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return { current: cur, best };
}

/**
 * The owner's judged decisions, oldest first. A "good call" is approving a trade that made money, or rejecting one that would
 * have lost. Only decisions the owner made (decidedBy 'user') count: expiries, supersedes, news-guard blocks and auto-approvals
 * are not the owner's calls. Approved proposals are judged on the real closed position when there is one, else on the shadow score.
 */
export function judgedCalls(proposals = [], positions = []) {
  const posById = new Map(positions.map((p) => [p.id, p]));
  const calls = [];
  for (const p of proposals) {
    if (p.decidedBy !== 'user') continue;
    let pnl = null;
    if (p.status === 'approved') {
      const pos = p.positionId ? posById.get(p.positionId) : null;
      pnl = pos?.status === 'closed' && fin(pos.pnl) ? pos.pnl : fin(p.shadow?.hypotheticalPnl) ? p.shadow.hypotheticalPnl : null;
    } else if (p.status === 'rejected') {
      pnl = fin(p.shadow?.hypotheticalPnl) ? p.shadow.hypotheticalPnl : null;
    } else continue;
    if (pnl === null || pnl === 0) continue; // not scored yet, or a wash: neither good nor bad
    const good = p.status === 'approved' ? pnl > 0 : pnl < 0;
    calls.push({ id: p.id, symbol: p.symbol, kind: p.status, good, pnl: r2(pnl), at: p.decidedAt || p.createdAt });
  }
  return calls.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** [{id, emoji, name, desc, group, target, value(stats)}] in display order. `value` is the progress number; earned when >= target. */
export const BADGES = [
  { id: 'first_win', emoji: '🎯', name: 'First Win', group: 'Trading', desc: 'Close a trade in profit', target: 1, value: (s) => s.wins },
  { id: 'streak_3', emoji: '🔥', name: 'Hot Streak', group: 'Trading', desc: '3 winning trades in a row', target: 3, value: (s) => s.bestWinStreak },
  { id: 'streak_5', emoji: '⚡', name: 'On Fire', group: 'Trading', desc: '5 winning trades in a row', target: 5, value: (s) => s.bestWinStreak },
  { id: 'streak_10', emoji: '🚀', name: 'Unstoppable', group: 'Trading', desc: '10 winning trades in a row', target: 10, value: (s) => s.bestWinStreak },
  { id: 'home_run', emoji: '💥', name: 'Home Run', group: 'Trading', desc: 'A single trade worth 2R or more', target: 2, value: (s) => s.bestR },
  { id: 'veteran', emoji: '🎖️', name: 'Veteran', group: 'Trading', desc: 'Close 10 trades', target: 10, value: (s) => s.closed },
  { id: 'century', emoji: '💯', name: 'Century Club', group: 'Trading', desc: 'Close 100 trades', target: 100, value: (s) => s.closed },
  { id: 'four_figures', emoji: '💰', name: 'Four Figures', group: 'Trading', desc: 'Reach $1,000 of realized profit', target: 1000, value: (s) => s.realized },
  { id: 'dodged', emoji: '🛡️', name: 'Dodged a Bullet', group: 'Judgment', desc: 'Reject a trade that would have lost money', target: 1, value: (s) => s.avoidedCount },
  { id: 'sharp_eye', emoji: '🦅', name: 'Sharp Eye', group: 'Judgment', desc: 'Reject 5 trades that would have lost', target: 5, value: (s) => s.avoidedCount },
  { id: 'instincts', emoji: '🧠', name: 'Good Instincts', group: 'Judgment', desc: '5 good calls in a row: approve winners, reject losers', target: 5, value: (s) => s.bestCallStreak },
  { id: 'decisive', emoji: '✅', name: 'Decisive', group: 'Judgment', desc: 'Make 25 approve/reject decisions', target: 25, value: (s) => s.decisions },
  { id: 'beat_spy', emoji: '🏆', name: 'Market Beater', group: 'Judgment', desc: 'AI proposals beat SPY buy-and-hold (5+ scored trades each side)', target: 1, value: (s) => (s.beatsSpy ? 1 : 0) },
];

/**
 * { streaks, stats, badges, earnedCount, total, recentCalls }.
 * `perf` is the computePerformance() result (only baselines are used, so it may be omitted).
 */
export function computeGamify({ positions = [], proposals = [], perf = null } = {}) {
  const closed = positions.filter((p) => p.status === 'closed').sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  const winRuns = runs(closed.map((p) => p.pnl > 0));
  const calls = judgedCalls(proposals, positions);
  const callRuns = runs(calls.map((c) => c.good));
  const rs = closed.map(rMultiple).filter(fin);
  const bl = perf?.baselines;
  const stats = {
    closed: closed.length,
    wins: closed.filter((p) => p.pnl > 0).length,
    realized: r2(closed.reduce((s, p) => s + (p.pnl || 0), 0)),
    bestWinStreak: winRuns.best,
    bestR: rs.length ? r2(Math.max(...rs)) : 0,
    avoidedCount: calls.filter((c) => c.kind === 'rejected' && c.good).length,
    avoidedUsd: r2(calls.filter((c) => c.kind === 'rejected' && c.good).reduce((s, c) => s + Math.abs(c.pnl), 0)),
    decisions: proposals.filter((p) => p.decidedBy === 'user' && (p.status === 'approved' || p.status === 'rejected')).length,
    bestCallStreak: callRuns.best,
    beatsSpy: Boolean(bl?.beats?.spyHold === true && (bl.ai?.n ?? 0) >= 5 && (bl.spyHold?.n ?? 0) >= 5),
  };
  const badges = BADGES.map((b) => {
    const value = Math.max(0, Number(b.value(stats)) || 0);
    return { id: b.id, emoji: b.emoji, name: b.name, group: b.group, desc: b.desc, earned: value >= b.target, progress: { value: r2(Math.min(value, b.target)), target: b.target } };
  });
  return {
    streaks: {
      win: { current: winRuns.current, best: winRuns.best, closed: closed.length },
      calls: { current: callRuns.current, best: callRuns.best, judged: calls.length },
    },
    stats,
    badges,
    earnedCount: badges.filter((b) => b.earned).length,
    total: badges.length,
    recentCalls: calls.slice(-12),
  };
}
