import {
  api,
  apiOptional,
  fmtMoney,
  fmtPct,
  fmtTime,
  fmtDateTime,
  fmtDuration,
  clsPos,
  escapeHtml as esc,
  getToken,
  setToken,
  onUnauthorized,
} from './api.js';
import { CandleChart, LineChart, aggregateBars } from './charts.js';
import { toast, confirmDialog, tokenDialog } from './ui.js';

const root = document.getElementById('view-root');
const POLL_MS = 15000;
const PAGES = ['dashboard', 'performance', 'market', 'logs', 'settings'];
const TITLES = { dashboard: 'Dashboard', performance: 'Performance', market: 'Market', logs: 'Logs', settings: 'Settings' };
const EXIT_LABEL = { 'stop-loss': 'Stop-loss', 'take-profit': 'Take-profit', 'time-exit': 'Time exit', manual: 'Manual', 'trailing-stop': 'Trailing stop' };

const state = {
  page: 'dashboard',
  loaded: false,
  loadError: null,
  lastUpdate: null,
  status: null,
  dashboard: null,
  picks: null,
  positions: null,
  summary: null,
  perf: null,
  runs: null,
  logs: null,
  auth: { required: false },
  run: null,
  runLastStage: null,
  posTab: 'open',
  sort: { key: 'pnl', dir: 'desc' },
  selectedPos: null,
  tf: '1H',
  indicators: { vol: true, vwap: true, ema9: true, ema21: true },
  symbol: 'SPY',
  quotes: [],
  logFilter: 'all',
};
let charts = {}; // per-page chart instances
const barsCache = new Map();

/* ---------- small helpers ---------- */

/** Set innerHTML only when it changed; keeps scroll positions of inner scroll areas. */
function setHtml(el, html) {
  if (!el || el.__h === html) return;
  const scrolls = [...el.querySelectorAll('.scroll-y')].map((n) => n.scrollTop);
  el.innerHTML = html;
  el.__h = html;
  el.querySelectorAll('.scroll-y').forEach((n, i) => {
    if (scrolls[i]) n.scrollTop = scrolls[i];
  });
}
const $ = (id) => document.getElementById(id);
const setText = (el, t) => {
  if (el && el.textContent !== t) el.textContent = t;
};
const setCls = (el, c) => {
  if (el && el.className !== c) el.className = c;
};
const pctOf = (v) => (v == null ? null : Math.abs(v) <= 1 ? v * 100 : v); // tolerate fraction or percent
const skeleton = (n = 3) => `<div class="skel-wrap" aria-hidden="true">${Array.from({ length: n }, () => '<div class="skeleton"></div>').join('')}</div>`;
const empty = (msg) => `<div class="empty">${esc(msg)}</div>`;
const nowMs = () => Date.now();

function destroyCharts() {
  Object.values(charts).forEach((c) => c?.destroy?.());
  charts = {};
}

/* ---------- top-bar chrome ---------- */

function setWorkerUI(worker) {
  const dot = $('worker-dot');
  if (!worker || !dot) return;
  dot.classList.remove('offline', 'warn');
  if (worker.status === 'degraded') dot.classList.add('warn');
  else if (worker.status !== 'online') dot.classList.add('offline');
  setText($('worker-label'), `worker ${worker.status || 'unknown'}`);
}

function updateAuthUI() {
  const b = $('btn-auth');
  if (!b) return;
  b.hidden = !state.auth.required;
  b.textContent = getToken() ? 'Sign out' : 'Sign in';
  b.setAttribute('aria-label', getToken() ? 'Sign out (forget admin token)' : 'Sign in with admin token');
}

onUnauthorized(async () => {
  const had = !!getToken();
  const t = await tokenDialog(had ? 'The saved admin token was rejected. Enter the correct token.' : 'This action requires the admin token configured on the server (ADMIN_TOKEN).');
  if (t) {
    state.auth.required = true;
    setTimeout(updateAuthUI, 0);
  } else {
    if (had) setToken('');
    updateAuthUI();
  }
  return t;
});

