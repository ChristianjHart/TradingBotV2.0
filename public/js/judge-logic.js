/* Pure view helpers for the AI checker (no DOM). */
import { luckText, plainUsd, rText, usd } from './review-logic.js';

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
export const pct = (x) => (fin(x) ? `${Math.round(x * 100)}%` : '—');

const CALL = {
  take: { label: 'TAKE', tone: 'good', word: 'worth taking' },
  skip: { label: 'SKIP', tone: 'bad', word: 'not worth taking' },
  split: { label: 'SPLIT', tone: 'warn', word: 'undecided' },
};

/** View of one saved check (proposal.judge). Null when there is none. */
export function judgeView(j) {
  const s = j?.stats;
  if (!s) return null;
  const c = CALL[s.call] || CALL.split;
  const multi = s.n >= 2;
  const lead = Math.max(s.take, s.skip);
  return {
    call: s.call,
    label: c.label,
    tone: c.tone,
    pText: pct(s.meanP),
    rangeText: multi && s.maxP > s.minP ? `${pct(s.minP)} to ${pct(s.maxP)}` : '',
    agreeText: multi ? (s.call === 'split' ? `${s.take} say take, ${s.skip} say skip` : `${lead} of ${s.n} agree`) : 'one run only',
    steady: multi && s.stable,
    stableText: multi && !s.stable ? 'The runs gave very different numbers.' : '', // only the bad news is a warning
    needText: fin(j.breakEvenWinRate) ? `${pct(j.breakEvenWinRate)} needed to break even` : '',
    incoherent: Boolean(s.incoherent),
    incoherentText: s.incoherent ? (s.call === 'take' ? 'It says TAKE but puts the chance of profit below break-even.' : 'It says SKIP but puts the chance of profit above break-even.') : '',
    failedText: j.failed ? `${j.failed} of ${j.runsRequested} runs failed.` : '',
    costText: fin(j.costUsd) && j.costUsd > 0 ? `Cost ${plainUsd(j.costUsd, j.costUsd < 0.1 ? 4 : 2)}.` : '',
    demo: j.source === 'demo',
    model: j.model || '',
    runs: (j.runs || []).map((r) => ({ label: r.verdict === 'take' ? 'TAKE' : 'SKIP', tone: r.verdict === 'take' ? 'good' : 'bad', pText: pct(r.pProfit), keyRisk: r.keyRisk || '', reason: r.reason || '' })),
    summary: `${c.label} ${pct(s.meanP)}`,
  };
}

/** How many AI calls "Check all" will make, for the confirm text. */
export function checkAllPlan(pending, runs = 3) {
  const todo = (pending || []).filter((p) => p.status === 'pending' && !p.judge);
  return { count: todo.length, calls: todo.length * runs, ids: todo.map((p) => p.id) };
}

/** Rows and sentences for the scorecard ("Does the AI checker help?"). */
export function scorecardView(sc) {
  if (!sc) return null;
  const side = (label, g) => ({ label, text: g.n ? `${g.n} trades · ${g.wins} won (${pct(g.winRate)}) · average ${rText(g.avgR)}` : 'none yet', pnl: usd(g.pnl) });
  const cal = sc.calibration;
  return {
    enough: sc.enough,
    verdict: sc.verdict,
    tone: !sc.enough ? 'none' : sc.difference > 0 && sc.pValue != null && sc.pValue <= 0.05 ? 'good' : sc.difference > 0 ? 'warn' : 'bad',
    take: side('TAKE', sc.take),
    skip: side('SKIP', sc.skip),
    splitText: sc.split ? `${sc.split} split ${sc.split === 1 ? 'call is' : 'calls are'} left out.` : '',
    luck: sc.enough && sc.pValue != null ? `Chance the gap is luck: ${luckText(sc.pValue)}.` : '',
    filterText: sc.enough ? `Taking only the TAKE calls would have made ${usd(sc.filter.takeOnlyPnl)} instead of ${usd(sc.filter.allPnl)} (${sc.filter.change >= 0 ? 'better by' : 'worse by'} ${plainUsd(Math.abs(sc.filter.change))}).` : '',
    calText: cal && cal.skill != null ? `Its chance-of-profit numbers ${cal.skill > 0 ? 'beat' : 'did not beat'} just guessing the average win rate (${pct(cal.baseWinRate)}). It said ${pct(cal.avgSaid)} on average.` : '',
    lateText: sc.late ? `${sc.late} checks were made after the result was known and are not counted.` : '',
    judged: sc.judged,
  };
}

export const JUDGE_ERRORS = {
  no_api_key: 'Add your OpenRouter key in Settings → Account to use the AI checker.',
  budget_exhausted: 'You used all of this month’s AI budget, so the check did not run.',
  rate_limited: 'The checker model is rate limited. Try again in one minute.',
  model_unavailable: 'The checker model is unavailable. Pick another in Settings → Models.',
  invalid_output: 'The checker gave unusable answers. The app saved nothing.',
  timeout: 'The checker took too long. Try again.',
  upstream_error: 'Could not reach the checker model. Try again.',
  not_pending: 'Only a pending proposal can be checked.',
  invalid_runs: 'Pick 2 to 15 runs.',
};
/** Plain words for a failed check (`e` from api(): {status, code, message, network}). */
export const judgeProblem = (e) => (e?.network ? 'Cannot reach the server. Check your connection and try again.' : JUDGE_ERRORS[e?.code] || e?.message || 'The check could not run.');
