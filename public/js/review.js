import { api, escapeHtml as esc } from './api.js';
import { refresh } from './data.js';
import { exitLabel, ideaRows, impactText, moneyTiles, plainUsd, reviewSummary, usd, weakRows } from './review-logic.js';
import { scorecardView } from './judge-logic.js';
import { $, empty, hooks, setHtml, skeleton, state } from './state.js';
import { toast } from './ui.js';

/* Loss review section: where the money went, which groups of trades look weak (and how likely that is luck), ideas to test, lessons. */

let ideas = { status: 'idle', data: null, error: '' }; // status: idle | busy | done | error

export const reviewSectionSummary = () => reviewSummary(state.review);

function weakHtml(rv) {
  const rows = weakRows(rv);
  if (!rows.length) return '<p class="dim">No group has a negative average yet.</p>';
  return `<table class="table rv-table"><thead><tr><th scope="col">GROUP</th><th scope="col">WON</th><th scope="col">AVG</th><th scope="col">CHANCE IT IS LUCK</th></tr></thead><tbody>${rows
    .map((r) => `<tr class="${r.flagged ? 'rv-flag' : ''}"><th scope="row">${esc(r.label)}${r.flagged ? ' <span class="chip chip-warn">LESSON</span>' : r.absorbedBy ? ` <span class="chip chip-off">MOSTLY ${esc(r.absorbedBy.toUpperCase())}</span>` : r.family === 'exploratory' ? ' <span class="chip chip-off">HINT</span>' : ''}</th><td class="mono" data-label="Won">${esc(r.won)}</td><td class="mono neg" data-label="Average">${esc(r.avgR)}</td><td data-label="Chance it is luck">${esc(r.luck)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function edgesHtml(rv) {
  if (!rv.edges.length) return '';
  return `<h3 class="rv-h">What worked</h3><ul class="rv-list">${rv.edges.map((s) => `<li><strong>${esc(s.label)}</strong> <span class="dim">${s.wins} of ${s.n} won, ${esc(`${s.avgR > 0 ? '+' : ''}${s.avgR.toFixed(2)}R`)}</span></li>`).join('')}</ul>`;
}

function ideasHtml() {
  if (ideas.status === 'busy') return '<div class="rv-busy" role="status"><span class="spin" aria-hidden="true"></span> Replaying your past trades under each idea…</div>';
  if (ideas.status === 'error') return `<p class="rv-err" role="alert">${esc(ideas.error)}</p><button type="button" class="btn-ghost" data-rv="ideas">Try again</button>`;
  if (ideas.status !== 'done') return '<button type="button" class="btn-ghost" data-rv="ideas">Test ideas on past trades</button><p class="dim rv-note">Replays your past proposals with wider stops, nearer targets and more. It changes no setting.</p>';
  const ex = ideas.data;
  if (!ex.replayed) return '<p class="dim">No past proposal is old enough, with price history, to replay yet.</p>';
  const rows = ideaRows(ex);
  return `<table class="table rv-table"><thead><tr><th scope="col">IDEA</th><th scope="col">P&amp;L CHANGE</th><th scope="col">WORST DIP</th><th scope="col">HOLDS?</th></tr></thead><tbody>${rows
    .map((r) => `<tr><th scope="row">${esc(r.title)}<small class="dim">${esc(r.why)}</small></th><td class="mono ${r.tone}" data-label="P&amp;L change">${esc(r.deltaText)}</td><td class="mono" data-label="Worst dip">${esc(r.dip)}</td><td data-label="Holds?">${r.holds ? '<span class="chip chip-ok">✓ BOTH HALVES</span>' : '<span class="dim">no</span>'}</td></tr>`)
    .join('')}</tbody></table>
    <p class="dim rv-note">${ex.replayed} past proposals. ${esc(ex.note)}</p><button type="button" class="btn-ghost" data-rv="ideas">Run again</button>`;
}

/** "Does the AI checker help?": what it said versus what happened. */
function checkerHtml(rv) {
  const v = scorecardView(rv.judge);
  if (!v || !v.judged) return `<p class="dim">No result yet. Ask the AI checker about a pending proposal. After the result is known, this shows if its TAKE calls did better than its SKIP calls.</p>`;
  return `<p class="rv-verdict rv-judge-${esc(v.tone)}" role="status"><strong>${esc(v.verdict)}</strong></p>
    <div class="rv-tiles"><div class="rv-tile"><span class="lbl">CHECKER SAID TAKE</span><strong class="mono">${esc(v.take.pnl)}</strong><small class="dim">${esc(v.take.text)}</small></div><div class="rv-tile"><span class="lbl">CHECKER SAID SKIP</span><strong class="mono">${esc(v.skip.pnl)}</strong><small class="dim">${esc(v.skip.text)}</small></div></div>
    <ul class="rv-list rv-judge-notes">${[v.luck, v.filterText, v.calText, v.splitText, v.lateText].filter(Boolean).map((t) => `<li class="dim">${esc(t)}</li>`).join('')}</ul>`;
}

function lessonsHtml(rv) {
  const on = rv.useLessons === true;
  const list = rv.lessons.length ? `<ul class="rv-list">${rv.lessons.map((l) => `<li class="rv-less rv-less-${esc(l.kind)}">${esc(l.text)}</li>`).join('')}</ul>` : `<p class="dim">${rv.enough ? 'No lesson yet. No group is weak enough to rule out luck.' : `No lesson yet. The review needs ${rv.minTotal} or more outcomes.`}</p>`;
  const impact = impactText(rv.lessonsImpact);
  return `${list}
    <div class="sw-row rv-sw"><div class="sw-txt"><strong id="rv-sw-l">Give these lessons to the trader</strong><p class="dim" id="rv-sw-d">${on ? 'ON. The trader sees these lines on every run. It still follows every risk rule, and you still approve each trade.' : 'OFF. The trader does not see these results.'}</p></div>
      <button type="button" class="switch" id="rv-sw" role="switch" aria-checked="${on}" aria-labelledby="rv-sw-l" aria-describedby="rv-sw-d"><span class="sw-knob" aria-hidden="true"></span><span class="sw-state">${on ? 'ON' : 'OFF'}</span></button></div>
    ${impact ? `<p class="dim rv-note">${esc(impact)}</p>` : ''}`;
}

export function reviewHtml() {
  if (!state.loaded) return skeleton(3);
  const rv = state.review;
  if (!rv) return empty('No review data yet.');
  const tiles = moneyTiles(rv)
    .map((t) => `<div class="rv-tile"><span class="lbl">${esc(t.label)}</span><strong class="mono ${t.tone}">${esc(t.value)}</strong><small class="dim">${esc(t.sub)}</small></div>`)
    .join('');
  const exits = rv.money.exits.length ? `<h3 class="rv-h">How trades ended</h3><ul class="rv-exits">${rv.money.exits.map((e) => `<li><span>${esc(exitLabel(e.reason))}</span><span class="mono">${e.n} · <span class="${e.pnl < 0 ? 'neg' : 'pos'}">${esc(usd(e.pnl))}</span></span></li>`).join('')}</ul>` : '';
  return `<p class="rv-verdict" role="status"><strong>${esc(rv.verdict)}</strong></p>
    <div class="rv-tiles">${tiles}</div>
    ${exits}
    <h3 class="rv-h">Weakest groups so far</h3>${weakHtml(rv)}
    <p class="dim rv-note">${esc(rv.note)} ${rv.sample.outcomes} scored outcomes.</p>
    ${edgesHtml(rv)}
    <h3 class="rv-h">Ideas to test</h3>${ideasHtml()}
    <h3 class="rv-h">Does the AI checker help?</h3>${checkerHtml(rv)}
    <h3 class="rv-h">Lessons for the trader</h3>${lessonsHtml(rv)}`;
}

export function patchReview() {
  setHtml($('w-review'), reviewHtml());
}

async function runIdeas() {
  ideas = { status: 'busy', data: null, error: '' };
  patchReview();
  try {
    ideas = { status: 'done', data: await api('/review/experiments'), error: '' };
  } catch (e) {
    ideas = { status: 'error', data: null, error: e.network ? 'Cannot reach the server. Try again.' : `The test did not run: ${e.message}` };
  }
  patchReview();
}

async function toggleLessons() {
  const next = state.review?.useLessons !== true;
  const sw = $('rv-sw');
  if (sw) sw.disabled = true;
  try {
    await api('/settings', { method: 'PATCH', body: JSON.stringify({ useLessons: next }) });
    toast(next ? 'Lessons are ON. The trader sees them on the next run.' : 'Lessons are OFF.', next ? 'warn' : 'success');
    await refresh();
    hooks.patchCurrent();
  } catch (e) {
    toast(`Could not change this: ${e.message}`, 'error');
    if (sw) sw.disabled = false;
  }
}

export function bindReview() {
  $('w-review')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-rv="ideas"]')) runIdeas();
    else if (e.target.closest('#rv-sw')) toggleLessons();
  });
}

export function resetReview() {
  ideas = { status: 'idle', data: null, error: '' };
}