function navActive(page) {
  document.querySelectorAll('#main-nav a').forEach((a) => {
    const on = a.dataset.nav === page;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/* ---------- data ---------- */

let refreshing = null;
function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const [status, dashboard, picks, positions, summary, perf] = await Promise.all([
        api('/status'),
        apiOptional('/dashboard'),
        apiOptional('/ai/picks'),
        apiOptional('/positions'),
        apiOptional('/ai/summary'),
        apiOptional('/performance'),
      ]);
      Object.assign(state, { status, dashboard, picks, positions, summary, perf, loaded: true, loadError: null, lastUpdate: new Date() });
      if (status.run) {
        state.run = { ...(state.run || {}), ...status.run };
        if (status.run.running && !runTracking) trackRun();
      }
      setWorkerUI(status.worker);
    } catch (e) {
      state.loadError = e.message;
      throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/* ---------- run pipeline ---------- */

const STEPS = [
  { id: 'fetching', label: 'Fetch market data', hint: 'downloading bars' },
  { id: 'scanning', label: 'Scanner bot', hint: 'AI can take 1–3 min' },
  { id: 'trading', label: 'Trader bot', hint: 'sizing & simulating trades' },
];
let runTracking = false;

function isRunning() {
  return !!state.run?.running;
}

function runBarHtml() {
  const r = state.run;
  if (!r || !r.startedAt || r.stage === 'idle') return '';
  const idx = STEPS.findIndex((s) => s.id === r.stage);
  const errIdx = Math.max(0, STEPS.findIndex((s) => s.id === state.runLastStage));
  const steps = STEPS.map((s, i) => {
    let st = 'pending';
    if (r.stage === 'done') st = 'done';
    else if (r.stage === 'error') st = i < errIdx ? 'done' : i === errIdx ? 'error' : 'pending';
    else if (idx >= 0) st = i < idx ? 'done' : i === idx ? 'active' : 'pending';
    const icon = { done: '✓', error: '!', active: '', pending: String(i + 1) }[st];
    const sr = { done: 'complete', error: 'failed', active: 'in progress', pending: 'pending' }[st];
    return `<li class="step step-${st}" ${st === 'active' ? 'aria-current="step"' : ''}>
      <span class="step-dot" aria-hidden="true">${st === 'active' ? '<span class="spin"></span>' : icon}</span>
      <span class="step-txt"><strong>${s.label}</strong><small>${st === 'active' ? esc(s.hint) : ''}<span class="sr-only"> ${sr}</span></small></span></li>`;
  }).join('');
  const tail =
    r.stage === 'error'
      ? `<span class="neg">Run failed: ${esc(r.error || 'unknown error')}</span>`
      : r.stage === 'done'
        ? `<span class="pos">Done — ${r.picks ?? 0} picks, ${r.opened ?? 0} position(s) opened</span>`
        : '<span class="dim">Running…</span>';
  return `<div class="run-bar" role="group" aria-label="Run progress"><ol class="stepper">${steps}</ol>
    <div class="run-meta">${tail} <span class="mono dim" id="run-elapsed"></span></div></div>`;
}

function patchRunBar() {
  setHtml($('run-bar'), runBarHtml());
  tickRun();
  const b = $('btn-scan');
  if (b) {
    b.disabled = isRunning();
    b.setAttribute('aria-busy', isRunning() ? 'true' : 'false');
    setText(b, isRunning() ? 'RUNNING…' : 'RUN');
  }
}
function tickRun() {
  const r = state.run;
  const el = $('run-elapsed');
  if (!el || !r?.startedAt) return;
  const end = r.running ? nowMs() : new Date(r.finishedAt || nowMs()).getTime();
  setText(el, `elapsed ${fmtDuration(end - new Date(r.startedAt).getTime())}`);
}

async function startRun() {
  try {
    const res = await api('/run', { method: 'POST' });
    state.run = { ...(state.run || {}), ...res, running: true, stage: res.stage || 'fetching', startedAt: res.startedAt || new Date().toISOString() };
    patchRunBar();
    trackRun();
  } catch (e) {
    toast(`Could not start run: ${e.message}`, 'error');
  }
}

async function trackRun() {
  if (runTracking) return;
  runTracking = true;
  let lastStage = null;
  try {
    for (;;) {
      const st = await api('/run/status');
      if (st.running) state.runLastStage = st.stage;
      state.run = { ...st };
      patchRunBar();
      if (st.stage !== lastStage && lastStage !== null && (st.stage === 'trading' || !st.running)) {
        await refresh().catch(() => {});
        patchCurrent();
      }
      lastStage = st.stage;
      if (!st.running) {
        await refresh().catch(() => {});
        patchCurrent();
        if (st.error || st.stage === 'error') toast(`Run failed: ${st.error || 'unknown error'}`, 'error');
        else if (st.stage === 'done') toast(`Run complete — ${st.picks ?? 0} picks, ${st.opened ?? 0} position(s) opened`, 'success');
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) {
    toast(`Lost track of the run: ${e.message}`, 'error');
  } finally {
    runTracking = false;
    patchRunBar();
  }
}

/* ---------- dashboard widgets ---------- */

function donutGradient(parts) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  let acc = 0;
  return `conic-gradient(${parts
    .map((p) => {
      const start = (acc / total) * 360;
      acc += p.value;
      return `${p.color} ${start}deg ${(acc / total) * 360}deg`;
    })
    .join(', ')})`;
}

function summaryHtml() {
  const sm = state.summary;
  const picksN = state.picks?.picks?.length || 0;
  if (!state.loaded) return skeleton(3);
  if (!sm || !sm.at) return empty('Press RUN — the scanner bot ranks the top picks, then the trader bot decides which to simulate.');
  const n = sm.trades?.length || 0;
  const who = sm.traderSource === 'ai' ? 'AI' : 'Rule-based bot';
  const head = n ? `${who} simulated ${n} trade${n === 1 ? '' : 's'} from a top ${sm.picks || picksN}` : `${who} simulated no trades from a top ${sm.picks || picksN}`;
  return `
    <div class="sum-head">${esc(head)}</div>
    <div class="dim sum-when">${esc(new Date(sm.at).toLocaleString())} · scanner ${esc(sm.scannerModel || sm.scannerSource)} · trader ${esc(sm.traderModel || sm.traderSource)}</div>
    ${sm.note ? `<p class="sum-note">${esc(sm.note)}</p>` : ''}
    ${n ? `<ul class="sum-list">${sm.trades.map((t) => `<li><span class="sym">${esc(t.symbol)}</span> <span class="pill pill-${esc(t.side)}">${esc(t.side)}</span>
        <span class="mono dim">${fmtMoney(t.allocation, 0)}</span> — ${esc(t.reason)}</li>`).join('')}</ul>` : ''}
    ${(sm.rejected || []).length ? `<div class="dim sum-rej">Passed on: ${sm.rejected.map(esc).join(', ')}</div>` : ''}`;
}

function allocationHtml() {
  if (!state.loaded) return skeleton(2);
  const open = state.positions?.open || [];
  const acct = state.positions?.account;
  const longs = open.filter((p) => p.side === 'long').reduce((a, p) => a + p.allocation, 0);
  const shorts = open.filter((p) => p.side === 'short').reduce((a, p) => a + p.allocation, 0);
  const cash = Math.max(0, acct?.cash ?? 0);
  let parts = [
    { label: 'LONG', value: longs, color: '#22c55e' },
    { label: 'SHORT', value: shorts, color: '#ef4444' },
    { label: 'CASH', value: cash, color: '#8b5cf6' },
  ].filter((a) => a.value > 0);
  if (!parts.length) parts = [{ label: 'CASH', value: 1, color: '#8b5cf6' }];
  const total = parts.reduce((a, p) => a + p.value, 0);
  const text = parts.map((p) => `${p.label} ${total > 1 ? fmtMoney(p.value, 0) : ''}`).join(', ');
  return `<div class="alloc-wrap">
    <div class="donut" role="img" aria-label="Allocation: ${esc(text)}" style="background:${donutGradient(parts)}"><div class="donut-hole"></div></div>
    <div class="legend">${parts.map((a) => `<div class="legend-row"><span class="swatch" style="background:${a.color}"></span><span>${a.label}</span><span class="muted mono">${total > 1 ? fmtMoney(a.value, 0) : ''}</span></div>`).join('')}</div></div>`;
}

function accuracyHtml() {
  if (!state.loaded) return skeleton(3);
  const acct = state.positions?.account;
  const p = state.perf;
  const closed = p?.closed ?? acct?.closedCount ?? 0;
  const wins = p?.wins ?? acct?.wins ?? 0;
  const wr = p?.winRate != null ? pctOf(p.winRate) : closed ? (wins / closed) * 100 : null;
  const small = closed < 20;
  const pa = p?.pickAccuracy;
  return `
    <div class="big-num">${wr == null ? '—' : `${wr.toFixed(0)}%`}</div>
    <div class="sub-num">${closed ? `${wins} wins / ${closed} closed trades` : 'no closed trades yet'}</div>
    ${closed && small ? `<div class="warn-note">Small sample (${closed} trade${closed === 1 ? '' : 's'}) — not statistically meaningful yet.</div>` : ''}
    <div class="perf-grid">
      <div class="perf-stat"><span class="lbl">EQUITY</span><strong>${fmtMoney(acct?.equity, 0)}</strong></div>
      <div class="perf-stat"><span class="lbl">REALIZED P&amp;L</span><strong class="${clsPos(acct?.realizedPnl)}">${fmtMoney(acct?.realizedPnl, 0)}</strong></div>
      <div class="perf-stat"><span class="lbl">OPEN P&amp;L</span><strong class="${clsPos(acct?.unrealizedPnl)}">${fmtMoney(acct?.unrealizedPnl, 0)}</strong></div>
      <div class="perf-stat"><span class="lbl">OPEN</span><strong>${acct?.openCount ?? 0}</strong></div>
      <div class="perf-stat"><span class="lbl">AVG R</span><strong>${p?.avgR != null ? `${Number(p.avgR).toFixed(2)}R` : '—'}</strong></div>
      <div class="perf-stat"><span class="lbl">PICK ACCURACY</span><strong>${pa && pa.total ? `${((pa.hits / pa.total) * 100).toFixed(0)}% (${pa.hits}/${pa.total})` : '—'}</strong></div>
    </div>`;
}

function bannersHtml() {
  const s = state.status || {};
  const out = [];
  if (state.loadError) out.push(`<div class="notice" role="alert">Can’t reach the server (${esc(state.loadError)}). Showing the last data received${state.lastUpdate ? ` at ${esc(fmtTime(state.lastUpdate))}` : ''}; retrying automatically.</div>`);
  if (s.mockData) out.push('<div class="banner-mock">Running on <strong>mock</strong> market data — add Alpaca keys for live scans. Prices and results are synthetic.</div>');
  else if (s.fallbacks?.count) out.push(`<div class="banner-mock">Live data failed for ${s.fallbacks.count} symbol(s) — showing MOCK prices for: ${(s.fallbacks.symbols || []).map((f) => `<code title="${esc(f.error)}">${esc(f.symbol)}</code>`).join(' ')}</div>`);
  if (s.marketOpen === false) out.push('<div class="banner-mock">US stock market is closed — stock prices are the last close and stock stops are not evaluated. Crypto trades 24/7.</div>');
  if ((s.staleSymbols || []).length) out.push(`<div class="banner-mock">Stale quotes: ${s.staleSymbols.map((x) => `<code>${esc(x)}</code>`).join(' ')}</div>`);
  if (state.status && !s.openrouterConfigured) out.push('<div class="notice">OpenRouter key missing — the run uses the rule-based fallback instead of AI.</div>');
  return out.join('');
}

function sysStripHtml() {
  const s = state.status;
  if (!s) return '';
  const w = s.worker?.status;
  return `Data: ${esc(s.dataMode || '?')} · Supabase: ${s.supabaseConfigured ? 'yes' : 'no'} · OpenRouter: ${s.openrouterConfigured ? 'yes' : '<span class="neg">MISSING</span>'}${w && w !== 'online' ? ` · Worker: <span class="neg">${esc(w)}</span>` : ''}`;
}

function picksHtml() {
  if (!state.loaded) return skeleton(5);
  const picks = state.picks?.picks || [];
  if (!picks.length) return empty('Press RUN — the scanner bot will rank the top 100 symbols');
  return `<div class="scroll-y" tabindex="0" role="region" aria-label="Scanner picks table"><table class="table cards">
    <thead><tr><th scope="col">#</th><th scope="col">SYMBOL</th><th scope="col">DIR</th><th scope="col">CONF</th><th scope="col">REASON</th></tr></thead>
    <tbody>${picks.map((p, i) => `<tr>
      <td class="dim mono" data-label="Rank">${i + 1}</td>
      <td class="sym" data-label="Symbol">${esc(p.symbol)}</td>
      <td data-label="Direction"><span class="pill pill-${esc(p.direction)}">${esc(p.direction)}</span></td>
      <td class="mono" data-label="Confidence">${(p.confidence * 100).toFixed(0)}%</td>
      <td class="reason" data-label="Reason">${esc(p.reason)}</td></tr>`).join('')}</tbody></table></div>`;
}

/* ---------- positions ---------- */

const COLS = [
  { key: 'symbol', label: 'SYMBOL', get: (p) => p.symbol },
  { key: 'side', label: 'SIDE', get: (p) => p.side },
  { key: 'allocation', label: 'ALLOC', get: (p) => p.allocation },
  { key: 'entry', label: 'ENTRY', get: (p) => p.entry },
  { key: 'stopLoss', label: 'STOP', get: (p) => p.stopLoss },
  { key: 'takeProfit', label: 'TARGET', get: (p) => p.takeProfit },
  { key: 'progress', label: 'STOP ⟷ TARGET', get: (p) => progressOf(p) },
  { key: 'pnl', label: 'P&L', get: (p) => p.pnl },
  { key: 'left', label: 'TIME LEFT', get: (p) => (p.expiresAt ? new Date(p.expiresAt).getTime() : Infinity) },
];

function progressOf(p) {
  const price = p.price ?? p.entry;
  const span = p.takeProfit - p.stopLoss;
  if (!span) return 0.5;
  return Math.min(1, Math.max(0, (price - p.stopLoss) / span));
}
function riskOf(p) {
  return Math.abs(p.entry - p.stopLoss) * (p.qty ?? p.allocation / p.entry);
}
function findPos(id) {
  const o = state.positions?.open?.find((p) => p.id === id);
  if (o) return { p: o, open: true };
  const c = state.positions?.closed?.find((p) => p.id === id);
  return c ? { p: c, open: false } : null;
}

function sortedOpen() {
  const open = [...(state.positions?.open || [])];
  const col = COLS.find((c) => c.key === state.sort.key) || COLS[7];
  const dir = state.sort.dir === 'asc' ? 1 : -1;
  return open.sort((a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    if (x === y) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
}

function openHeadHtml() {
  return `<thead><tr>${COLS.map((c) => {
    const on = state.sort.key === c.key;
    return `<th scope="col" aria-sort="${on ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-btn" data-sort="${c.key}">${c.label}<span aria-hidden="true">${on ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span></button></th>`;
  }).join('')}<th scope="col"><span class="sr-only">Actions</span></th></tr></thead>`;
}

function newOpenRow() {
  const tr = document.createElement('tr');
  tr.className = 'pos-row';
  tr.tabIndex = 0;
  tr.innerHTML = `<td class="sym" data-f="symbol" data-label="Symbol"></td>
    <td data-f="side" data-label="Side"><span class="pill"></span></td>
    <td class="mono" data-f="allocation" data-label="Allocation"></td>
    <td class="mono" data-f="entry" data-label="Entry"></td>
    <td class="mono neg" data-f="stopLoss" data-label="Stop"></td>
    <td class="mono pos" data-f="takeProfit" data-label="Target"></td>
    <td data-f="progress" data-label="Stop ⟷ Target"><div class="rbar"><span class="rentry"></span><span class="rmark"></span></div><div class="rtxt mono dim"></div></td>
    <td class="mono" data-f="pnl" data-label="P&amp;L"><span class="v"></span> <span class="dim pc"></span></td>
    <td class="mono" data-f="left" data-label="Time left"></td>
    <td data-label=""><button class="btn-close" type="button">Close</button></td>`;
  return tr;
}

function patchOpenRow(tr, p, selected) {
  const f = (k) => tr.querySelector(`[data-f="${k}"]`);
  tr.dataset.pos = p.id;
  tr.title = p.reason || '';
  tr.setAttribute('aria-label', `${p.symbol} ${p.side} position, P&L ${fmtMoney(p.pnl)}. Press Enter to show chart.`);
  if (selected) tr.setAttribute('aria-current', 'true');
  else tr.removeAttribute('aria-current');
  tr.classList.toggle('sel', selected);
  setText(f('symbol'), p.symbol);
  const pill = f('side').firstChild;
  setCls(pill, `pill pill-${p.side === 'short' ? 'short' : 'long'}`);
  setText(pill, p.side);
  setText(f('allocation'), fmtMoney(p.allocation, 0));
  setText(f('entry'), fmtMoney(p.entry));
  setText(f('stopLoss'), fmtMoney(p.stopLoss));
  setText(f('takeProfit'), fmtMoney(p.takeProfit));
  const price = p.price ?? p.entry;
  const prog = progressOf(p);
  const span = p.takeProfit - p.stopLoss || 1;
  const entryAt = Math.min(1, Math.max(0, (p.entry - p.stopLoss) / span));
  const bar = f('progress').querySelector('.rbar');
  bar.style.background = `linear-gradient(90deg, rgba(239,68,68,.35) ${entryAt * 100}%, rgba(34,197,94,.35) ${entryAt * 100}%)`;
  bar.querySelector('.rentry').style.left = `${entryAt * 100}%`;
  bar.querySelector('.rmark').style.left = `${prog * 100}%`;
  bar.setAttribute('role', 'img');
  const dStop = (Math.abs(price - p.stopLoss) / price) * 100;
  const dTgt = (Math.abs(p.takeProfit - price) / price) * 100;
  const txt = `${dStop.toFixed(1)}% to stop · ${dTgt.toFixed(1)}% to target`;
  bar.setAttribute('aria-label', `${p.symbol}: ${txt}`);
  setText(f('progress').querySelector('.rtxt'), txt);
  const v = f('pnl').querySelector('.v');
  setCls(v, clsPos(p.pnl));
  setText(v, fmtMoney(p.pnl));
  setText(f('pnl').querySelector('.pc'), fmtPct(p.pnlPct));
  const left = f('left');
  left.dataset.exp = p.expiresAt || '';
  setText(left, leftText(p.expiresAt));
  const btn = tr.querySelector('.btn-close');
  btn.dataset.close = p.id;
  btn.setAttribute('aria-label', `Close ${p.symbol} position`);
}

function leftText(exp) {
  if (!exp) return '—';
  const ms = new Date(exp).getTime() - nowMs();
  return ms <= 0 ? 'expiring' : fmtDuration(ms);
}

function patchOpenTable() {
  const wrap = $('pos-open');
  if (!wrap) return;
  const open = sortedOpen();
  if (!state.loaded) return setHtml(wrap, skeleton(4));
  if (!open.length) {
    wrap.__table = null;
    return setHtml(wrap, empty('No open positions — the trader bot opens up to 10 after each run'));
  }
  if (!wrap.__table || !wrap.contains(wrap.__table)) {
    wrap.__h = null;
    wrap.innerHTML = `<div class="scroll-y short" tabindex="0" role="region" aria-label="Open positions table"><table class="table cards" id="open-table"><tbody></tbody></table></div>`;
    wrap.__table = wrap.querySelector('table');
  }
  const table = wrap.__table;
  const headHtml = openHeadHtml();
  if (table.__head !== headHtml) {
    table.querySelector('thead')?.remove();
    table.insertAdjacentHTML('afterbegin', headHtml);
    table.__head = headHtml;
  }
  const tbody = table.querySelector('tbody');
  const active = document.activeElement;
  const activeKey = active && tbody.contains(active) ? { id: active.closest('tr')?.dataset.pos, btn: active.matches('.btn-close') } : null;
  const existing = new Map([...tbody.children].map((tr) => [tr.dataset.pos, tr]));
  open.forEach((p, i) => {
    let tr = existing.get(p.id);
    if (!tr) tr = newOpenRow();
    existing.delete(p.id);
    patchOpenRow(tr, p, p.id === state.selectedPos);
    if (tbody.children[i] !== tr) tbody.insertBefore(tr, tbody.children[i] || null);
  });
  existing.forEach((tr) => tr.remove());
  if (activeKey && document.activeElement !== active) {
    const tr = [...tbody.children].find((t) => t.dataset.pos === activeKey.id);
    (activeKey.btn ? tr?.querySelector('.btn-close') : tr)?.focus();
  }
}

function closedHtml() {
  const closed = state.positions?.closed || [];
  if (!state.loaded) return skeleton(4);
  if (!closed.length) return empty('No closed positions yet');
  return `<div class="scroll-y short" tabindex="0" role="region" aria-label="Closed positions table"><table class="table cards">
    <thead><tr><th scope="col">SYMBOL</th><th scope="col">SIDE</th><th scope="col">ENTRY</th><th scope="col">EXIT</th><th scope="col">P&amp;L</th><th scope="col">REASON</th><th scope="col">CLOSED</th></tr></thead>
    <tbody>${closed.map((p) => `<tr class="pos-row ${p.id === state.selectedPos ? 'sel' : ''}" tabindex="0" data-pos="${esc(p.id)}" ${p.id === state.selectedPos ? 'aria-current="true"' : ''} aria-label="${esc(p.symbol)} closed ${esc(p.side)} position, P&L ${esc(fmtMoney(p.pnl))}. Press Enter to show chart.">
      <td class="sym" data-label="Symbol">${esc(p.symbol)}</td>
      <td data-label="Side"><span class="pill pill-${p.side === 'short' ? 'short' : 'long'}">${esc(p.side)}</span></td>
      <td class="mono" data-label="Entry">${fmtMoney(p.entry)}</td>
      <td class="mono" data-label="Exit">${fmtMoney(p.exitPrice)}</td>
      <td class="mono ${clsPos(p.pnl)}" data-label="P&amp;L">${fmtMoney(p.pnl)}</td>
      <td data-label="Reason">${esc(EXIT_LABEL[p.exitReason] || p.exitReason || '—')}</td>
      <td class="mono dim" data-label="Closed">${esc(fmtDateTime(p.closedAt))}</td></tr>`).join('')}</tbody></table></div>`;
}

function posHeaderHtml() {
  const pos = state.positions;
  const acct = pos?.account;
  const open = pos?.open || [];
  if (!acct) return '';
  const risk = open.reduce((s, p) => s + riskOf(p), 0);
  const riskPct = acct.equity ? (risk / acct.equity) * 100 : null;
  return `equity ${fmtMoney(acct.equity, 0)} · cash ${fmtMoney(acct.cash, 0)} · P&amp;L <span class="${clsPos(acct.realizedPnl + acct.unrealizedPnl)}">${fmtMoney(acct.realizedPnl + acct.unrealizedPnl, 0)}</span> · open risk <strong title="Sum of |entry − stop| × qty over open positions — what you lose if every stop is hit">${fmtMoney(risk, 0)}${riskPct != null ? ` (${riskPct.toFixed(1)}% of equity)` : ''}</strong>`;
}

function patchPositions() {
  const nOpen = state.positions?.open?.length ?? 0;
  const nClosed = state.positions?.closed?.length ?? 0;
  setText($('tab-open'), `Open (${nOpen})`);
  setText($('tab-closed'), `Closed (${nClosed})`);
  setHtml($('pos-head'), posHeaderHtml());
  const ca = $('btn-close-all');
  if (ca) ca.hidden = !nOpen || state.posTab !== 'open';
  patchOpenTable();
  setHtml($('pos-closed'), closedHtml());
  // default selection
  if (!findPos(state.selectedPos)) state.selectedPos = state.positions?.open?.[0]?.id || state.positions?.closed?.[0]?.id || null;
  patchPosChart();
}

function applyPosTab() {
  document.querySelectorAll('[data-postab]').forEach((b) => {
    const on = b.dataset.postab === state.posTab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    b.classList.toggle('active', on);
  });
  if ($('pos-open')) $('pos-open').hidden = state.posTab !== 'open';
  if ($('pos-closed')) $('pos-closed').hidden = state.posTab !== 'closed';
  const ca = $('btn-close-all');
  if (ca) ca.hidden = state.posTab !== 'open' || !(state.positions?.open?.length);
}

/* ---------- position chart ---------- */

async function getBars(symbol, force) {
  const c = barsCache.get(symbol);
  if (c && !force && nowMs() - c.at < 60000) return c.bars;
  const data = await api(`/market/bars/${encodeURIComponent(symbol)}?limit=300`);
  const bars = data.bars || [];
  barsCache.set(symbol, { bars, at: nowMs() });
  return bars;
}

function posChartOpts(found) {
  const p = found.p;
  const long = p.side !== 'short';
  const markers = [{ t: p.openedAt, price: p.entry, label: 'ENTRY', color: '#e5e7eb', up: long }];
  if (!found.open && p.closedAt && p.exitPrice != null) markers.push({ t: p.closedAt, price: p.exitPrice, label: `EXIT${p.exitReason ? ` (${EXIT_LABEL[p.exitReason] || p.exitReason})` : ''}`, color: p.pnl >= 0 ? '#22c55e' : '#ef4444', up: !long });
  return {
    levels: [
      { price: p.takeProfit, label: 'TARGET', color: '#22c55e', dash: true },
      { price: p.entry, label: 'ENTRY', color: '#e5e7eb', dash: false },
      { price: p.stopLoss, label: 'STOP', color: '#ef4444', dash: true },
    ],
    markers,
    live: found.open ? p.price ?? null : null,
    title: `${p.symbol} ${p.side}`,
  };
}

let chartKey = '';
async function patchPosChart() {
  const canvas = $('pos-chart');
  const found = findPos(state.selectedPos);
  const head = $('pos-chart-head');
  const box = $('pos-chart-box');
  if (!canvas) return;
  if (box) box.hidden = !found;
  if (!found) return setHtml(head, '');
  const p = found.p;
  setHtml(head, `<strong>${esc(p.symbol)}</strong> · ${esc(p.side.toUpperCase())}${found.open ? '' : ' · closed'} — <span class="dim">${esc(p.reason || '')}</span>`);
  if (!charts.pos) charts.pos = new CandleChart(canvas, { summaryEl: $('pos-chart-sum') });
  const key = `${p.id}|${state.tf}`;
  const opts = posChartOpts(found);
  const cached = barsCache.get(p.symbol);
  if (chartKey === key && cached) {
    charts.pos.set({ levels: opts.levels, markers: opts.markers, live: opts.live, title: opts.title });
    if (nowMs() - cached.at > 60000 && found.open) refetchPosBars(p, key);
    return;
  }
  chartKey = key;
  try {
    const bars = await getBars(p.symbol);
    if (chartKey !== key || !charts.pos) return;
    charts.pos.set({ bars: aggregateBars(bars, state.tf), indicators: { ema9: true, ema21: true }, ...opts });
  } catch (e) {
    chartKey = '';
    charts.pos?.set({ bars: [], title: '' });
    setText($('pos-chart-sum'), `Chart unavailable: ${e.message}`);
  }
}
async function refetchPosBars(p, key) {
  try {
    const bars = await getBars(p.symbol, true);
    if (chartKey === key && charts.pos) charts.pos.set({ bars: aggregateBars(bars, state.tf) });
  } catch {
    /* keep old */
  }
}

function tfButtonsHtml(id) {
  return `<div class="range-tabs" role="group" aria-label="Timeframe" id="${id}">${['1H', '4H', '1D'].map((t) => `<button type="button" data-tf="${t}" aria-pressed="${state.tf === t}" class="${state.tf === t ? 'active' : ''}">${t}</button>`).join('')}</div>`;
}

/* ---------- performance ---------- */

function perfShellHtml() {
  return `<div class="perf-layout">
    <div class="perf-main">
      <div id="perf-stats" class="perf-cards"></div>
      <div class="perf-chart-title">EQUITY CURVE</div>
      <div class="chart-area perf-chart"><canvas id="equity-chart"></canvas></div>
      <p class="sr-only" id="equity-sum"></p>
    </div>
    <div class="perf-side">
      <div class="perf-chart-title">CONFIDENCE CALIBRATION <span class="dim">— does 70% confidence win ~70%?</span></div>
      <div id="perf-calib"></div>
      <div class="perf-chart-title" style="margin-top:14px">AI vs RULE-BASED</div>
      <div id="perf-bots"></div>
    </div>
  </div>`;
}

function statCard(label, value, cls = '', sub = '') {
  return `<div class="stat"><span class="lbl">${label}</span><strong class="${cls}">${value}</strong>${sub ? `<small class="dim">${sub}</small>` : ''}</div>`;
}

function patchPerf() {
  const stats = $('perf-stats');
  if (!stats) return;
  const p = state.perf;
  if (!state.loaded) {
    setHtml(stats, skeleton(2));
    return;
  }
  if (!p) {
    setHtml(stats, '<div class="empty">Performance data isn’t available yet (the server has no /api/performance data, or there are no closed trades).</div>');
    charts.equity?.set([]);
    setHtml($('perf-calib'), '');
    setHtml($('perf-bots'), '');
    return;
  }
  const wr = pctOf(p.winRate);
  const dd = p.maxDrawdownPct;
  setHtml(
    stats,
    [
      statCard('WIN RATE', wr == null ? '—' : `${wr.toFixed(0)}%`, '', `${p.wins ?? 0} / ${p.closed ?? 0} closed`),
      statCard('AVG R', p.avgR != null ? `${Number(p.avgR).toFixed(2)}R` : '—', clsPos(p.avgR), 'per closed trade'),
      statCard('MAX DRAWDOWN', dd != null ? `${Math.abs(dd).toFixed(2)}%` : '—', dd ? 'neg' : ''),
      statCard('REALIZED P&amp;L', fmtMoney(p.realizedPnl, 0), clsPos(p.realizedPnl)),
    ].join('') + ((p.closed ?? 0) < 20 ? '<div class="warn-note wide">Only ' + (p.closed ?? 0) + ' closed trade(s) — treat these numbers as anecdotal until there are 20+.</div>' : ''),
  );
  if (!charts.equity) charts.equity = new LineChart($('equity-chart'), { summaryEl: $('equity-sum'), format: (v) => fmtMoney(v, 0), title: 'Equity curve' });
  charts.equity.set((p.equityCurve || []).map((e) => ({ t: e.t, v: e.equity })));

  const cal = p.calibration || [];
  setHtml(
    $('perf-calib'),
    cal.length
      ? `<ul class="calib">${cal
          .map((c) => {
            const m = String(c.bucket).match(/(\d+)\D+(\d+)/);
            const mid = m ? (Number(m[1]) + Number(m[2])) / 2 : null;
            const hr = pctOf(c.hitRate) ?? 0;
            return `<li><span class="calib-l mono">${esc(c.bucket)}</span><span class="calib-bar" role="img" aria-label="${esc(c.bucket)} confidence: hit rate ${hr.toFixed(0)}% over ${c.n} picks"><span class="calib-fill" style="width:${Math.min(100, hr)}%"></span>${mid != null ? `<span class="calib-ideal" style="left:${mid}%" title="Perfect calibration"></span>` : ''}</span><span class="calib-v mono">${hr.toFixed(0)}% <span class="dim">n=${c.n}</span></span></li>`;
          })
          .join('')}</ul><div class="dim calib-note">Bar = actual hit rate; tick = stated confidence. Bars left of the tick mean the model is overconfident.</div>`
      : empty('Not enough scored picks yet'),
  );
  const b = p.byBot;
  const row = (name, x) => `<tr><th scope="row">${name}</th><td class="mono" data-label="Closed">${x?.closed ?? 0}</td><td class="mono" data-label="Win rate">${x?.winRate != null ? `${pctOf(x.winRate).toFixed(0)}%` : '—'}</td><td class="mono ${clsPos(x?.pnl)}" data-label="P&amp;L">${fmtMoney(x?.pnl, 0)}</td></tr>`;
  setHtml($('perf-bots'), b ? `<table class="table"><thead><tr><th scope="col">BOT</th><th scope="col">CLOSED</th><th scope="col">WIN</th><th scope="col">P&amp;L</th></tr></thead><tbody>${row('AI', b.ai)}${row('Rules', b.rules)}</tbody></table>` : empty('No breakdown available'));
}

/* ---------- pages ---------- */

function mountDashboard() {
  root.innerHTML = `<div class="page">
    <div id="banners"></div>
    <div class="page-toolbar">
      <span class="dim" id="upd" aria-live="off"></span>
      <div class="toolbar-actions"><button class="btn-accent" id="btn-scan" type="button">RUN</button></div>
    </div>
    <div id="run-bar" role="status" aria-live="polite"></div>
    <div class="grid grid-top">
      <section class="widget ai-summary" aria-labelledby="h-sum"><h2 class="widget-title" id="h-sum">AI SUMMARY</h2><div id="w-summary"></div></section>
      <section class="widget allocation-box" aria-labelledby="h-alloc"><h2 class="widget-title" id="h-alloc">ALLOCATION</h2><div id="w-alloc"></div></section>
      <section class="widget model-acc" aria-labelledby="h-acc"><h2 class="widget-title" id="h-acc">MODEL ACCURACY</h2><div id="w-acc"></div></section>
    </div>
    <div class="run-status dim" id="sys-strip"></div>
    <div class="grid grid-ai">
      <section class="widget ai-picks" aria-labelledby="h-picks">
        <h2 class="widget-title" id="h-picks"><span id="picks-title">SCANNER TOP PICKS</span><span class="dim" id="picks-badge"></span></h2>
        <div id="w-picks"></div>
      </section>
      <section class="widget ai-positions" aria-labelledby="h-pos">
        <h2 class="widget-title" id="h-pos"><span>POSITIONS (SIMULATED)</span></h2>
        <div class="pos-toolbar">
          <div class="tabs" role="tablist" aria-label="Positions">
            <button class="tab active" role="tab" id="tab-open" data-postab="open" aria-controls="pos-open" aria-selected="true" type="button">Open</button>
            <button class="tab" role="tab" id="tab-closed" data-postab="closed" aria-controls="pos-closed" aria-selected="false" tabindex="-1" type="button">Closed</button>
          </div>
          <button class="btn-close btn-danger" id="btn-close-all" type="button" hidden>Close all</button>
        </div>
        <div class="dim pos-head" id="pos-head"></div>
        <div id="pos-open" role="tabpanel" aria-labelledby="tab-open"></div>
        <div id="pos-closed" role="tabpanel" aria-labelledby="tab-closed" hidden></div>
        <div id="pos-chart-box" hidden>
          <div class="pos-chart-head"><span id="pos-chart-head"></span>${tfButtonsHtml('tf-pos')}</div>
          <div class="chart-box"><canvas id="pos-chart"></canvas></div>
          <p class="sr-only" id="pos-chart-sum"></p>
        </div>
      </section>
    </div>
    <section class="widget perf-section" aria-labelledby="h-perf"><h2 class="widget-title" id="h-perf"><span>PERFORMANCE</span><a class="dim" href="#performance">Details &amp; run history →</a></h2>${perfShellHtml()}</section>
  </div>`;
  $('btn-scan').addEventListener('click', startRun);
  const pw = $('pos-open').parentElement;
  pw.addEventListener('click', posClick);
  pw.addEventListener('keydown', posKey);
  document.querySelector('.tabs[role=tablist]').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    state.posTab = state.posTab === 'open' ? 'closed' : 'open';
    applyPosTab();
    $(`tab-${state.posTab}`).focus();
  });
  $('tf-pos').addEventListener('click', tfClick);
  patchDashboard();
}

function tfClick(e) {
  const b = e.target.closest('[data-tf]');
  if (!b) return;
  state.tf = b.dataset.tf;
  document.querySelectorAll('[data-tf]').forEach((x) => {
    x.setAttribute('aria-pressed', String(x.dataset.tf === state.tf));
    x.classList.toggle('active', x.dataset.tf === state.tf);
  });
  if (state.page === 'market') drawMarketChart();
  else patchPosChart();
}

function selectPos(id) {
  state.selectedPos = id;
  document.querySelectorAll('.pos-row').forEach((r) => {
    const on = r.dataset.pos === id;
    r.classList.toggle('sel', on);
    if (on) r.setAttribute('aria-current', 'true');
    else r.removeAttribute('aria-current');
  });
  patchPosChart();
}

async function closePosition(id) {
  const f = findPos(id);
  const ok = await confirmDialog({ title: 'Close position?', message: `Close the simulated ${f?.p.symbol || ''} position at the current price?`, confirmText: 'Close position', danger: true });
  if (!ok) return;
  try {
    const r = await api(`/positions/${encodeURIComponent(id)}/close`, { method: 'POST' });
    toast(`Closed ${r.symbol || 'position'}${r.pnl != null ? ` — P&L ${fmtMoney(r.pnl)}` : ''}`, r.pnl > 0 ? 'success' : 'info');
    await refresh();
    patchCurrent();
  } catch (e) {
    toast(`Close failed: ${e.message}`, 'error');
  }
}

async function closeAll() {
  const n = state.positions?.open?.length || 0;
  if (!n) return;
  const ok = await confirmDialog({ title: `Close all ${n} positions?`, message: 'Every open simulated position will be closed at its current price.', confirmText: 'Close all', danger: true });
  if (!ok) return;
  try {
    let closed;
    try {
      closed = (await api('/positions/close-all', { method: 'POST' })).closed;
    } catch (e) {
      if (e.status !== 404) throw e;
      closed = 0; // endpoint missing: close one by one
      for (const p of state.positions.open) {
        await api(`/positions/${encodeURIComponent(p.id)}/close`, { method: 'POST' });
        closed++;
      }
    }
    toast(`Closed ${closed} position${closed === 1 ? '' : 's'}`, 'success');
    await refresh();
    patchCurrent();
  } catch (e) {
    toast(`Close all failed: ${e.message}`, 'error');
  }
}

function posClick(e) {
  const sortBtn = e.target.closest('[data-sort]');
  if (sortBtn) {
    const key = sortBtn.dataset.sort;
    state.sort = state.sort.key === key ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'symbol' || key === 'side' ? 'asc' : 'desc' };
    patchOpenTable();
    document.querySelector(`[data-sort="${key}"]`)?.focus();
    return;
  }
  const tab = e.target.closest('[data-postab]');
  if (tab) {
    state.posTab = tab.dataset.postab;
    applyPosTab();
    return;
  }
  if (e.target.closest('#btn-close-all')) return closeAll();
  const cb = e.target.closest('[data-close]');
  if (cb) return closePosition(cb.dataset.close);
  const row = e.target.closest('tr[data-pos]');
  if (row) selectPos(row.dataset.pos);
}
function posKey(e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-pos]')) {
    e.preventDefault();
    selectPos(e.target.dataset.pos);
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.matches('tr[data-pos]')) {
    e.preventDefault();
    (e.key === 'ArrowDown' ? e.target.nextElementSibling : e.target.previousElementSibling)?.focus();
  }
}

function patchDashboard() {
  if (!$('w-summary')) return;
  setHtml($('banners'), bannersHtml());
  setHtml($('w-summary'), summaryHtml());
  setHtml($('w-alloc'), allocationHtml());
  setHtml($('w-acc'), accuracyHtml());
  setHtml($('sys-strip'), sysStripHtml());
  const st = state.picks;
  setText($('picks-title'), `SCANNER TOP ${st?.picks?.length || 100} PICKS`);
  setText($('picks-badge'), st?.source === 'ai' ? `AI · ${st.model || ''}` : st?.picks?.length ? 'RULE-BASED (no OpenRouter key)' : '');
  setHtml($('w-picks'), picksHtml());
  patchPositions();
  applyPosTab();
  patchPerf();
  patchRunBar();
  patchUpdated();
}

function patchUpdated() {
  const u = $('upd');
  if (!u) return;
  if (state.loadError) {
    setCls(u, 'neg');
    setText(u, 'Update failed — retrying');
  } else {
    setCls(u, 'dim');
    setText(u, state.lastUpdate ? `Updated ${fmtTime(state.lastUpdate)}` : '');
  }
}

/* performance page */
function mountPerformance() {
  root.innerHTML = `<div class="page">
    <div id="banners"></div>
    <section class="widget perf-section" aria-labelledby="h-perf"><h2 class="widget-title" id="h-perf">PERFORMANCE</h2>${perfShellHtml()}</section>
    <section class="widget" style="margin-top:12px" aria-labelledby="h-runs"><h2 class="widget-title" id="h-runs">RUN HISTORY</h2><div id="runs"></div></section>
  </div>`;
  patchPerformancePage();
  loadRuns();
}
function patchPerformancePage() {
  setHtml($('banners'), bannersHtml());
  patchPerf();
  runsPatch();
}
async function loadRuns() {
  const r = await apiOptional('/runs?limit=20');
  state.runs = r?.runs || (r === null ? null : []);
  runsPatch();
}
function runsPatch() {
  const el = $('runs');
  if (!el) return;
  const runs = state.runs;
  if (runs === null) return setHtml(el, state.loaded ? empty('Run history isn’t available from the server yet.') : skeleton(3));
  if (!runs.length) return setHtml(el, empty('No runs recorded yet — press RUN on the dashboard.'));
  setHtml(
    el,
    `<div class="scroll-y" tabindex="0" role="region" aria-label="Run history table"><table class="table cards"><thead><tr><th scope="col">WHEN</th><th scope="col">TRADER</th><th scope="col">PICKS</th><th scope="col">TRADES</th><th scope="col">NOTE</th></tr></thead><tbody>${runs
      .map((r) => `<tr><td class="mono" data-label="When">${esc(fmtDateTime(r.at))}</td><td data-label="Trader">${esc(r.traderSource === 'ai' ? `AI ${r.traderModel || ''}` : 'Rules')}</td><td class="mono" data-label="Picks">${esc(r.picks ?? '—')}</td><td class="mono" data-label="Trades">${r.trades?.length ?? 0}${(r.trades || []).length ? ` <span class="dim">(${(r.trades || []).slice(0, 4).map((t) => esc(t.symbol)).join(', ')}${r.trades.length > 4 ? '…' : ''})</span>` : ''}</td><td class="reason" data-label="Note">${esc(r.note || '')}</td></tr>`)
      .join('')}</tbody></table></div>`,
  );
}

/* market page */
function mountMarket() {
  root.innerHTML = `<div class="page">
    <div id="banners"></div>
    <div class="grid grid-market">
      <section class="widget chart-custom" aria-labelledby="h-chart">
        <h2 class="widget-title" id="h-chart"><span id="chart-sym">${esc(state.symbol)}</span>${tfButtonsHtml('tf-market')}</h2>
        <div class="chart-toolbar" role="group" aria-label="Indicators">${['VOL', 'VWAP', 'EMA9', 'EMA21'].map((id) => `<button class="ind-toggle ${state.indicators[id.toLowerCase()] ? 'active' : ''}" data-ind="${id.toLowerCase()}" aria-pressed="${!!state.indicators[id.toLowerCase()]}" type="button">${id}</button>`).join('')}</div>
        <div class="chart-box tall"><canvas id="mini-chart"></canvas></div>
        <p class="sr-only" id="mini-chart-sum"></p>
      </section>
      <section class="widget watchlist" aria-labelledby="h-watch"><h2 class="widget-title" id="h-watch">WATCHLIST</h2><div id="watch-body">${skeleton(4)}</div></section>
      <section class="widget tv" id="tv-widget" hidden><div id="tv-container" class="tv-frame"></div></section>
    </div>
  </div>`;
  $('tf-market').addEventListener('click', tfClick);
  root.querySelector('.chart-toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ind]');
    if (!b) return;
    const k = b.dataset.ind;
    state.indicators[k] = !state.indicators[k];
    b.classList.toggle('active', state.indicators[k]);
    b.setAttribute('aria-pressed', String(state.indicators[k]));
    charts.mkt?.set({ indicators: { ...state.indicators } });
  });
  $('watch-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    state.symbol = b.dataset.pick;
    setText($('chart-sym'), state.symbol);
    drawMarketChart();
    mountTradingView(state.symbol);
    patchWatch();
  });
  charts.mkt = new CandleChart($('mini-chart'), { summaryEl: $('mini-chart-sum') });
  drawMarketChart();
  loadQuotes();
  mountTradingView(state.symbol);
}

