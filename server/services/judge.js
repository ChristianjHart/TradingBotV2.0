// AI checker ("judge"): an independent second opinion on a PENDING proposal, asked several times so the answers have stats.
//
//  - It sees the trade as plain numbers only (levels, ATR, setup signals, regime, structured news fields). It does NOT see the scanner's
//    confidence or any AI reasoning, so it cannot just agree with whoever wrote the proposal.
//  - Each question is asked N times (default 3) at a higher temperature, so the runs can differ. The stats are how much they agree and
//    how much their "chance of profit" spreads.
//  - The result is advice. It never blocks, rejects or approves anything.
//  - Whether the checker is any good is NOT assumed: scorecard() compares its TAKE and SKIP calls with what really happened.
import { chatJson } from './openrouter.js';
import { config } from '../config.js';
import { store } from '../db/store.js';
import { patchProposal } from './proposals.js';
import { isAiError } from './aiErrors.js';
import { mockLlmEnabled } from './mockLlm.js';
import { cleanText } from './newsNotes.js';
import { outcomeRows, tPValue } from './review.js';
import { wilson } from './picks.js';

const HOUR = 3600_000;
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const JUDGE = Object.freeze({ RUNS_MIN: 2, RUNS_MAX: 15, RUNS_DEFAULT: 3, TEMPERATURE: 0.8, MAX_BATCH: 12, MIN_GROUP: 8, MIN_TOTAL: 20 });
export const clampRuns = (v) => (Number.isInteger(Number(v)) ? Math.min(JUDGE.RUNS_MAX, Math.max(JUDGE.RUNS_MIN, Number(v))) : JUDGE.RUNS_DEFAULT);

export const JUDGE_SYSTEM = `You are an independent, skeptical reviewer at a trading desk. You see ONE proposed simulated trade as numbers only. You do not see who proposed it or why.
Decide whether the trade is worth taking, and estimate the chance that it closes with a NET PROFIT after costs. It exits at its stop, at its target, or at the time limit (horizonHours).
Use only the numbers supplied. Do not rely on any memory of recent news or prices. Base rates matter: "breakEvenWinRate" is the win chance the levels need just to break even. If the numbers give no clear edge, say "skip" and keep pProfit close to that base rate. Most proposed trades do NOT deserve a high pProfit.
Reply with ONLY JSON: {"verdict":"take|skip","pProfit":0.0,"keyRisk":"<=140 chars","reason":"<=160 chars"}. pProfit is a number from 0 to 1.`;

/** The numbers the checker sees. Deliberately NO confidence, reasons, persona, model names or free text. */
export function buildJudgeInput(p, sample = null) {
  const entry = Number(p.entry);
  const stopDist = Math.abs(entry - Number(p.stopLoss));
  const tgtDist = Math.abs(Number(p.takeProfit) - entry);
  const rr = stopDist > 0 ? tgtDist / stopDist : null;
  const n = isPlain(p.notes) ? p.notes : null;
  return {
    task: 'trade_check',
    ...(sample != null && mockLlmEnabled() ? { sample } : {}), // only the demo fixture needs this
    trade: {
      symbol: p.symbol,
      side: p.side,
      entry,
      stopLoss: Number(p.stopLoss),
      takeProfit: Number(p.takeProfit),
      stopPct: entry > 0 ? r2((stopDist / entry) * 100) : null,
      targetPct: entry > 0 ? r2((tgtDist / entry) * 100) : null,
      rewardToRisk: rr == null ? null : r2(rr),
      breakEvenWinRate: rr == null ? null : r3(1 / (1 + rr)),
      atrPctPerHour: p.atrPct ?? null,
      horizonHours: p.horizonHours || 24,
    },
    setup: p.setup || null,
    regime: cleanText(p.regime || '', 300) || null,
    news: n ? { sentiment: n.sentiment ?? null, earningsInDays: n.earningsInDays ?? null, riskFlags: Array.isArray(n.riskFlags) ? n.riskFlags : [] } : null,
  };
}

/** Strict validation of one run. A percent written as 62 is read as 0.62. Throws (the caller's single repair retry handles it). */
export function validateJudge(json) {
  if (!isPlain(json)) throw new Error('unusable JSON shape (expected an object)');
  const verdict = typeof json.verdict === 'string' ? json.verdict.trim().toLowerCase() : '';
  if (verdict !== 'take' && verdict !== 'skip') throw new Error('"verdict" must be take or skip');
  let p = typeof json.pProfit === 'string' && json.pProfit.trim() !== '' ? Number(json.pProfit.replace('%', '')) : json.pProfit;
  if (!fin(p) || p < 0 || p > 100) throw new Error('"pProfit" must be a number from 0 to 1');
  if (p > 1) p /= 100;
  return { verdict, pProfit: r3(Math.min(0.99, Math.max(0.01, p))), keyRisk: cleanText(json.keyRisk, 160), reason: cleanText(json.reason, 180) };
}

