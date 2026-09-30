import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safeUrl, sentimentView, earningsChip, flagChips, noteView, filterNotes, newsSummaryText, newsRunStatus, proposalNews, autoRejectText, validateNewsSettings, buildFinnhubPayload, FLAGS,
} from '../public/js/news-logic.js';
import { STEPS, stepperState } from '../public/js/run-logic.js';
import { buildKeyPayload, keyStatus } from '../public/js/auth-logic.js';
import { sectionSummary, SECTION_KEYS } from '../public/js/collapse-logic.js';

test('safeUrl only allows http(s)', () => {
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeUrl('http://example.com'), 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'JaVaScript:alert(1)', 'data:text/html,x', '//evil.com', '/relative', '', null, undefined, 'not a url', 'ftp://x.com', ' vbscript:x']) assert.equal(safeUrl(bad), '', String(bad));
});

test('sentimentView: label is always present, not colour-only', () => {
  assert.equal(sentimentView(0.8).label, 'Very positive');
  assert.equal(sentimentView(0.3).label, 'Positive');
  assert.equal(sentimentView(0).label, 'Neutral');
  assert.equal(sentimentView(-0.3).label, 'Negative');
  assert.equal(sentimentView(-0.9).label, 'Very negative');
  assert.equal(sentimentView(0.3).text, '+0.30');
  assert.equal(sentimentView(null).known, false);
  assert.equal(sentimentView('abc').label, 'Sentiment unknown');
  const n = sentimentView(-0.5);
  assert.equal(n.fillLeft, 25);
  assert.equal(n.fillWidth, 25);
  assert.equal(sentimentView(5).pct, 100);
});

test('earningsChip wording and soon flag', () => {
  assert.equal(earningsChip(null), null);
  assert.equal(earningsChip(-1), null);
  assert.equal(earningsChip(0).text, 'Earnings today');
  assert.equal(earningsChip(1).text, 'Earnings tomorrow');
  assert.equal(earningsChip(2).soon, true);
  assert.equal(earningsChip(5).text, 'Earnings in 5 days');
  assert.equal(earningsChip(5).soon, false);
  assert.equal(earningsChip(5, 7).soon, true);
});

test('flagChips: labels, blocking, dedupe, unknown ids readable', () => {
  const c = flagChips(['halt', 'halt', 'guidance_risk', 'new_thing'], ['halt']);
  assert.deepEqual(c.map((x) => x.id), ['halt', 'guidance_risk', 'new_thing']);
  assert.equal(c[0].blocking, true);
  assert.equal(c[1].label, 'Guidance risk');
  assert.equal(c[2].label, 'new thing');
  assert.deepEqual(flagChips(null), []);
  assert.equal(FLAGS.length, 9);
});