async function drawMarketChart() {
  const sym = state.symbol;
  try {
    const bars = await getBars(sym);
    if (state.symbol !== sym || !charts.mkt) return;
    charts.mkt.set({ bars: aggregateBars(bars, state.tf), indicators: { ...state.indicators }, levels: [], markers: [], live: null, title: sym });
  } catch (e) {
    charts.mkt?.set({ bars: [], title: '' });
    setText($('mini-chart-sum'), `Chart unavailable: ${e.message}`);
  }
}

async function loadQuotes() {
  const syms = ['SPY', 'QQQ', 'IWM', ...(state.picks?.picks || []).slice(0, 6).map((p) => p.symbol)];
  const r = await apiOptional(`/market/quotes?symbols=${encodeURIComponent([...new Set(syms)].join(','))}`);
  state.quotes = r?.quotes || state.quotes;
  patchWatch();
}
function patchWatch() {
  const el = $('watch-body');
  if (!el) return;
  const picks = new Map((state.picks?.picks || []).map((p) => [p.symbol, p]));
  setHtml(
    el,
    state.quotes.length
      ? state.quotes
          .map((q) => {
            const pk = picks.get(q.symbol);
            return `<button type="button" class="watch-row" data-pick="${esc(q.symbol)}" aria-pressed="${q.symbol === state.symbol}" ${q.symbol === state.symbol ? 'aria-current="true"' : ''}>
        <span><span class="sym">${esc(q.symbol)}</span>${pk ? `<span class="dim watch-sub"><span class="pill pill-${esc(pk.direction)}">${esc(pk.direction)}</span> ${(pk.confidence * 100).toFixed(0)}%</span>` : ''}</span>
        <span class="watch-px"><span class="mono">${fmtMoney(q.price)}</span><span class="mono ${clsPos(q.changePct)}">${fmtPct(q.changePct)}</span></span></button>`;
          })
          .join('')
      : empty('No quotes available'),
  );
}