const sdOf = (a) => {
  if (a.length < 2) return 0;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/** Stats over the runs of one proposal. `breakEven` is the win chance the trade's levels need to break even. */
export function aggregateJudge(runs, breakEven = null) {
  const n = runs.length;
  const take = runs.filter((r) => r.verdict === 'take').length;
  const skip = n - take;
  const ps = runs.map((r) => r.pProfit);
  const meanP = ps.reduce((s, x) => s + x, 0) / n;
  const call = take > skip ? 'take' : skip > take ? 'skip' : 'split';
  const agreement = Math.max(take, skip) / n;
  const sd = sdOf(ps);
  return {
    n,
    take,
    skip,
    call,
    agreement: r3(agreement),
    consensus: n < 2 ? 'single' : agreement === 1 ? 'unanimous' : call === 'split' ? 'split' : 'majority',
    meanP: r3(meanP),
    minP: r3(Math.min(...ps)),
    maxP: r3(Math.max(...ps)),
    sdP: r3(sd),
    stable: n >= 2 && sd <= 0.1,
    edge: fin(breakEven) ? r3(meanP - breakEven) : null, // chance of profit minus the chance needed to break even
    incoherent: fin(breakEven) && call !== 'split' && (call === 'take') !== (meanP >= breakEven), // says TAKE below break-even, or SKIP above it
  };
}

/* ------------------------------------------------------------------ running it */

const inflight = new Map(); // proposal id -> promise (a double click shares ONE set of paid calls)
export const isJudging = (id) => inflight.has(id);
const httpErr = (status, code, message) => Object.assign(new Error(message), { status, code });

/**
 * Check one PENDING proposal `runs` times (parallel). Saved on the proposal; a repeat is free unless `force`.
 * Partial results are kept: a run that fails (rate limit, bad answer) is counted, the rest still give stats.
 * Throws AiError when every run failed, or an Error with .status (404 not found, 409 not pending).
 */
export async function judgeProposal(id, { runs, force = false } = {}) {
  const found = store.getProposals().find((p) => p.id === id);
  if (!found) throw httpErr(404, 'not_found', 'proposal not found');
  if (found.judge && !force) return { judge: found.judge, cached: true };
  if (found.status !== 'pending') throw httpErr(409, 'not_pending', 'only a pending proposal can be checked (the check must come before the result is known)');
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    const n = clampRuns(runs ?? store.getSettings().judgeRuns);
    const model = config.openrouter.judgeModel;
    const settled = await Promise.allSettled(
      Array.from({ length: n }, (_, k) =>
        chatJson({ bot: 'judge', model, system: JUDGE_SYSTEM, user: JSON.stringify(buildJudgeInput(found, k + 1)), maxTokens: 400, timeoutMs: 45_000, runId: found.runId, temperature: JUDGE.TEMPERATURE, validate: validateJudge }),
      ),
    );
    const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    const bad = settled.filter((s) => s.status === 'rejected').map((s) => s.reason);
    if (!ok.length) throw bad.find((e) => isAiError(e) && (e.code === 'no_api_key' || e.code === 'budget_exhausted')) || bad[0];
    const stats = aggregateJudge(ok.map((o) => o.value), buildJudgeInput(found).trade.breakEvenWinRate);
    const judge = {
      at: new Date().toISOString(),
      model: ok[0].model,
      source: ok.some((o) => o.mock) ? 'demo' : 'ai',
      runsRequested: n,
      runs: ok.map((o) => o.value),
      failed: bad.length,
      failCodes: [...new Set(bad.map((e) => (isAiError(e) ? e.code : 'error')))],
      breakEvenWinRate: buildJudgeInput(found).trade.breakEvenWinRate,
      stats,
      costUsd: r3(ok.reduce((s, o) => s + (o.usage?.costUsd || 0), 0)),
    };
    if (!patchProposal(id, { judge })) throw httpErr(404, 'not_found', 'the proposal disappeared while the check was running');
    store.addLog({ level: 'info', message: `AI checker for ${found.symbol} (${judge.source}): ${stats.call.toUpperCase()}, ${Math.round(stats.meanP * 100)}% profit chance, ${stats.take}/${stats.n} say take${bad.length ? `, ${bad.length} run(s) failed` : ''}` });
    return { judge, cached: false };
  })().finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

/** Check several pending proposals one after another (each one runs its samples in parallel). Stops early if the key or budget is gone. */
export async function judgeMany(ids, { runs } = {}) {
  const out = { checked: 0, cached: 0, failed: 0, stopped: null };
  for (const id of ids.slice(0, JUDGE.MAX_BATCH)) {
    try {
      const r = await judgeProposal(id, { runs });
      if (r.cached) out.cached += 1;
      else out.checked += 1;
    } catch (err) {
      out.failed += 1;
      if (isAiError(err) && (err.code === 'no_api_key' || err.code === 'budget_exhausted')) {
        out.stopped = err.code;
        break;
      }
    }
  }
  if (out.checked || out.failed) store.addLog({ level: out.failed ? 'warn' : 'info', message: `AI checker batch: ${out.checked} checked, ${out.cached} already done, ${out.failed} failed${out.stopped ? ` (stopped: ${out.stopped})` : ''}` });
  return out;
}

/** Pending proposals that have no check yet (oldest first). */
export const unchecked = () => store.getProposals().filter((p) => p.status === 'pending' && !p.judge).map((p) => p.id).reverse();

