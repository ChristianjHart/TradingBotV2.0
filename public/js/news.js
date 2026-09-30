import { api, escapeHtml as esc, fmtDateTime } from './api.js';
import { refresh } from './data.js';
import { DEFAULT_BLOCKING, FLAGS, NEWS_FILTERS, filterNotes, flagHelp, flagLabel, newsRunStatus, newsSummaryText, noteView, validateNewsSettings } from './news-logic.js';
import { $, empty, hooks, setHtml, skeleton, state } from './state.js';
import { confirmDialog, toast } from './ui.js';

/* ---------- dashboard: News & earnings section ---------- */

const showFirst = () => (window.matchMedia?.('(max-width: 700px)').matches ? 4 : 12);
const newsCfg = () => state.status?.settings?.news || {};

export function noteViews() {
  if (!state.research) return null;
  const cfg = newsCfg();
  const opts = { blackoutDays: cfg.earningsBlackoutDays ?? 2, blocking: cfg.blockingFlags || DEFAULT_BLOCKING };
  return (state.research.notes || []).map((n) => noteView(n, opts));
}

export const newsSectionSummary = () => {
  const v = noteViews();
  return v ? newsSummaryText(v) : '';
};

function sourcesHtml(sources) {
  if (!sources.length) return '';
  const li = (s) => `<li>${s.url ? `<a class="src-link" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><span class="src-t">${esc(s.title)}</span><small>${esc(s.host)}${s.publishedAt ? ` · ${esc(fmtDateTime(s.publishedAt))}` : ''}<span class="sr-only"> (opens in a new tab)</span></small></a>` : `<span class="src-link src-plain"><span class="src-t">${esc(s.title)}</span><small>no link</small></span>`}</li>`;
  const first = sources.slice(0, 2);
  const rest = sources.slice(2);
  return `<ul class="n-src" aria-label="Sources">${first.map(li).join('')}</ul>${rest.length ? `<details class="n-more"><summary>${rest.length} more source${rest.length === 1 ? '' : 's'}</summary><ul class="n-src">${rest.map(li).join('')}</ul></details>` : ''}`;
}

export function chipHtml(tone, text, extra = '') {
  return `<span class="chip chip-${tone}"${extra}>${esc(text)}</span>`;
}

export function noteCardHtml(v) {
  const s = v.sentiment;
  const bar = `<span class="sent-bar" role="img" aria-label="${esc(s.known ? `${s.label}, score ${s.text}` : s.label)}"><i class="sent-mid"></i><i class="sent-fill sent-${s.tone}" style="left:${s.fillLeft}%;width:${s.fillWidth}%"></i></span>`;
  return `<article class="ncard${v.blocked ? ' ncard-block' : v.flagged ? ' ncard-flag' : ''}" data-nsym="${esc(v.symbol)}" aria-labelledby="n-${esc(v.symbol.replace(/[^A-Za-z0-9]/g, '_'))}-t">
    <header class="n-head"><h3 class="sym" id="n-${esc(v.symbol.replace(/[^A-Za-z0-9]/g, '_'))}-t">${esc(v.symbol)}</h3>${v.earnings ? chipHtml(v.earnings.tone, v.earnings.text) : ''}</header>
    <div class="sent">${bar}<span class="sent-l sent-t-${s.tone}">${esc(s.label)}${s.text ? ` <span class="mono">${esc(s.text)}</span>` : ''}</span></div>
    ${v.catalyst ? `<p class="n-cat"><span class="lbl">CATALYST</span> ${esc(v.catalyst)}</p>` : ''}
    ${v.flags.length ? `<div class="n-flags" aria-label="Risk flags">${v.flags.map((f) => chipHtml(f.blocking ? 'bad' : 'warn', `${f.blocking ? '⛔ ' : '⚑ '}${f.label}`, ` title="${esc(f.help)}${f.blocking ? ' (blocks proposals)' : ''}"`)).join('')}</div>` : ''}
    ${v.summary ? `<div class="clamp n-sum">${esc(v.summary)}</div>` : ''}
    ${sourcesHtml(v.sources)}
  </article>`;
}