function toTvSymbol(symbol) {
  if (symbol.includes('/')) {
    const [base, quote] = symbol.split('/');
    return `BINANCE:${base}${quote === 'USD' ? 'USDT' : quote}`;
  }
  return symbol;
}
function mountTradingView(symbol) {
  const container = $('tv-container');
  if (!container || typeof TradingView === 'undefined') return;
  $('tv-widget').hidden = false;
  container.innerHTML = '';
  // eslint-disable-next-line no-new
  new TradingView.widget({ container_id: 'tv-container', symbol: toTvSymbol(symbol), interval: '60', timezone: 'Etc/UTC', theme: 'dark', style: '1', locale: 'en', toolbar_bg: '#15171d', enable_publishing: false, save_image: false, width: '100%', height: '100%' });
}

/* logs page */
function logsHtml() {
  const src = state.logs || state.dashboard?.logs;
  if (!src) return state.loaded ? empty('No logs') : skeleton(6);
  const rows = src.filter((l) => state.logFilter === 'all' || (state.logFilter === 'warn' ? l.level === 'warn' || l.level === 'error' : l.level === 'error'));
  return rows.length
    ? rows.map((l) => `<div class="log-row ${esc(l.level)}"><span class="ts">${esc(fmtTime(l.ts))}</span><span class="msg"><span class="lvl">${esc(l.level)}</span> ${esc(l.message)}</span></div>`).join('')
    : empty('No matching log entries');
}
async function loadLogs() {
  const r = await apiOptional('/logs?limit=200');
  if (r?.logs) state.logs = r.logs;
  setHtml($('log-list'), logsHtml());
}
function mountLogs() {
  root.innerHTML = `<div class="page"><section class="widget" style="min-height:70vh" aria-labelledby="h-logs">
    <h2 class="widget-title" id="h-logs"><span>LOGS</span><span class="range-tabs" role="group" aria-label="Filter log level">${[['all', 'All'], ['warn', 'Warnings+'], ['error', 'Errors']].map(([k, l]) => `<button type="button" data-lf="${k}" aria-pressed="${state.logFilter === k}" class="${state.logFilter === k ? 'active' : ''}">${l}</button>`).join('')}</span></h2>
    <div class="log-list scroll-y" id="log-list" tabindex="0" role="log" aria-label="Server log"></div></section></div>`;
  $('log-list').closest('section').querySelector('.range-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lf]');
    if (!b) return;
    state.logFilter = b.dataset.lf;
    e.currentTarget.querySelectorAll('button').forEach((x) => {
      x.setAttribute('aria-pressed', String(x === b));
      x.classList.toggle('active', x === b);
    });
    setHtml($('log-list'), logsHtml());
  });
  setHtml($('log-list'), logsHtml());
  loadLogs();
}

