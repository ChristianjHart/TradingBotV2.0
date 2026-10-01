/* Pure, DOM-free helpers for the run schedule, cost forecast and plan experiments (importable from node:test).
   Strings returned are NOT HTML-escaped; callers escape. All server text is untrusted. */

export const TZ = 'America/New_York';
export const PLAN_IDS = ['A', 'B', 'C', 'D', 'custom'];
export const PLAN_INFO = {
  A: { label: 'Plan A', when: 'Weekdays 9:00 and 12:30 ET', blurb: 'Two runs a day: at the open and after lunch.' },
  B: { label: 'Plan B', when: 'Weekdays 9:00 ET', blurb: 'One run a day at the open. The cheapest plan.' },
  C: { label: 'Plan C', when: 'Weekdays 9:00 ET + big moves', blurb: 'Plan B, plus an extra run when the market or your shortlist moves sharply (see event triggers).' },
  D: { label: 'Plan D', when: 'Weekdays 9:00, 13:00, 16:15 ET', blurb: 'Three runs a day: open, early afternoon and just after the close.' },
  custom: { label: 'Custom', when: 'Your own times', blurb: 'Pick your own run times (Eastern time).' },
};

const SKIP_TEXT = {
  market_holiday: 'US market holiday',
  weekend: 'weekend',
  insufficient_budget: 'not enough AI budget left for a run',
  no_api_key: 'no OpenRouter key',
  budget_exhausted: 'monthly AI budget used up',
  budget_warn_event_dropped: 'the budget is low, so the app pauses event runs',
  older_than_grace: 'missed by more than 20 minutes, for example during a server restart',
};
/** Plain-language skip reason; unknown codes are shown as given (with underscores turned into spaces). */
export function skipReasonText(code) {
  if (!code) return '';
  const k = String(code);
  return SKIP_TEXT[k] || k.replace(/_/g, ' ').slice(0, 80);
}

const SLOT_LABEL = { upcoming: 'Upcoming', fired: 'Ran', skipped: 'Skipped', missed: 'Missed' };
const SLOT_TONE = { upcoming: 'off', fired: 'ok', skipped: 'warn', missed: 'bad' };
const SCOPE_TEXT = { stocks: 'stocks', crypto: 'crypto', all: 'stocks + crypto' };

/** One slot of today's list -> {id, time, scopeText, label, tone, reasonText}. `timeEt` is 'HH:MM'. */
export function slotView(slot) {
  const st = SLOT_LABEL[slot?.status] ? slot.status : 'upcoming';
  const t = String(slot?.timeEt || '').slice(0, 5);
  return {
    id: String(slot?.id ?? ''),
    time: /^\d{2}:\d{2}$/.test(t) ? t12(t) : '—',
    scopeText: SCOPE_TEXT[slot?.scope] || '',
    status: st,
    label: SLOT_LABEL[st],
    tone: SLOT_TONE[st],
    reasonText: st === 'skipped' || st === 'missed' ? skipReasonText(slot?.reason) : '',
  };
}

/** '13:05' -> '1:05 PM'. */
export function t12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm));
  if (!m) return String(hhmm ?? '');
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** Next run -> {et:'Tue, Sep 30, 9:00 AM ET', local:'6:00 AM your time'|''}; empty when unknown. */
export function nextRunView(iso, localZone) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return { et: '', local: '' };
  const et = `${new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)} ET`;
  const opt = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (localZone) opt.timeZone = localZone;
  let localZoneName = '';
  try {
    localZoneName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* ignore */
  }
  const sameZone = (localZone || localZoneName) === TZ;
  return { et, local: sameZone ? '' : `${new Intl.DateTimeFormat('en-US', opt).format(d)} your time` };
}

const TRIGGER = {
  schedule: { label: 'Scheduled', tone: 'ok' },
  event: { label: 'Event', tone: 'warn' },
  manual: { label: 'Manual', tone: 'off' },
  test: { label: 'Test', tone: 'off' },
};
export function triggerBadge(trigger) {
  const t = TRIGGER[trigger?.type] || { label: 'Manual', tone: 'off' };
  const detail = trigger?.type === 'event' && trigger.reason ? String(trigger.reason).slice(0, 120) : trigger?.plan ? `plan ${String(trigger.plan).slice(0, 10)}` : '';
  return { ...t, detail };
}

const RUN_STATUS = { ok: ['Done', 'ok'], done: ['Done', 'ok'], skipped: ['Skipped', 'warn'], blocked: ['Blocked', 'warn'], error: ['Failed', 'bad'], failed: ['Failed', 'bad'], started: ['Running', 'off'], running: ['Running', 'off'] };
const usdText = (n, d = 2) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? `$${Number(n).toFixed(Number(n) > 0 && Number(n) < 0.01 ? 4 : d)}` : '—');
export { usdText };