test('noteView: sources keep only safe links, text is clipped, nothing is HTML', () => {
  const v = noteView({ symbol: 'NVDA', sentiment: 0.4, catalyst: 'c'.repeat(500), summary: 'x'.repeat(5000), earningsInDays: 1, riskFlags: ['legal'], sources: [{ title: 'Good', url: 'https://www.reuters.com/x', publishedAt: '2026-01-01T00:00:00Z' }, { title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' }, { title: '', url: '' }] });
  assert.equal(v.catalyst.length, 200);
  assert.equal(v.summary.length, 1200);
  assert.equal(v.sources[0].host, 'reuters.com');
  assert.equal(v.sources[1].url, '');
  assert.equal(v.sources[1].title, '<img src=x onerror=alert(1)>'); // raw text: the renderer escapes
  assert.equal(v.sources[2].title, 'Source');
  assert.equal(v.soon, true);
  assert.equal(v.blocked, true);
  assert.equal(noteView({}).symbol, '?');
});

test('filterNotes and newsSummaryText', () => {
  const vs = [
    noteView({ symbol: 'B', earningsInDays: 1 }),
    noteView({ symbol: 'A', riskFlags: ['rumor'] }),
    noteView({ symbol: 'C', riskFlags: ['halt'] }),
    noteView({ symbol: 'D' }),
  ];
  assert.deepEqual(filterNotes(vs, 'all').map((v) => v.symbol), ['C', 'B', 'A', 'D']);
  assert.deepEqual(filterNotes(vs, 'flagged').map((v) => v.symbol), ['C', 'A']);
  assert.deepEqual(filterNotes(vs, 'earnings').map((v) => v.symbol), ['B']);
  assert.equal(newsSummaryText(vs), '4 notes · 1 earnings soon');
  assert.equal(newsSummaryText([vs[0]]), '1 note · 1 earnings soon');
  assert.equal(newsSummaryText([]), 'no notes yet');
  assert.equal(newsSummaryText(null), '');
  assert.equal(sectionSummary('news', { text: 'x' }), 'x');
  assert.ok(SECTION_KEYS.includes('news') && SECTION_KEYS.includes('sched'));
});

test('newsRunStatus: skipped / partial / error are obvious and explain why', () => {
  assert.equal(newsRunStatus(null), null);
  assert.equal(newsRunStatus({ status: 'ok', symbols: 30, headlines: 120, earningsKnown: 28 }).tone, 'ok');
  const p = newsRunStatus({ status: 'partial', reason: 'No Finnhub key: earnings dates unknown' });
  assert.equal(p.tone, 'warn');
  assert.match(p.text, /Add it in Settings → Account/);
  assert.equal(p.link.href, '#settings/account');
  const s = newsRunStatus({ status: 'skipped', reason: 'News is turned off' });
  assert.equal(s.tone, 'warn');
  assert.equal(s.title, 'News: skipped');
  assert.equal(s.link.href, '#settings/news');
  const e = newsRunStatus({ status: 'error', reason: 'rate_limited' });
  assert.equal(e.tone, 'bad');
  assert.match(e.text, /without news notes/);
  assert.equal(newsRunStatus({ status: 'weird' }), null);
});

test('proposalNews + autoRejectText', () => {
  const n = proposalNews({ earningsInDays: 0, riskFlags: ['halt'], notes: 'Earnings today' });
  assert.equal(n.earnings.text, 'Earnings today');
  assert.equal(n.flags[0].blocking, true);
  assert.equal(n.note, 'Earnings today');
  assert.equal(proposalNews({ notes: { summary: 's' } }).note, 's');
  assert.equal(proposalNews({}).earnings, null);
  assert.match(autoRejectText({ status: 'rejected', decidedBy: 'system', rejectReason: 'earnings blackout', earningsInDays: 1 }), /^Auto-rejected: earnings blackout \(earnings tomorrow\)/);
  assert.match(autoRejectText({ status: 'rejected', decidedBy: 'system', rejectReason: 'news risk flag: legal' }), /news risk flag “Legal”/);
  assert.equal(autoRejectText({ status: 'rejected', decidedBy: 'user', rejectReason: 'earnings blackout' }), '');
  assert.equal(autoRejectText({ status: 'rejected', decidedBy: 'system', rejectReason: 'other' }), '');
});

test('validateNewsSettings', () => {
  const ok = validateNewsSettings({ enabled: true, maxSymbols: '30', earningsBlackoutDays: '0', allowEarningsTrades: false, blockingFlags: ['halt', 'bogus', 'halt', 'legal'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { enabled: true, maxSymbols: 30, earningsBlackoutDays: 0, allowEarningsTrades: false, blockingFlags: ['halt', 'legal'] });
  const bad = validateNewsSettings({ maxSymbols: '61', earningsBlackoutDays: '2.5' });
  assert.deepEqual(Object.keys(bad.errors), ['maxSymbols', 'earningsBlackoutDays']);
  assert.equal(validateNewsSettings({ maxSymbols: '', earningsBlackoutDays: '3' }).ok, false);
  assert.equal(validateNewsSettings({ maxSymbols: '1', earningsBlackoutDays: '10', blockingFlags: [] }).ok, true);
});

test('Finnhub key field: payload, validation, status chip', () => {
  assert.equal(buildFinnhubPayload('').error !== '', true);
  assert.deepEqual(buildFinnhubPayload('  abcd1234efgh  ').payload, { finnhubKey: 'abcd1234efgh' });
  assert.ok(buildFinnhubPayload('has space1234').error);
  assert.deepEqual(buildKeyPayload('finnhub', { finnhubKey: ' abcdefgh12 ' }).payload, { finnhubKey: 'abcdefgh12' });
  assert.ok(buildKeyPayload('finnhub', { finnhubKey: 'x' }).errors.finnhubKey);
  assert.equal(keyStatus('finnhub', { set: true, source: 'account', last4: 'WXYZ' }).tone, 'ok');
  assert.match(keyStatus('finnhub', { set: true, source: 'account', last4: 'WXYZ' }).label, /WXYZ/);
  assert.equal(keyStatus('finnhub', { set: false, source: 'none' }).tone, 'off');
  assert.match(keyStatus('finnhub', { set: false, source: 'none' }).consequence, /earnings/i);
});

test('stepper has a News step between Scanner and Trader and handles stage news', () => {
  assert.deepEqual(STEPS.map((s) => s.id), ['fetching', 'scanning', 'news', 'trading']);
  const st = (stage, extra = {}) => stepperState({ startedAt: '2026-01-01T10:00:00Z', stage, running: true, ...extra }, Date.parse('2026-01-01T10:01:00Z'), extra.last).steps.map((s) => s.state);
  assert.deepEqual(st('news'), ['done', 'done', 'active', 'pending']);
  assert.deepEqual(st('scanning'), ['done', 'active', 'pending', 'pending']);
  assert.deepEqual(st('trading'), ['done', 'done', 'done', 'active']);
  assert.deepEqual(st('error', { last: 'news' }), ['done', 'done', 'error', 'pending']);
  assert.deepEqual(st('done', { running: false }), ['done', 'done', 'done', 'done']);
  assert.deepEqual(st('done', { running: false, news: { status: 'skipped' } }), ['done', 'done', 'warn', 'done']);
  assert.deepEqual(st('done', { running: false, news: { status: 'partial' } }), ['done', 'done', 'warn', 'done']);
  assert.deepEqual(st('done', { running: false, news: { status: 'ok' } }), ['done', 'done', 'done', 'done']);
});