/* settings page */
function mountSettings() {
  const s = state.status?.settings || {};
  const st = state.status || {};
  root.innerHTML = `<div class="page">
    <div class="notice">Trading is permanently disabled in this build. Alpaca is used for market data only; all positions are simulated.</div>
    <div class="settings-grid">
    <section class="widget" aria-labelledby="h-set"><h2 class="widget-title" id="h-set">SETTINGS</h2>
      <form class="settings-form" id="settings-form">
        <label for="s-hz">Position / prediction horizon (hours)<input id="s-hz" name="horizonHours" type="number" min="1" max="168" value="${esc(s.horizonHours ?? 24)}" /></label>
        <label for="s-wl">Watchlist size (legacy scanner)<input id="s-wl" name="watchlistSize" type="number" min="3" max="40" value="${esc(s.watchlistSize ?? 12)}" /></label>
        <label for="s-as">Auto scan (legacy scanner)<select id="s-as" name="autoScan"><option value="true" ${s.autoScan !== false ? 'selected' : ''}>On</option><option value="false" ${s.autoScan === false ? 'selected' : ''}>Off</option></select></label>
        <button class="btn-accent" type="submit">Save</button>
      </form></section>
    <section class="widget" aria-labelledby="h-sys"><h2 class="widget-title" id="h-sys">SYSTEM</h2>
      <dl class="kv">
        <dt>Data mode</dt><dd>${esc(st.dataMode || 'unknown')}</dd>
        <dt>Market</dt><dd>${st.marketOpen == null ? 'unknown' : st.marketOpen ? 'US stocks open' : 'US stocks closed'}</dd>
        <dt>Alpaca keys</dt><dd>${st.alpacaConfigured ? 'configured' : 'missing (mock data)'}</dd>
        <dt>OpenRouter key</dt><dd>${st.openrouterConfigured ? 'configured' : '<span class="neg">missing (rule-based fallback)</span>'}</dd>
        <dt>Supabase</dt><dd>${st.supabaseConfigured ? 'connected' : 'not configured (data resets on restart)'}</dd>
        <dt>Admin auth</dt><dd>${state.auth.required ? (getToken() ? 'required — token saved in this browser' : 'required — not signed in') : 'not required'}</dd>
      </dl>
      ${state.auth.required ? `<button class="btn-ghost" id="btn-auth2" type="button">${getToken() ? 'Sign out' : 'Sign in'}</button>` : ''}
    </section></div></div>`;
  $('btn-auth2')?.addEventListener('click', authClick);
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/settings', { method: 'PATCH', body: JSON.stringify({ watchlistSize: Number(fd.get('watchlistSize')), horizonHours: Number(fd.get('horizonHours')), autoScan: fd.get('autoScan') === 'true' }) });
      toast('Settings saved', 'success');
      await refresh();
    } catch (err) {
      toast(`Could not save settings: ${err.message}`, 'error');
    }
  });
}

