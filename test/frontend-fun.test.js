import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSignals, explainView, macroSoon, debateView, debateProblem, dayDiff } from '../public/js/explain-logic.js';
import {
  parseSeen, newlyEarned, streakText, gamifySummary, nextBadge, progressText, shareLines, ruler, whatifBody, whatifVerdict, whatifSvg, reliabilitySvg,
  calendarGroups, calendarSummary, dateLabel, relDay, moodClass, quoteChip, signedMoney, WHATIF_DEFAULTS,
} from '../public/js/fun-logic.js';
import { SECTION_KEYS, isSectionOpen, sectionSummary, sectionLabel } from '../public/js/collapse-logic.js';

/* ------------------------------------------------------------------ explainer */

test('setupSignals reads each signal relative to the trade side (a falling market supports a short)', () => {
  const setup = { mom5: -1.5, mom20: -3, rsi: 40, macdHist: -0.4, volRatio: 1.9, ret5d: -2, rs5d: -1.2, fromLow20: 1.1 };
  const short = Object.fromEntries(setupSignals(setup, 'short').map((s) => [s.id, s.stance]));
  const long = Object.fromEntries(setupSignals(setup, 'long').map((s) => [s.id, s.stance]));
  assert.equal(short.mom5, 'for');
  assert.equal(long.mom5, 'against');
  assert.equal(short.macd, 'for');
  assert.equal(short.rsi, 'for'); // weak but not washed out
  assert.equal(long.rsi, 'neutral');
  assert.equal(short.lo, 'for', 'a short pressing the 20-day low');
  assert.equal(long.lo, 'against', 'a long on the 20-day low is a falling knife');
  assert.equal(short.vol, 'neutral', 'heavy volume is information, not a side');
});

test('setupSignals: RSI extremes, thin volume, deadbands and junk input', () => {
  assert.equal(setupSignals({ rsi: 80 }, 'long')[0].stance, 'against');
  assert.equal(setupSignals({ rsi: 20 }, 'short')[0].stance, 'against');
  assert.equal(setupSignals({ rsi: 60 }, 'long')[0].stance, 'for');
  assert.equal(setupSignals({ volRatio: 0.5 }, 'long')[0].stance, 'against');
  assert.equal(setupSignals({ mom5: 0.1 }, 'long')[0].stance, 'neutral', 'inside the deadband');
  assert.deepEqual(setupSignals(null, 'long'), []);
  assert.deepEqual(setupSignals({ mom5: 'x', rsi: NaN }, 'long'), []);
});

const prop = (over = {}) => ({ id: 'p', side: 'long', entry: 100, stopLoss: 96, takeProfit: 106, confidence: 0.74, reason: 'trader', scannerReason: 'scanner', setup: { mom5: 1, rsi: 60 }, regime: 'risk-on: x', ...over });

test('explainView: tally headline, reward-to-risk, caution list (earnings, flags, low RR, macro), legacy proposals without a setup', () => {
  const cal = { days: [{ date: '2026-10-01', events: [] }, { date: '2026-10-02', events: [{ kind: 'macro', title: 'US jobs report (usually)', approx: true }] }] };
  const v = explainView(prop({ notes: { sentiment: 0.5, catalyst: 'c' }, earningsInDays: 2, riskFlags: ['legal'], takeProfit: 101 }), { calendar: cal });
  assert.equal(v.tally.for, 2);
  assert.match(v.headline, /2 of 2 signals support this long/);
  assert.equal(v.confidencePct, 74);
  assert.ok(v.rr < 0.3);
  assert.deepEqual(v.caution.map((c) => c.split(':')[0]), ['Earnings in 2 days', 'News risk flag', 'US jobs report (usually) tomorrow (date approximate)', 'Reward-to-risk is only 0.3 to 1']);
  assert.equal(v.sentiment.stance, 'for');
  const bearishNewsOnLong = explainView(prop({ notes: { sentiment: -0.6 } }));
  assert.equal(bearishNewsOnLong.sentiment.stance, 'against');
  const shortWithBearishNews = explainView(prop({ side: 'short', notes: { sentiment: -0.6 } }));
  assert.equal(shortWithBearishNews.sentiment.stance, 'for');
  const legacy = explainView(prop({ setup: null, regime: undefined }));
  assert.equal(legacy.hasSetup, false);
  assert.match(legacy.headline, /older than this feature/);
});

test('macroSoon and dayDiff', () => {
  assert.equal(dayDiff('2026-10-01', '2026-10-04'), 3);
  assert.deepEqual(macroSoon(null), []);
  const cal = { days: [{ date: '2026-10-01', events: [] }, { date: '2026-10-03', events: [{ kind: 'macro', title: 'FOMC' }, { kind: 'earnings', title: 'X' }] }, { date: '2026-10-09', events: [{ kind: 'macro', title: 'far' }] }] };
  assert.deepEqual(macroSoon(cal, 3).map((m) => [m.title, m.inDays]), [['FOMC', 2]]);
});