/** A row of GET /api/schedule lastRuns. */
export function lastRunView(r) {
  const [label, tone] = RUN_STATUS[r?.status] || [String(r?.status || 'Unknown').slice(0, 20), 'off'];
  return {
    at: r?.at || '',
    trigger: triggerBadge(r?.trigger),
    statusLabel: label,
    tone,
    reasonText: r?.reason ? skipReasonText(r.reason) : '',
    costText: r?.costUsd == null ? '—' : usdText(r.costUsd),
    proposalsText: r?.proposals == null ? '—' : String(r.proposals),
  };
}

/** Test-fire / settings error -> plain words {title, message}. */
const TEST_FIRE = {
  worker_not_running: ['The worker is stopped', 'Press START in the header menu first, then try again.'],
  run_in_progress: ['A run is already in progress', 'Wait for it to finish (see the progress bar on the dashboard), then try again.'],
  no_api_key: ['No OpenRouter key', 'Add your OpenRouter key under Settings → Account. The AI needs it. There is no fallback.'],
  budget_exhausted: ['Monthly AI budget used up', 'Raise the cap under Settings → AI budget, or wait for the reset.'],
  insufficient_budget: ['Not enough budget left for a full run', 'The remaining budget is below the projected cost of one run. Raise the cap or wait for the reset.'],
  unknown_slot: ['That time slot no longer exists', 'The list was out of date. The app refreshed it. Pick a slot again.'],
};
export function testFireMessage(err) {
  const code = err?.code || err?.data?.code;
  if (code && TEST_FIRE[code]) return { title: TEST_FIRE[code][0], message: TEST_FIRE[code][1] };
  if (err?.status === 429) return { title: 'Too many runs too quickly', message: 'Wait a minute and try again.' };
  if (err?.status === 403) return { title: 'Session check failed', message: 'Reload the page and try again.' };
  if (err?.network || err?.status === 0) return { title: 'Cannot reach the server', message: 'Check your connection and try again.' };
  if (err?.status === 409) return { title: 'Could not start a run', message: String(err?.message || 'The server refused to start a run right now.').slice(0, 200) };
  return { title: 'Test run failed to start', message: String(err?.message || 'Unknown error').slice(0, 200) };
}

/* ---------------- forecast ---------------- */

/**
 * One plan of GET /api/schedule/forecast -> display model. Never invents numbers: with basis 'unknown'
 * (or null cost fields) it says the cost is unknown.
 */
export function forecastRow(p, { capUsd = 20, selected = false } = {}) {
  const info = PLAN_INFO[p?.plan] || { label: String(p?.plan || '?'), when: '', blurb: '' };
  const unknown = p?.basis === 'unknown' || p?.projectedMonthlyUsd == null || !Number.isFinite(Number(p.projectedMonthlyUsd));
  const runs = Number(p?.runsPerMonth);
  const evt = Number(p?.eventRunsAssumed) || 0;
  const cap = Number.isFinite(Number(capUsd)) ? Number(capUsd) : 20;
  const capText = `$${cap % 1 ? cap.toFixed(2) : cap}`;
  let fits = { tone: 'off', label: 'Cost unknown' };
  if (!unknown && p.fitsBudget === true) fits = { tone: 'ok', label: `Fits ${capText}` };
  else if (!unknown && p.fitsBudget === false) fits = { tone: 'bad', label: `Over ${capText}` };
  return {
    plan: String(p?.plan || ''),
    label: info.label,
    when: info.when,
    selected: !!selected,
    runsText: Number.isFinite(runs) ? `${runs} run${runs === 1 ? '' : 's'}/month${evt ? ` (incl. ~${evt} event runs assumed)` : ''}` : 'runs unknown',
    unknown,
    costText: unknown ? 'Cost unknown until your first runs' : `~${usdText(p.projectedMonthlyUsd)}/month`,
    perRunText: unknown || p.estCostPerRunUsd == null ? '' : `${usdText(p.estCostPerRunUsd, 3)} per run`,
    pctText: unknown || p.pctOfBudget == null ? '' : `${Math.round(Number(p.pctOfBudget))}% of budget`,
    basisText: { measured: 'from your real runs', estimated: 'estimate from model prices', unknown: '' }[p?.basis] || '',
    fits,
    note: String(p?.note || '').slice(0, 240),
  };
}

export function forecastRows(fc, currentPlan) {
  const cap = fc?.capUsd ?? 20;
  return (fc?.plans || []).map((p) => forecastRow(p, { capUsd: cap, selected: p.plan === currentPlan }));
}

/** Compact line for the dashboard / budget widget: from status.budget.forecast. */
export function forecastLine(f) {
  if (!f || !f.enabled) return '';
  if (f.basis === 'unknown' || f.projectedMonthlyUsd == null) return `Plan ${f.plan}: cost unknown until your first runs`;
  return `Plan ${f.plan}: ~${usdText(f.projectedMonthlyUsd)}/month, ${f.fitsBudget === false ? 'over' : 'fits'} budget`;
}

/* ---------------- experiments ---------------- */

