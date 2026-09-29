import { clsPos, escapeHtml as esc, fmtMoney, fmtTime } from './api.js';
import { donutGradient } from './run-logic.js';
import { patchPerf, perfShellHtml } from './performance.js';
import { applyPosTab, patchPositions, posClick, posKey, tfButtonsHtml, tfClick } from './positions.js';
import { patchRunBar, startRun } from './run.js';
import { $, savePrefs, empty, pctOf, root, setCls, setHtml, setText, skeleton, state } from './state.js';

/* ---------- dashboard widgets ---------- */

export { donutGradient };

export function summaryHtml() {
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

export function allocationHtml() {
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

export function accuracyHtml() {
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

export function bannersHtml() {
  const s = state.status || {};
  const out = [];
  if (state.loadError) out.push(`<div class="notice" role="alert">Can’t reach the server (${esc(state.loadError)}). Showing the last data received${state.lastUpdate ? ` at ${esc(fmtTime(state.lastUpdate))}` : ''}; retrying automatically.</div>`);
  if (s.mockData) out.push('<div class="banner-mock">Running on <strong>mock</strong> market data — <a href="#settings">Add your Alpaca keys under Settings → Account</a> for live scans. Prices and results are synthetic.</div>');
  else if (s.fallbacks?.count) out.push(`<div class="banner-mock">Live data failed for ${s.fallbacks.count} symbol(s) — showing MOCK prices for: ${(s.fallbacks.symbols || []).map((f) => `<code title="${esc(f.error)}">${esc(f.symbol)}</code>`).join(' ')}</div>`);
  if (s.marketOpen === false) out.push('<div class="banner-mock">US stock market is closed — stock prices are the last close and stock stops are not evaluated. Crypto trades 24/7.</div>');
  if ((s.staleSymbols || []).length) out.push(`<div class="banner-mock">Stale quotes: ${s.staleSymbols.map((x) => `<code>${esc(x)}</code>`).join(' ')}</div>`);
  if (state.status && !s.openrouterConfigured) out.push('<div class="notice">OpenRouter key missing — the run uses the rule-based fallback instead of AI. <a href="#settings">Add it under Settings → Account</a>.</div>');
  return out.join('');
}

export function sysStripHtml() {
  const s = state.status;
  if (!s) return '';
  const w = s.worker?.status;
  return `Data: ${esc(s.dataMode || '?')} · Supabase: ${s.supabaseConfigured ? 'yes' : 'no'} · OpenRouter: ${s.openrouterConfigured ? 'yes' : '<a class="neg" href="#settings" title="Add your OpenRouter key under Settings → Account">MISSING</a>'}${w && w !== 'online' ? ` · Worker: <span class="neg">${esc(w)}</span>` : ''}`;
}

/** Label for the picks source, derived from picks.source + /api/status openrouterConfigured. */
export function picksBadge(st) {
  if (!st?.picks?.length) return { text: '', title: '' };
  if (st.source === 'ai') return { text: `AI · ${st.model || ''}`, title: 'Ranked by the AI scanner' };
  const configured = state.status?.openrouterConfigured;
  if (configured) {
    const why = st.fallbackReason || st.aiError || st.error || st.reason || st.note || '';
    return { text: `RULE-BASED · AI call failed — rule-based fallback used${why ? ` (${String(why).slice(0, 90)})` : ''}`, title: why ? `Reason: ${why}` : 'The OpenRouter key is configured, but the AI call failed; rule-based picks were used instead.' };
  }
  if (configured === false) return { text: 'RULE-BASED (no OpenRouter key)', title: 'Add an OpenRouter key to enable AI picks' };
  return { text: 'RULE-BASED', title: '' };
}

export function picksHtml() {
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

export function mountDashboard() {
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
          <div class="sr-only" id="pos-chart-table"></div>
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
    savePrefs();
    applyPosTab();
    $(`tab-${state.posTab}`).focus();
  });
  $('tf-pos').addEventListener('click', tfClick);
  patchDashboard();
}

export function patchDashboard() {
  if (!$('w-summary')) return;
  setHtml($('banners'), bannersHtml());
  setHtml($('w-summary'), summaryHtml());
  setHtml($('w-alloc'), allocationHtml());
  setHtml($('w-acc'), accuracyHtml());
  setHtml($('sys-strip'), sysStripHtml());
  const st = state.picks;
  setText($('picks-title'), `SCANNER TOP ${st?.picks?.length || 100} PICKS`);
  const pb = picksBadge(st);
  setText($('picks-badge'), pb.text);
  const pbEl = $('picks-badge');
  if (pbEl) pbEl.title = pb.title;
  setHtml($('w-picks'), picksHtml());
  patchPositions();
  applyPosTab();
  patchPerf();
  patchRunBar();
  patchUpdated();
}

export function patchUpdated() {
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