test('debateView and debateProblem', () => {
  assert.equal(debateView(null), null);
  assert.equal(debateView({ forTrade: { thesis: 'a', points: [] } }), null);
  const v = debateView({ forTrade: { thesis: 'a', points: ['1'] }, againstTrade: { thesis: 'b', points: [] }, verdict: { lean: 'against', note: 'n' }, source: 'demo', model: 'mock-llm', costUsd: 0.00123 });
  assert.equal(v.leanLabel, 'Leans AGAINST the trade');
  assert.equal(v.demo, true);
  assert.match(v.meta, /DEMO · mock-llm · cost \$0\.0012/);
  assert.equal(debateView({ forTrade: { thesis: 'a', points: [] }, againstTrade: { thesis: 'b', points: [] }, verdict: { lean: 'weird' } }).lean, 'even');
  assert.match(debateProblem({ code: 'no_api_key' }), /OpenRouter key/);
  assert.match(debateProblem({ code: 'budget_exhausted' }), /budget/);
  assert.match(debateProblem({ network: true }), /Could not reach/);
  assert.equal(debateProblem({ message: 'boom' }), 'boom');
});

/* ------------------------------------------------------------------ badges */

test('badge toasts: never announce on the first visit, only what is new afterwards', () => {
  const badges = [{ id: 'a', earned: true }, { id: 'b', earned: true }, { id: 'c', earned: false }];
  assert.deepEqual(newlyEarned(null, badges), []);
  assert.deepEqual(newlyEarned(['a'], badges).map((b) => b.id), ['b']);
  assert.deepEqual(newlyEarned(['a', 'b'], badges), []);
  assert.equal(parseSeen('["a","b"]').length, 2);
  assert.equal(parseSeen('{bad'), null);
  assert.equal(parseSeen(null), null);
  assert.deepEqual(parseSeen('["a",5,{}]'), ['a']);
});

test('streak and badge text helpers', () => {
  assert.equal(streakText(0), 'none yet');
  assert.equal(streakText(1), '1 so far');
  assert.equal(streakText(4), '4 in a row');
  assert.equal(gamifySummary({ earnedCount: 3, total: 13, streaks: { win: { current: 2 } } }), '3/13 badges · 🔥 2 wins in a row');
  assert.equal(gamifySummary({ earnedCount: 3, total: 13, streaks: { win: { current: 1 } } }), '3/13 badges');
  assert.equal(gamifySummary(null), '');
  const next = nextBadge([{ id: 'x', earned: true, progress: { value: 1, target: 1 } }, { id: 'y', earned: false, progress: { value: 1, target: 10 } }, { id: 'z', earned: false, progress: { value: 4, target: 5 } }]);
  assert.equal(next.id, 'z');
  assert.equal(nextBadge([{ earned: true }]), null);
  assert.equal(progressText({ id: 'four_figures', progress: { value: 250, target: 1000 } }), '$250 / $1,000');
  assert.equal(progressText({ id: 'home_run', progress: { value: 1.8, target: 2 } }), '1.8R / 2R');
  assert.equal(progressText({ id: 'veteran', progress: { value: 4, target: 10 } }), '4 / 10');
});

/* ------------------------------------------------------------------ trade of the week */

test('share card lines and entry/stop/target/exit ruler', () => {
  const t = { symbol: 'NVDA', side: 'short', pnl: 123.456, pnlPct: 2.5, r: 1.84, held: '5h', entry: 100, exitPrice: 95.5, stopLoss: 104, takeProfit: 94 };
  const L = shareLines(t);
  assert.equal(L.title, 'NVDA SHORT');
  assert.equal(L.big, '+$123.46');
  assert.equal(L.sub, '+2.50% · 1.8R · held 5h');
  assert.equal(L.levels, 'Entry $100.00  →  Exit $95.50');
  const r = ruler(t);
  assert.equal(r.target, 0);
  assert.equal(r.stop, 100);
  assert.ok(r.entry > r.exit);
  assert.equal(ruler({ entry: 1, exitPrice: 2 }), null);
});

/* ------------------------------------------------------------------ what-if */