export function newsHtml() {
  if (!state.loaded) return skeleton(3);
  const views = noteViews();
  const cfg = newsCfg();
  if (!views) return empty('News notes are not available from the server.');
  const nst = state.status?.news;
  const off = cfg.enabled === false || nst?.enabled === false;
  const banner = [];
  if (off) banner.push('<div class="news-line news-warn"><strong><span aria-hidden="true">!</span> News is turned off</strong> <span>The trader runs without news or earnings checks.</span> <a class="prop-link" href="#settings/news">Turn it on</a></div>');
  else if (nst && nst.earningsAvailable === false) banner.push(`<div class="news-line news-warn"><strong><span aria-hidden="true">!</span> Earnings dates unknown</strong> <span>No Finnhub key, so earnings blackouts cannot apply.</span> <a class="prop-link" href="#settings/account">Add a Finnhub key</a></div>`);
  if (nst?.mock) banner.push('<div class="news-line news-off"><span class="badge-demo">DEMO DATA</span> <span>Headlines and earnings dates are canned test data, not real news.</span></div>');
  const ns = newsRunStatus(state.summary?.news || state.run?.news);
  if (ns && ns.tone !== 'ok') banner.push(`<div class="news-line news-${ns.tone}"><strong>${esc(ns.title)}</strong> <span>${esc(ns.text)}</span>${ns.link ? ` <a class="prop-link" href="${esc(ns.link.href)}">${esc(ns.link.label)}</a>` : ''}</div>`);
  if (!views.length) return `${banner.join('')}${empty('No news notes yet. They appear after a run: the news bot reads headlines for the AI’s shortlist and notes earnings dates and risks.')}`;
  const f = state.newsFilter || 'all';
  const list = filterNotes(views, f);
  const shown = state.newsAll ? list : list.slice(0, showFirst());
  const counts = { all: views.length, flagged: views.filter((v) => v.flagged).length, earnings: views.filter((v) => v.soon).length };
  const seg = `<div class="seg news-filters" role="group" aria-label="Filter news notes">${NEWS_FILTERS.map(([id, l]) => `<button type="button" class="seg-btn" data-nf="${id}" aria-pressed="${f === id}">${l} <span class="dim">${counts[id]}</span></button>`).join('')}</div>`;
  return `${banner.join('')}${seg}${shown.length ? `<div class="n-grid">${shown.map(noteCardHtml).join('')}</div>` : empty('Nothing matches this filter.')}${list.length > showFirst() ? `<button type="button" class="btn-ghost picks-more" id="news-more" aria-pressed="${!!state.newsAll}">${state.newsAll ? `Show first ${showFirst()} only` : `Show all ${list.length} notes`}</button>` : ''}
    <p class="dim n-note">Notes are context for the AI trader, never instructions. The AI only proposes; you decide. Source links open the publisher’s site in a new tab.</p>`;
}

export function patchNews() {
  setHtml($('w-news'), newsHtml());
}

export function bindNews() {
  $('w-news')?.addEventListener('click', (e) => {
    const f = e.target.closest('[data-nf]');
    if (f) {
      state.newsFilter = f.dataset.nf;
      patchNews();
      $('w-news').querySelector(`[data-nf="${state.newsFilter}"]`)?.focus({ preventScroll: true });
    } else if (e.target.closest('#news-more')) {
      state.newsAll = !state.newsAll;
      patchNews();
    }
  });
}

/* ---------- Settings: news card ---------- */

