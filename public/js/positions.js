import { api, clsPos, escapeHtml as esc, fmtDateTime, fmtDuration, fmtMoney, fmtPct } from './api.js';
import { CandleChart, aggregateBars } from './charts.js';
import { refresh } from './data.js';
import { drawMarketChart } from './market.js';
import { hooks, $, EXIT_LABEL, barsCache, charts, empty, nowMs, setCls, setHtml, setText, skeleton, state } from './state.js';
import { confirmDialog, toast } from './ui.js';

/* ---------- positions ---------- */

export const COLS = [
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

export function progressOf(p) {
  const price = p.price ?? p.entry;
  const span = p.takeProfit - p.stopLoss;
  if (!span) return 0.5;
  return Math.min(1, Math.max(0, (price - p.stopLoss) / span));
}
export function riskOf(p) {
  return Math.abs(p.entry - p.stopLoss) * (p.qty ?? p.allocation / p.entry);
}
export function findPos(id) {
  const o = state.positions?.open?.find((p) => p.id === id);
  if (o) return { p: o, open: true };
  const c = state.positions?.closed?.find((p) => p.id === id);
  return c ? { p: c, open: false } : null;
}

export function sortedOpen() {
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

export function openHeadHtml() {
  return `<thead><tr>${COLS.map((c) => {
    const on = state.sort.key === c.key;
    return `<th scope="col" aria-sort="${on ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-btn" data-sort="${c.key}">${c.label}<span aria-hidden="true">${on ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span></button></th>`;
  }).join('')}<th scope="col"><span class="sr-only">Actions</span></th></tr></thead>`;
}

export function newOpenRow() {
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

export function patchOpenRow(tr, p, selected) {
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
  const expired = !!(p.expired || p.expiredAt);
  left.dataset.exp = expired ? '' : p.expiresAt || '';
  setText(left, expired ? 'expired' : leftText(p.expiresAt));
  tr.classList.toggle('expired', expired);
  const btn = tr.querySelector('.btn-close');
  btn.dataset.close = p.id;
  btn.setAttribute('aria-label', `Close ${p.symbol} position`);
}

export function leftText(exp) {
  if (!exp) return '—';
  const ms = new Date(exp).getTime() - nowMs();
  return ms <= 0 ? 'expiring' : fmtDuration(ms);
}

export function patchOpenTable() {
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

export function closedHtml() {
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
      <td data-label="Reason">${esc(EXIT_LABEL[p.exitReason] || p.exitReason || (p.expired || p.expiredAt ? 'Expired' : '—'))}</td>
      <td class="mono dim" data-label="Closed">${esc(fmtDateTime(p.closedAt))}</td></tr>`).join('')}</tbody></table></div>`;
}

export function posHeaderHtml() {
  const pos = state.positions;
  const acct = pos?.account;
  const open = pos?.open || [];
  if (!acct) return '';
  const risk = open.reduce((s, p) => s + riskOf(p), 0);
  const riskPct = acct.equity ? (risk / acct.equity) * 100 : null;
  return `equity ${fmtMoney(acct.equity, 0)} · cash ${fmtMoney(acct.cash, 0)} · P&amp;L <span class="${clsPos(acct.realizedPnl + acct.unrealizedPnl)}">${fmtMoney(acct.realizedPnl + acct.unrealizedPnl, 0)}</span> · open risk <strong title="Sum of |entry − stop| × qty over open positions — what you lose if every stop is hit">${fmtMoney(risk, 0)}${riskPct != null ? ` (${riskPct.toFixed(1)}% of equity)` : ''}</strong>`;
}

export function patchPositions() {
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

export function applyPosTab() {
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

export async function getBars(symbol, force) {
  const c = barsCache.get(symbol);
  if (c && !force && nowMs() - c.at < 60000) return c.bars;
  const data = await api(`/market/bars/${encodeURIComponent(symbol)}?limit=300`);
  const bars = data.bars || [];
  barsCache.set(symbol, { bars, at: nowMs() });
  return bars;
}

export function posChartOpts(found) {
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
export function resetChartKey() {
  chartKey = '';
}
export async function patchPosChart() {
  const canvas = $('pos-chart');
  const found = findPos(state.selectedPos);
  const head = $('pos-chart-head');
  const box = $('pos-chart-box');
  if (!canvas) return;
  if (box) box.hidden = !found;
  if (!found) return setHtml(head, '');
  const p = found.p;
  setHtml(head, `<strong>${esc(p.symbol)}</strong> · ${esc(p.side.toUpperCase())}${found.open ? '' : ' · closed'} — <span class="dim">${esc(p.reason || '')}</span>`);
  if (!charts.pos) charts.pos = new CandleChart(canvas, { summaryEl: $('pos-chart-sum'), tableEl: $('pos-chart-table'), tableBars: 20 });
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
export async function refetchPosBars(p, key) {
  try {
    const bars = await getBars(p.symbol, true);
    if (chartKey === key && charts.pos) charts.pos.set({ bars: aggregateBars(bars, state.tf) });
  } catch {
    /* keep old */
  }
}

export function tfButtonsHtml(id) {
  return `<div class="range-tabs" role="group" aria-label="Timeframe" id="${id}">${['1H', '4H', '1D'].map((t) => `<button type="button" data-tf="${t}" aria-pressed="${state.tf === t}" class="${state.tf === t ? 'active' : ''}">${t}</button>`).join('')}</div>`;
}

export function tfClick(e) {
  const b = e.target.closest('[data-tf]');
  if (!b) return;
  state.tf = b.dataset.tf;
  savePrefs();
  document.querySelectorAll('[data-tf]').forEach((x) => {
    x.setAttribute('aria-pressed', String(x.dataset.tf === state.tf));
    x.classList.toggle('active', x.dataset.tf === state.tf);
  });
  if (state.page === 'market') drawMarketChart();
  else patchPosChart();
}

export function selectPos(id) {
  state.selectedPos = id;
  document.querySelectorAll('.pos-row').forEach((r) => {
    const on = r.dataset.pos === id;
    r.classList.toggle('sel', on);
    if (on) r.setAttribute('aria-current', 'true');
    else r.removeAttribute('aria-current');
  });
  patchPosChart();
}

/** Human-readable reason for a failed close (409 stale quote, 502 no quote, else the server message). */
function closeFailMessage(e, symbol) {
  const who = symbol ? ` ${symbol}` : '';
  if (e.status === 502) return `No live quote available for${who || ' this symbol'} — can’t price the close right now. Try again shortly.`;
  if (e.status === 409 && e.stale) return `The quote for${who || ' this symbol'} is stale.`;
  return `Close failed: ${e.message}`;
}

/** POST a close; on a stale-quote 409 offer "Close anyway", which retries with ?force=1. Returns the response or null if not closed. */
async function closeWithStaleGuard(path, symbol) {
  try {
    return await api(path, { method: 'POST' });
  } catch (e) {
    if (e.status === 409 && e.stale) {
      const force = await confirmDialog({
        title: 'Stale quote',
        message: `${e.message || `The latest quote for ${symbol || 'this position'} is stale.`} Closing now would use an out-of-date price. Close anyway?`,
        confirmText: 'Close anyway',
        danger: true,
      });
      if (!force) {
        toast(`Close cancelled — stale quote for ${symbol || 'position'}.`, 'warn');
        return null;
      }
      return api(`${path}${path.includes('?') ? '&' : '?'}force=1`, { method: 'POST' });
    }
    throw e;
  }
}

export async function closePosition(id) {
  const f = findPos(id);
  const sym = f?.p.symbol || '';
  const ok = await confirmDialog({ title: 'Close position?', message: `Close the simulated ${sym} position at the current price?`, confirmText: 'Close position', danger: true });
  if (!ok) return;
  try {
    const r = await closeWithStaleGuard(`/positions/${encodeURIComponent(id)}/close`, sym);
    if (!r) return;
    toast(`Closed ${r.symbol || sym || 'position'}${r.pnl != null ? ` — P&L ${fmtMoney(r.pnl)}` : ''}`, r.pnl > 0 ? 'success' : 'info');
    await refresh();
    hooks.patchCurrent();
  } catch (e) {
    toast(closeFailMessage(e, sym), 'error');
  }
}

export async function closeAll() {
  const n = state.positions?.open?.length || 0;
  if (!n) return;
  const ok = await confirmDialog({ title: `Close all ${n} positions?`, message: 'Every open simulated position will be closed at its current price.', confirmText: 'Close all', danger: true });
  if (!ok) return;
  try {
    let closed;
    let failed = 0;
    try {
      const r = await closeWithStaleGuard('/positions/close-all', '');
      if (!r) return;
      closed = r.closed;
    } catch (e) {
      if (e.status !== 404) throw e;
      closed = 0; // endpoint missing: close one by one (a stale/no-quote position is skipped, not fatal)
      for (const p of state.positions.open) {
        try {
          const r = await closeWithStaleGuard(`/positions/${encodeURIComponent(p.id)}/close`, p.symbol);
          if (r) closed++;
        } catch (err) {
          failed++;
          toast(closeFailMessage(err, p.symbol), 'error');
        }
      }
    }
    toast(`Closed ${closed} position${closed === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}`, failed ? 'warn' : 'success');
    await refresh();
    hooks.patchCurrent();
  } catch (e) {
    toast(closeFailMessage(e, '').replace(/^Close failed:/, 'Close all failed:'), 'error');
  }
}

export function posClick(e) {
  const sortBtn = e.target.closest('[data-sort]');
  if (sortBtn) {
    const key = sortBtn.dataset.sort;
    state.sort = state.sort.key === key ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'symbol' || key === 'side' ? 'asc' : 'desc' };
    savePrefs();
    patchOpenTable();
    document.querySelector(`[data-sort="${key}"]`)?.focus();
    return;
  }
  const tab = e.target.closest('[data-postab]');
  if (tab) {
    state.posTab = tab.dataset.postab;
    savePrefs();
    applyPosTab();
    return;
  }
  if (e.target.closest('#btn-close-all')) return closeAll();
  const cb = e.target.closest('[data-close]');
  if (cb) return closePosition(cb.dataset.close);
  const row = e.target.closest('tr[data-pos]');
  if (row) selectPos(row.dataset.pos);
}
export function posKey(e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-pos]')) {
    e.preventDefault();
    selectPos(e.target.dataset.pos);
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.matches('tr[data-pos]')) {
    e.preventDefault();
    (e.key === 'ArrowDown' ? e.target.nextElementSibling : e.target.previousElementSibling)?.focus();
  }
}