/* ---------- routing ---------- */

function patchCurrent() {
  patchUpdated();
  setWorkerUI(state.status?.worker);
  switch (state.page) {
    case 'dashboard':
      patchDashboard();
      break;
    case 'performance':
      patchPerformancePage();
      loadRuns();
      break;
    case 'market':
      setHtml($('banners'), bannersHtml());
      loadQuotes();
      break;
    case 'logs':
      loadLogs();
      break;
    default:
  }
}

function render() {
  destroyCharts();
  chartKey = '';
  navActive(state.page);
  document.title = `${TITLES[state.page]} · tradingbot`;
  switch (state.page) {
    case 'performance':
      mountPerformance();
      break;
    case 'market':
      mountMarket();
      break;
    case 'logs':
      mountLogs();
      break;
    case 'settings':
      mountSettings();
      break;
    default:
      mountDashboard();
  }
}

function routeFromHash() {
  let page = (window.location.hash || '#dashboard').replace('#', '') || 'dashboard';
  if (!PAGES.includes(page)) page = 'dashboard'; // retired pages (ai-desk, decisions, chat…) fold into the dashboard
  return page;
}

async function authClick() {
  if (getToken()) {
    setToken('');
    toast('Signed out — the admin token was removed from this browser', 'info');
  } else {
    const t = await tokenDialog();
    if (t) {
      setToken(t);
      toast('Admin token saved', 'success');
    }
  }
  updateAuthUI();
  if (state.page === 'settings') mountSettings();
}