test('whatifBody sends only changed controls; verdict wording', () => {
  assert.deepEqual(whatifBody({ ...WHATIF_DEFAULTS }), {});
  assert.deepEqual(whatifBody({ ...WHATIF_DEFAULTS, stopMult: 1.5, breakEven: false, trailR: 0, scope: 'approved' }), { stopMult: 1.5, breakEven: false, trailR: 0, scope: 'approved' });
  assert.equal(whatifVerdict(null).tone, 'none');
  assert.equal(whatifVerdict({ replayed: 0 }).tone, 'none');
  assert.equal(whatifVerdict({ replayed: 5, unchanged: true, delta: { pnl: 0 } }).tone, 'neutral');
  assert.match(whatifVerdict({ replayed: 5, delta: { pnl: 0.1 } }).text, /about the same/);
  assert.equal(whatifVerdict({ replayed: 3, delta: { pnl: 120 } }).text, 'Those settings would have made about $120 more over 3 trades.');
  assert.equal(whatifVerdict({ replayed: 1, delta: { pnl: -45 } }).text, 'Those settings would have made about $45 less over 1 trade.');
});

test('whatifSvg and reliabilitySvg draw, escape and degrade to empty', () => {
  assert.equal(whatifSvg(null), '');
  assert.equal(whatifSvg({ baseline: [], scenario: [] }), '');
  const flat = whatifSvg({ baseline: [{ v: 0 }], scenario: [{ v: 0 }] });
  assert.match(flat, /<svg/, 'a flat zero line must not divide by zero');
  assert.doesNotMatch(flat, /NaN/);
  const s = whatifSvg({ baseline: [{ v: 5 }, { v: -3 }], scenario: [{ v: 2 }, { v: 9 }] });
  assert.match(s, /wi-base/);
  assert.match(s, /wi-scen/);
  assert.doesNotMatch(s, /NaN/);
  assert.equal(reliabilitySvg({ buckets: [] }), '');
  assert.equal(reliabilitySvg(null), '');
  const r = reliabilitySvg({ buckets: [{ bucket: '60-70%', mid: 0.65, n: 10, hitRate: 0.5, ci: [0.24, 0.76] }, { bucket: '70-80%', mid: 0.75, n: 30, hitRate: 0.8, ci: [0.62, 0.9] }, { bucket: '<50%', mid: 0.25, n: 0, hitRate: null, ci: null }] });
  assert.match(r, /rel-over/, 'below the diagonal is flagged overconfident');
  assert.match(r, /rel-under/);
  assert.equal((r.match(/<circle/g) || []).length, 2, 'empty buckets draw nothing');
  assert.doesNotMatch(r, /NaN/);
  const evil = reliabilitySvg({ buckets: [{ bucket: '<img src=x onerror=1>', mid: 0.65, n: 3, hitRate: 0.5, ci: null }] });
  assert.doesNotMatch(evil, /<img/);
});

/* ------------------------------------------------------------------ calendar + mood */

test('calendar view helpers', () => {
  assert.equal(dateLabel('2026-10-01'), 'Thu, Oct 1');
  assert.equal(relDay(0), 'today');
  assert.equal(relDay(1), 'tomorrow');
  assert.equal(relDay(4), 'in 4 days');
  const cal = { counts: { earnings: 2, macro: 1 }, days: [{ date: '2026-10-01', events: [] }, { date: '2026-10-03', events: [{ id: 'a' }] }] };
  const g = calendarGroups(cal);
  assert.equal(g.length, 1, 'empty days are skipped');
  assert.equal(g[0].rel, 'in 2 days');
  assert.equal(calendarSummary(cal), '1 macro · 2 earnings');
  assert.equal(calendarSummary({ counts: { earnings: 0, macro: 0 } }), 'quiet');
  assert.equal(calendarSummary(null), '');
  assert.deepEqual(calendarGroups(null), []);
});

test('mood classes and quote chips', () => {
  assert.deepEqual([null, 5, 25, 50, 70, 95].map(moodClass), ['none', 'xfear', 'fear', 'neutral', 'greed', 'xgreed']);
  const up = quoteChip({ symbol: 'SPY', price: 565.2, changePct: 0.4 });
  assert.deepEqual([up.price, up.change, up.tone], ['565.20', '+0.40%', 'pos']);
  const btc = quoteChip({ symbol: 'BTC/USD', price: 72941.2, changePct: -1.234, stale: true });
  assert.deepEqual([btc.symbol, btc.price, btc.change, btc.tone, btc.stale], ['BTC', '72,941', '−1.23%', 'neg', true]);
  assert.equal(signedMoney(-5.5, 2), '−$5.50');
  assert.equal(signedMoney(5), '+$5');
});

/* ------------------------------------------------------------------ dashboard sections */

test('new dashboard sections are registered, collapsed by default on phones, and summarised', () => {
  for (const k of ['fun', 'totw', 'cal']) {
    assert.ok(SECTION_KEYS.includes(k), k);
    assert.equal(isSectionOpen({}, k), false);
    assert.equal(sectionSummary(k, { text: 'x' }), 'x');
    assert.equal(sectionSummary(k, {}), '');
  }
  assert.equal(sectionLabel('fun', '3/13 badges'), 'Achievements, 3/13 badges');
});