export function newsCardHtml(s) {
  const n = { enabled: true, maxSymbols: 30, earningsBlackoutDays: 2, allowEarningsTrades: false, blockingFlags: DEFAULT_BLOCKING, ...(s.news || {}) };
  const sw = (id, on, label, desc) => `<div class="sw-row"><div class="sw-txt"><strong id="${id}-l">${label}</strong><p class="dim" id="${id}-d">${desc}</p></div>
    <button type="button" class="switch" id="${id}" role="switch" aria-checked="${on}" aria-labelledby="${id}-l" aria-describedby="${id}-d"><span class="sw-knob" aria-hidden="true"></span><span class="sw-state">${on ? 'ON' : 'OFF'}</span></button></div>`;
  return `<section class="widget news-set" id="sec-news" aria-labelledby="h-nset"><h2 class="widget-title" id="h-nset">NEWS &amp; EARNINGS BOT</h2>
    <p class="dim">A third AI bot reads recent headlines for the scanner’s shortlist and notes earnings dates. It never trades; it only adds context and safety checks before the trader proposes. It costs a little AI budget per run (see Settings → AI budget).</p>
    <form class="settings-form" id="f-news" novalidate>
      ${sw('sw-news-on', n.enabled, 'News step', 'Run the news bot between the scanner and the trader.')}
      <label for="ns-max">Symbols per run (1 to 60)<input id="ns-max" type="text" inputmode="numeric" enterkeyhint="next" autocomplete="off" value="${esc(n.maxSymbols)}" aria-describedby="ns-max-e" /><span class="fld-err" id="ns-max-e" role="alert"></span></label>
      <label for="ns-bd">Earnings blackout (days, 0 to 10)<input id="ns-bd" type="text" inputmode="numeric" enterkeyhint="done" autocomplete="off" value="${esc(n.earningsBlackoutDays)}" aria-describedby="ns-bd-h ns-bd-e" /><span class="fld-hint" id="ns-bd-h">A proposal for a company reporting earnings within this many days is automatically rejected.</span><span class="fld-err" id="ns-bd-e" role="alert"></span></label>
      ${sw('sw-news-earn', n.allowEarningsTrades, 'Allow trades around earnings', n.allowEarningsTrades ? 'ON: the earnings blackout is NOT applied. Earnings can gap a price far past any stop.' : 'OFF (recommended): proposals inside the blackout are rejected automatically.')}
      <fieldset class="flag-set" aria-describedby="fl-d"><legend>Block proposals on these news risks</legend>
        <p class="dim" id="fl-d">A proposal is automatically rejected when its note has any selected flag. Unselected flags are shown but do not block.</p>
        <div class="seg flag-seg">${FLAGS.map((f) => `<button type="button" class="seg-btn flag-btn" data-flag="${f}" aria-pressed="${n.blockingFlags.includes(f)}" title="${esc(flagHelp(f))}"><span>${esc(flagLabel(f))}</span><small>${esc(flagHelp(f))}</small></button>`).join('')}</div>
      </fieldset>
      <div class="row-actions"><button class="btn-accent" type="submit">Save news settings</button></div>
    </form></section>`;
}

export function wireNewsCard() {
  const form = $('f-news');
  if (!form) return;
  const toggle = (sw, on, descOn, descOff) => {
    sw.setAttribute('aria-checked', String(on));
    sw.querySelector('.sw-state').textContent = on ? 'ON' : 'OFF';
    if (descOn) $(`${sw.id}-d`).textContent = on ? descOn : descOff;
  };
  $('sw-news-on').addEventListener('click', (e) => toggle(e.currentTarget, e.currentTarget.getAttribute('aria-checked') !== 'true'));
  $('sw-news-earn').addEventListener('click', async (e) => {
    const sw = e.currentTarget;
    const next = sw.getAttribute('aria-checked') !== 'true';
    if (next) {
      const ok = await confirmDialog({
        title: 'Allow trades around earnings?',
        message: 'Earnings reports can move a stock 10% or more overnight, past any stop-loss, so a trade that looks safe can lose far more than planned. With this ON the earnings blackout is skipped and the AI may propose such trades. You still approve each one, and all positions are simulated. Turn it on only if you want to study that risk.',
        confirmText: 'Allow earnings trades',
        danger: true,
      });
      if (!ok) return;
    }
    toggle(sw, next, 'ON: the earnings blackout is NOT applied. Earnings can gap a price far past any stop.', 'OFF (recommended): proposals inside the blackout are rejected automatically.');
  });
  form.querySelectorAll('[data-flag]').forEach((b) => b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = validateNewsSettings({
      enabled: $('sw-news-on').getAttribute('aria-checked') === 'true',
      maxSymbols: $('ns-max').value,
      earningsBlackoutDays: $('ns-bd').value,
      allowEarningsTrades: $('sw-news-earn').getAttribute('aria-checked') === 'true',
      blockingFlags: [...form.querySelectorAll('[data-flag][aria-pressed="true"]')].map((b) => b.dataset.flag),
    });
    $('ns-max-e').textContent = r.errors.maxSymbols || '';
    $('ns-bd-e').textContent = r.errors.earningsBlackoutDays || '';
    $('ns-max').toggleAttribute('aria-invalid', !!r.errors.maxSymbols);
    $('ns-bd').toggleAttribute('aria-invalid', !!r.errors.earningsBlackoutDays);
    if (r.errors.maxSymbols) return $('ns-max').focus();
    if (r.errors.earningsBlackoutDays) return $('ns-bd').focus();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/settings', { method: 'PATCH', body: JSON.stringify({ news: r.value }) });
      toast('News settings saved', 'success');
      await refresh();
      hooks.patchCurrent();
    } catch (err) {
      toast(`Could not save news settings: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