function bindChrome() {
  window.addEventListener('hashchange', () => {
    state.page = routeFromHash();
    render();
    $('view-root').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });
  $('btn-stop').addEventListener('click', async () => {
    try {
      await api('/worker/stop', { method: 'POST' });
      toast('Worker stopped', 'info');
      await refresh();
      patchCurrent();
    } catch (e) {
      toast(`Stop failed: ${e.message}`, 'error');
    }
  });
  $('btn-kill').addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Kill the worker?', message: 'This halts all scan and monitoring cycles until the worker is restarted.', confirmText: 'Kill worker', danger: true }))) return;
    try {
      await api('/worker/kill', { method: 'POST' });
      toast('Worker killed — all cycles halted', 'warn');
      await refresh();
      patchCurrent();
    } catch (e) {
      toast(`Kill failed: ${e.message}`, 'error');
    }
  });
  $('btn-auth').addEventListener('click', authClick);
}

let pollTimer = null;
async function poll() {
  if (document.hidden) return;
  try {
    await refresh();
  } catch {
    /* state.loadError is set */
  }
  patchCurrent();
}

async function boot() {
  bindChrome();
  state.page = routeFromHash();
  render();
  const auth = await apiOptional('/auth/status');
  state.auth.required = !!auth?.required;
  updateAuthUI();
  try {
    await refresh();
  } catch {
    state.loaded = true; // stop skeletons; banner explains
  }
  patchCurrent();
  if (state.page === 'settings') mountSettings();
  pollTimer = setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });
  // 1s ticker: countdowns + run timer (paused when hidden)
  setInterval(() => {
    if (document.hidden) return;
    document.querySelectorAll('[data-exp]').forEach((el) => {
      if (el.dataset.exp) setText(el, leftText(el.dataset.exp));
    });
    if (isRunning()) tickRun();
  }, 1000);
}

boot();
