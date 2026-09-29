import { api, apiOptional, clsPos, escapeHtml as esc, fmtDateTime, fmtMoney } from './api.js';
import { LineChart } from './charts.js';
import { bannersHtml } from './dashboard.js';
import { calibrationBar } from './run-logic.js';
import { $, charts, empty, pctOf, root, setHtml, skeleton, state } from './state.js';

/* ---------- performance ---------- */

export function perfShellHtml() {
  return `<div class="perf-layout">
    <div class="perf-main">
      <div id="perf-stats" class="perf-cards"></div>
      <div class="perf-chart-title">EQUITY CURVE</div>
      <div class="chart-area perf-chart"><canvas id="equity-chart"></canvas></div>
      <p class="sr-only" id="equity-sum"></p>
      <div class="sr-only" id="equity-table"></div>
    </div>
    <div class="perf-side">
      <div class="perf-chart-title">CONFIDENCE CALIBRATION <span class="dim">— does 70% confidence win ~70%?</span></div>
      <div id="perf-calib"></div>
      <div class="perf-chart-title" style="margin-top:14px">AI vs RULE-BASED</div>
      <div id="perf-bots"></div>
    </div>
  </div>`;
}

/** 'No closed trades yet' / 'Only 1 closed trade' / 'Only 7 closed trades' (singular/plural handled). */
export function closedNote(n) {
  const tail = 'treat these numbers as anecdotal until there are 20+.';
  return n === 0 ? `No closed trades yet — ${tail}` : `Only ${n} closed trade${n === 1 ? '' : 's'} — ${tail}`;
}

export function statCard(label, value, cls = '', sub = '') {
  return `<div class="stat"><span class="lbl">${label}</span><strong class="${cls}">${value}</strong>${sub ? `<small class="dim">${sub}</small>` : ''}</div>`;
}

export function patchPerf() {
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
    ].join('') + ((p.closed ?? 0) < 20 ? `<div class="warn-note wide">${closedNote(p.closed ?? 0)}</div>` : ''),
  );
  if (!charts.equity) charts.equity = new LineChart($('equity-chart'), { summaryEl: $('equity-sum'), tableEl: $('equity-table'), format: (v) => fmtMoney(v, 0), title: 'Equity curve', yLabel: 'Equity (USD)', minRangePct: 0.5 });
  const start = Number(state.positions?.account?.startingEquity);
  const curve = (p.equityCurve || []).map((e) => ({ t: e.t, v: e.equity }));
  charts.equity.set(curve, { baseline: Number.isFinite(start) && start > 0 ? start : curve[0]?.v });

  const cal = p.calibration || [];
  setHtml(
    $('perf-calib'),
    cal.length
      ? `<ul class="calib">${cal
          .map((c) => {
            const { mid, hitRate: hr } = calibrationBar(c);
            return `<li><span class="calib-l mono">${esc(c.bucket)}</span><span class="calib-bar" role="img" aria-label="${esc(c.bucket)} confidence: hit rate ${hr.toFixed(0)}% over ${c.n} picks"><span class="calib-fill" style="width:${Math.min(100, hr)}%"></span>${mid != null ? `<span class="calib-ideal" style="left:${mid}%" title="Perfect calibration"></span>` : ''}</span><span class="calib-v mono">${hr.toFixed(0)}% <span class="dim">n=${c.n}</span></span></li>`;
          })
          .join('')}</ul><div class="dim calib-note">Bar = actual hit rate; tick = stated confidence. Bars left of the tick mean the model is overconfident.</div>`
      : empty('Not enough scored picks yet'),
  );
  const b = p.byBot;
  const row = (name, x) => `<tr><th scope="row">${name}</th><td class="mono" data-label="Closed">${x?.closed ?? 0}</td><td class="mono" data-label="Win rate">${x?.winRate != null ? `${pctOf(x.winRate).toFixed(0)}%` : '—'}</td><td class="mono ${clsPos(x?.pnl)}" data-label="P&amp;L">${fmtMoney(x?.pnl, 0)}</td></tr>`;
  setHtml($('perf-bots'), b ? `<table class="table"><thead><tr><th scope="col">BOT</th><th scope="col">CLOSED</th><th scope="col">WIN</th><th scope="col">P&amp;L</th></tr></thead><tbody>${row('AI', b.ai)}${row('Rules', b.rules)}</tbody></table>` : empty('No breakdown available'));
}

/* performance page */
export function mountPerformance() {
  root.innerHTML = `<div class="page">
    <div id="banners"></div>
    <section class="widget perf-section" aria-labelledby="h-perf"><h2 class="widget-title" id="h-perf">PERFORMANCE</h2>${perfShellHtml()}</section>
    <section class="widget" style="margin-top:12px" aria-labelledby="h-runs"><h2 class="widget-title" id="h-runs">RUN HISTORY</h2><div id="runs"></div></section>
  </div>`;
  patchPerformancePage();
  loadRuns();
}
export function patchPerformancePage() {
  setHtml($('banners'), bannersHtml());
  patchPerf();
  runsPatch();
}
export async function loadRuns() {
  const r = await apiOptional('/runs?limit=20');
  state.runs = r?.runs || (r === null ? null : []);
  runsPatch();
}
export function runsPatch() {
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