const pct1 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : `${Math.round(Number(v) * (Math.abs(Number(v)) <= 1 ? 100 : 1))}%`);
export function experimentRow(p, minSample = {}) {
  const none = p?.plan === 'none';
  const edge = p?.edgePerDollar;
  const enough = edge != null && Number.isFinite(Number(edge));
  return {
    plan: none ? 'Untagged (manual / older runs)' : (PLAN_INFO[p?.plan]?.label || String(p?.plan || '?')),
    runs: Number(p?.runs) || 0,
    avgCostText: p?.avgCostUsd == null ? '—' : usdText(p.avgCostUsd, 3),
    proposalsPerRunText: p?.proposalsPerRun == null ? '—' : Number(p.proposalsPerRun).toFixed(1),
    approvalText: pct1(p?.approvalRate) ?? '—',
    edgePerDollarText: enough ? `${Number(edge) >= 0 ? '+' : '-'}$${Math.abs(Number(edge)).toFixed(2)} per $1` : 'not enough data yet',
    enough,
    note: String(p?.minSampleNote || '').slice(0, 240) || (enough ? '' : `Needs ${minSample.runs ?? 10} runs and ${minSample.scoredProposals ?? 10} scored proposals.`),
    sampleText: `${Number(p?.runs) || 0} runs, ${Number(p?.scoredProposals) || 0} scored proposals`,
  };
}

/* ---------------- validation ---------------- */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHHMM = (s) => HHMM.test(String(s ?? '').trim());
const numIn = (raw, min, max, label, integer = false) => {
  const s = String(raw ?? '').trim();
  if (!s || !Number.isFinite(Number(s))) return { error: `${label}: enter a number.` };
  const v = Number(s);
  if (integer && !Number.isInteger(v)) return { error: `${label}: use a whole number.` };
  if (v < min || v > max) return { error: `${label} must be between ${min} and ${max}.` };
  return { value: v };
};

/** Custom slot rows [{time,days,scope}] -> {ok, errors:[string|''], value}. */
export function validateCustomSlots(rows) {
  const errors = [];
  const value = [];
  if (rows.length > 24) return { ok: false, errors: [], value: [], error: 'At most 24 custom run times.' };
  const seen = new Set();
  rows.forEach((r, i) => {
    const time = String(r.time ?? '').trim();
    let e = '';
    if (!isHHMM(time)) e = 'Enter a time like 09:30.';
    else if (!['weekdays', 'daily'].includes(r.days)) e = 'Pick weekdays or every day.';
    else if (!['stocks', 'crypto', 'all'].includes(r.scope)) e = 'Pick stocks, crypto or both.';
    else if (seen.has(`${time}|${r.days}|${r.scope}`)) e = 'Duplicate run time.';
    else {
      seen.add(`${time}|${r.days}|${r.scope}`);
      value.push({ time, days: r.days, scope: r.scope });
    }
    errors[i] = e;
  });
  return { ok: !errors.some(Boolean), errors, value, error: '' };
}

/** Crypto run times ['HH:MM'] -> {ok, errors, value, error}. */
export function validateCryptoRuns(times) {
  if (times.length > 12) return { ok: false, errors: [], value: [], error: 'At most 12 crypto run times.' };
  const errors = [];
  const value = [];
  times.forEach((t, i) => {
    const s = String(t ?? '').trim();
    errors[i] = !isHHMM(s) ? 'Enter a time like 21:00.' : value.includes(s) ? 'Duplicate time.' : '';
    if (!errors[i]) value.push(s);
  });
  return { ok: !errors.some(Boolean), errors, value, error: '' };
}

/** Event trigger form (strings) -> {ok, errors:{field:msg}, value}. */
export function validateEventTriggers(f) {
  const specs = [
    ['spyMovePct', 0.1, 20, 'SPY move', false],
    ['btcMovePct', 0.1, 30, 'Bitcoin move', false],
    ['shortlistMovePct', 0.1, 50, 'Shortlist move', false],
    ['minMinutesBetweenEventRuns', 5, 1440, 'Cooldown (minutes)', true],
    ['maxEventRunsPerDay', 0, 10, 'Daily cap', true],
  ];
  const errors = {};
  const value = { enabled: !!f.enabled };
  for (const [k, min, max, label, int] of specs) {
    const r = numIn(f[k], min, max, label, int);
    if (r.error) errors[k] = r.error;
    else value[k] = r.value;
  }
  return { ok: !Object.keys(errors).length, errors, value };
}

/** Status line for the dashboard summary / collapsed header. */
export function scheduleSummary(s) {
  if (!s) return '';
  if (!s.enabled) return 'off';
  const next = s.nextRunAt ? nextRunView(s.nextRunAt) : null;
  const plan = s.plan === 'custom' ? 'custom' : `plan ${s.plan}`;
  if (!next?.et) return `${plan} · no run pending`;
  const short = next.et.replace(/^\w+, /, '').replace(' ET', '');
  return `${plan} · next ${short}`;
}
