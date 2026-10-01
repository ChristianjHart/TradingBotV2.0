/* Pure view-models for the "Why this pick?" panel and the bull/bear debate (no DOM). */

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const sgn = (v, dead = 0) => (v > dead ? 1 : v < -dead ? -1 : 0);
const signed = (v, d = 1, suffix = '%') => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}${suffix}`;
const STANCE_WORD = { for: 'supports', against: 'conflicts', neutral: 'neutral' };

/**
 * Signals read RELATIVE TO THE TRADE'S SIDE: rising price supports a long and conflicts with a short, so a short in a falling market
 * shows "supports". Each signal: { id, label, value, text, stance:'for'|'against'|'neutral' }.
 */
export function setupSignals(setup, side) {
  if (!setup || typeof setup !== 'object') return [];
  const dir = side === 'short' ? -1 : 1;
  const out = [];
  const trend = (id, label, v, dead, d, what) => {
    if (!fin(v)) return;
    const s = sgn(v, dead) * dir;
    out.push({ id, label, value: signed(v, d), stance: s > 0 ? 'for' : s < 0 ? 'against' : 'neutral', text: `${what} ${signed(v, d)}: ${s > 0 ? `moving the right way for a ${side}` : s < 0 ? `moving against a ${side}` : 'flat, no clear direction'}` });
  };
  trend('mom5', 'Short-term momentum', setup.mom5, 0.2, 2, 'Price momentum over the last few hours is');
  trend('mom20', 'Medium-term momentum', setup.mom20, 0.5, 2, 'Momentum over the last day or so is');
  trend('trend', 'Trend (EMA spread)', setup.trend, 0.1, 2, 'Short average vs long average is');
  trend('ret5d', '5-day return', setup.ret5d, 0.3, 2, 'The 5-day return is');
  trend('ret20d', '20-day return', setup.ret20d, 0.5, 2, 'The 20-day return is');
  trend('rs5d', 'vs market (5 days)', setup.rs5d, 0.3, 2, 'Relative to its benchmark over 5 days it is');
  trend('rs20d', 'vs market (20 days)', setup.rs20d, 0.5, 2, 'Relative to its benchmark over 20 days it is');
  if (fin(setup.macdHist)) {
    const s = sgn(setup.macdHist) * dir;
    out.push({ id: 'macd', label: 'MACD histogram', value: signed(setup.macdHist, 2, ''), stance: s > 0 ? 'for' : s < 0 ? 'against' : 'neutral', text: `MACD histogram ${signed(setup.macdHist, 2, '')}: ${s > 0 ? 'momentum is building in the trade’s direction' : s < 0 ? 'momentum is fading or turning against it' : 'no signal'}` });
  }
  if (fin(setup.rsi)) {
    const r = setup.rsi;
    let stance = 'neutral';
    let text = `RSI ${r.toFixed(0)}: middle of the range, no extreme`;
    if (dir > 0) {
      if (r >= 75) [stance, text] = ['against', `RSI ${r.toFixed(0)}: overbought, a long may be late`];
      else if (r >= 50) [stance, text] = ['for', `RSI ${r.toFixed(0)}: healthy strength without being stretched`];
    } else if (r <= 25) [stance, text] = ['against', `RSI ${r.toFixed(0)}: oversold, a short may be late`];
    else if (r <= 50) [stance, text] = ['for', `RSI ${r.toFixed(0)}: weak without being washed out`];
    out.push({ id: 'rsi', label: 'RSI', value: r.toFixed(0), stance, text });
  }
  if (fin(setup.volRatio)) {
    const v = setup.volRatio;
    out.push({ id: 'vol', label: 'Volume', value: `${v.toFixed(1)}x`, stance: v < 0.7 ? 'against' : 'neutral', text: v >= 1.5 ? `Volume is ${v.toFixed(1)}x normal: real participation behind the move` : v < 0.7 ? `Volume is only ${v.toFixed(1)}x normal: thin, low conviction` : `Volume is ${v.toFixed(1)}x normal: nothing unusual` });
  }
  if (dir > 0 && fin(setup.fromHigh20) && setup.fromHigh20 >= -2) out.push({ id: 'hi', label: 'Near 20-day high', value: signed(setup.fromHigh20, 1), stance: 'for', text: `${signed(setup.fromHigh20, 1)} from its 20-day high: pressing resistance with strength` });
  if (dir < 0 && fin(setup.fromLow20) && setup.fromLow20 <= 2) out.push({ id: 'lo', label: 'Near 20-day low', value: signed(setup.fromLow20, 1), stance: 'for', text: `${signed(setup.fromLow20, 1)} from its 20-day low: pressing support with weakness` });
  if (dir > 0 && fin(setup.fromLow20) && setup.fromLow20 <= 2) out.push({ id: 'lo', label: 'Near 20-day low', value: signed(setup.fromLow20, 1), stance: 'against', text: 'Sitting on its 20-day low: a long here is catching a falling knife' });
  if (dir < 0 && fin(setup.fromHigh20) && setup.fromHigh20 >= -2) out.push({ id: 'hi', label: 'Near 20-day high', value: signed(setup.fromHigh20, 1), stance: 'against', text: 'Sitting on its 20-day high: a short here is fighting strength' });
  return out;
}

/** Whole-days difference between two 'YYYY-MM-DD' (UTC) strings, b - a. */
export const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Macro events (FOMC, jobs report) within `withinDays` of today from a /api/calendar payload. */
export function macroSoon(calendar, withinDays = 3) {
  const days = calendar?.days;
  if (!Array.isArray(days) || !days.length) return [];
  const today = days[0].date;
  const out = [];
  for (const d of days) {
    const n = dayDiff(today, d.date);
    if (n > withinDays) break;
    for (const e of d.events) if (e.kind === 'macro') out.push({ title: e.title, date: d.date, inDays: n, approx: Boolean(e.approx) });
  }
  return out;
}

const when = (n) => (n <= 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);

/**
 * The full "why" model for one proposal. Everything comes from data stored on the proposal (so it costs nothing and is reproducible):
 * the scanner's reason, the trader's reason, the stored technical setup, the regime line, the news note fields and the risk levels.
 */
export function explainView(p, { calendar = null } = {}) {
  const side = p.side === 'short' ? 'short' : 'long';
  const signals = setupSignals(p.setup, side);
  const tally = { for: 0, against: 0, neutral: 0 };
  for (const s of signals) tally[s.stance] += 1;
  const stop = Number(p.stopLoss);
  const target = Number(p.takeProfit);
  const entry = Number(p.entry);
  const risk = Math.abs(entry - stop);
  const rr = risk > 0 ? Math.abs(target - entry) / risk : null;
  const n = p.notes && typeof p.notes === 'object' ? p.notes : null;
  const sent = n && fin(n.sentiment) ? n.sentiment : null;
  const sentStance = sent === null ? null : sgn(sent, 0.15) * (side === 'short' ? -1 : 1);
  const earningsDays = fin(p.earningsInDays) ? p.earningsInDays : fin(n?.earningsInDays) ? n.earningsInDays : null;
  const flags = Array.isArray(p.riskFlags) ? p.riskFlags : [];
  const macro = macroSoon(calendar, 3);
  const caution = [];
  if (earningsDays !== null && earningsDays >= 0 && earningsDays <= 5) caution.push(`Earnings ${when(earningsDays)}: gaps can jump straight past a stop`);
  for (const f of flags) caution.push(`News risk flag: ${String(f).replace(/_/g, ' ')}`);
  for (const m of macro) caution.push(`${m.title} ${when(m.inDays)}${m.approx ? ' (date approximate)' : ''}: expect a volatile session`);
  if (rr !== null && rr < 1.5) caution.push(`Reward-to-risk is only ${rr.toFixed(1)} to 1`);
  const headline = signals.length
    ? `${tally.for} of ${signals.length} signals support this ${side}${tally.against ? `, ${tally.against} conflict` : ''}`
    : 'No technical snapshot was saved with this proposal (it predates the feature), so only the AI’s own reasoning is shown.';
  return {
    side,
    hasSetup: signals.length > 0,
    signals,
    tally,
    headline,
    scannerReason: p.scannerReason || '',
    traderReason: p.reason || '',
    confidencePct: fin(p.confidence) ? Math.round(p.confidence * 100) : null,
    regime: p.regime || '',
    rr,
    stopPct: entry > 0 && risk >= 0 ? (risk / entry) * 100 : null,
    sentiment: sent === null ? null : { value: sent, text: `${sent > 0 ? '+' : ''}${sent.toFixed(2)}`, stance: sentStance > 0 ? 'for' : sentStance < 0 ? 'against' : 'neutral', note: n?.catalyst || '' },
    earningsDays,
    caution,
    persona: p.persona || 'default',
  };
}

const LEAN_LABEL = { for: 'Leans FOR the trade', against: 'Leans AGAINST the trade', even: 'Too close to call' };

/** View-model of a stored debate (null when none). */
export function debateView(d) {
  if (!d || !d.forTrade || !d.againstTrade) return null;
  const lean = LEAN_LABEL[d.verdict?.lean] ? d.verdict.lean : 'even';
  return {
    lean,
    leanLabel: LEAN_LABEL[lean],
    note: d.verdict?.note || '',
    forTrade: { thesis: d.forTrade.thesis || '', points: Array.isArray(d.forTrade.points) ? d.forTrade.points : [] },
    againstTrade: { thesis: d.againstTrade.thesis || '', points: Array.isArray(d.againstTrade.points) ? d.againstTrade.points : [] },
    demo: d.source === 'demo',
    meta: `${d.source === 'demo' ? 'DEMO' : 'AI'}${d.model ? ` · ${d.model}` : ''}${fin(d.costUsd) ? ` · cost $${d.costUsd < 0.1 ? d.costUsd.toFixed(4) : d.costUsd.toFixed(2)}` : ''}`,
  };
}

export const DEBATE_ERRORS = {
  no_api_key: 'Add your OpenRouter key under Settings → Account to run a debate.',
  budget_exhausted: 'The monthly AI budget is used up, so the debate was not run.',
  rate_limited: 'The model is rate limited right now. Try again in a minute.',
  model_unavailable: 'The trader model is unavailable. Pick another under Settings → Models.',
  invalid_output: 'The model returned something unusable twice. Nothing was saved.',
  timeout: 'The model took too long. Try again.',
  upstream_error: 'Could not reach the model. Try again.',
};
/** Plain-language message for a failed debate request (`e` from api(): {status, code, message, network}). */
export const debateProblem = (e) => (e?.network ? 'Could not reach the server. Check your connection and try again.' : DEBATE_ERRORS[e?.code] || e?.message || 'The debate could not be run.');