/* ------------------------------------------------------------------ does it help? */

function group(rows) {
  const n = rows.length;
  if (!n) return { n: 0, wins: 0, winRate: null, ci: null, avgR: null, sdR: 0, pnl: 0 };
  const rs = rows.map((r) => r.r);
  const wins = rows.filter((r) => r.pnl > 0).length;
  return { n, wins, winRate: r3(wins / n), ci: wilson(wins, n), avgR: r2(rs.reduce((s, x) => s + x, 0) / n), sdR: sdOf(rs), pnl: r2(rows.reduce((s, r) => s + r.pnl, 0)) };
}

/** Welch's t-test of "TAKE and SKIP have the same average R". One pre-chosen test, so no multiple-comparison correction is needed. */
function welch(a, b) {
  if (a.n < 2 || b.n < 2) return null;
  const va = (a.sdR ** 2) / a.n;
  const vb = (b.sdR ** 2) / b.n;
  if (va + vb === 0) return a.avgR === b.avgR ? 1 : 0;
  const t = (a.avgR - b.avgR) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / ((va ** 2) / (a.n - 1) + (vb ** 2) / (b.n - 1));
  return r3(tPValue(t, df));
}

/**
 * Compare what the checker said with what happened. Only checks made BEFORE the trade's horizon ended count (a check made after the
 * result is known proves nothing). Returns { enough, judged, take, skip, split, difference, filter, calibration, verdict, ... }.
 */
export function judgeScorecard(proposals = []) {
  const byId = new Map(proposals.map((p) => [p.id, p]));
  let late = 0;
  const judged = [];
  for (const r of outcomeRows(proposals)) {
    const p = byId.get(r.id);
    const j = p?.judge?.stats;
    if (!j) continue;
    const ends = Date.parse(p.createdAt) + (p.horizonHours || 24) * HOUR;
    if (!(Date.parse(p.judge.at) < ends)) {
      late += 1;
      continue;
    }
    judged.push({ ...r, call: j.call, p: j.meanP, agreement: j.agreement });
  }
  const take = group(judged.filter((r) => r.call === 'take'));
  const skip = group(judged.filter((r) => r.call === 'skip'));
  const split = judged.filter((r) => r.call === 'split').length;
  const enough = judged.length >= JUDGE.MIN_TOTAL && take.n >= JUDGE.MIN_GROUP && skip.n >= JUDGE.MIN_GROUP;
  const p = enough ? welch(take, skip) : null;
  const diff = take.avgR != null && skip.avgR != null ? r2(take.avgR - skip.avgR) : null;
  // What if you had only taken the proposals the checker said TAKE?
  const all = group(judged);
  const filter = { allPnl: all.pnl, allCount: all.n, takeOnlyPnl: take.pnl, takeOnlyCount: take.n, change: r2(take.pnl - all.pnl) };
  // Does its "chance of profit" beat just guessing the average win rate? (Brier skill; positive = better than guessing.)
  let calibration = null;
  if (judged.length >= JUDGE.MIN_TOTAL) {
    const y = judged.map((r) => (r.pnl > 0 ? 1 : 0));
    const base = y.reduce((s, v) => s + v, 0) / y.length;
    const brier = judged.reduce((s, r, i) => s + (r.p - y[i]) ** 2, 0) / judged.length;
    const brierBase = y.reduce((s, v) => s + (base - v) ** 2, 0) / y.length;
    const bins = [[0, 0.4, 'Under 40%'], [0.4, 0.5, '40–50%'], [0.5, 0.6, '50–60%'], [0.6, 1.01, '60% or more']].map(([lo, hi, label]) => {
      const inB = judged.filter((r) => r.p >= lo && r.p < hi);
      const w = inB.filter((r) => r.pnl > 0).length;
      return { label, n: inB.length, winRate: inB.length ? r3(w / inB.length) : null };
    });
    calibration = { brier: r3(brier), brierGuessAverage: r3(brierBase), skill: brierBase > 0 ? r3(1 - brier / brierBase) : null, baseWinRate: r3(base), avgSaid: r3(judged.reduce((s, r) => s + r.p, 0) / judged.length), bins };
  }
  let verdict;
  if (!enough) verdict = `Only ${judged.length} checked proposals have a result (${take.n} TAKE, ${skip.n} SKIP). The scorecard needs ${JUDGE.MIN_TOTAL} or more, with ${JUDGE.MIN_GROUP}+ on each side.`;
  else if (diff > 0 && p <= 0.05) verdict = `TAKE trades did better than SKIP trades (${diff > 0 ? '+' : ''}${diff}R on average), and luck is an unlikely reason.`;
  else if (diff > 0) verdict = `TAKE trades did better than SKIP trades (+${diff}R on average), but the gap could be luck.`;
  else verdict = `No evidence that the checker helps. TAKE trades did not beat SKIP trades.`;
  return { enough, judged: judged.length, late, take, skip, split, difference: diff, pValue: p, filter, calibration, verdict, minTotal: JUDGE.MIN_TOTAL, minGroup: JUDGE.MIN_GROUP };
}
