import { api, apiOptional, clsPos, escapeHtml as esc, fmtDateTime, fmtMoney } from './api.js';
import { LineChart } from './charts.js';
import { bannersHtml } from './dashboard.js';
import { baselineVerdicts, MIN_BASELINE_N } from './ai-logic.js';
import { reliabilitySvg } from './fun-logic.js';
import { mountWhatif, whatifShellHtml } from './whatif.js';
import { $, charts, empty, pctOf, root, setHtml, skeleton, state } from './state.js';

/* ---------- performance ---------- */

export function perfShellHtml({ compact = false } = {}) {
  // Compact (dashboard): headline numbers and the equity chart. The Performance page has the rest.
  if (compact) {
    return `<div class="perf-layout perf-compact"><div class="perf-main">
      <div id="perf-stats" class="perf-cards"></div>
      <div class="perf-chart-title">EQUITY CURVE</div>
      <div class="chart-area perf-chart"><canvas id="equity-chart"></canvas></div>
      <p class="sr-only" id="equity-sum"></p>
      <div class="sr-only" id="equity-table"></div>
    </div></div>`;
  }
  return `<div class="perf-layout">
    <div class="perf-main">
      <div id="perf-stats" class="perf-cards"></div>
      <div id="perf-edge" class="edge-box"></div>
      <div class="perf-chart-title">EQUITY CURVE</div>
      <div class="chart-area perf-chart"><canvas id="equity-chart"></canvas></div>
      <p class="sr-only" id="equity-sum"></p>
      <div class="sr-only" id="equity-table"></div>
    </div>
    <div class="perf-side">
      <div class="perf-chart-title">YOUR APPROVALS <span class="dim">— did your decisions help?</span></div>
      <div id="perf-approval"></div>
      <div class="perf-chart-title" style="margin-top:14px">AI VS SIMPLE BASELINES</div>
      <div id="perf-base"></div>
      <div class="perf-chart-title" style="margin-top:14px">CONFIDENCE CALIBRATION <span class="dim">— does 70% confidence win ~70%?</span></div>
      <div id="perf-calib"></div>
      <div class="perf-chart-title" style="margin-top:14px">CLOSED TRADES BY SOURCE</div>
      <div id="perf-bots"></div>
    </div>
  </div>`;
}

/** 'No closed trades yet' / 'Only 1 closed trade' / 'Only 7 closed trades' (singular/plural handled). */
export function closedNote(n) {
  const tail = 'Treat these numbers as weak until you have 20 or more.';
  return n === 0 ? `No closed trades yet. ${tail}` : `Only ${n} closed trade${n === 1 ? '' : 's'}. ${tail}`;
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
    setHtml(stats, '<div class="empty">No performance data yet.</div>');
    charts.equity?.set([]);
    setHtml($('perf-calib'), '');
    setHtml($('perf-bots'), '');
    setHtml($('perf-edge'), '');
    setHtml($('perf-approval'), '');
    setHtml($('perf-base'), '');
    return;
  }
  const wr = pctOf(p.winRate);
  const dd = p.maxDrawdownPct;
  setHtml(
    stats,
    [
      statCard('WIN RATE', wr == null ? '—' : `${wr.toFixed(0)}%`, '', `${p.wins ?? 0} / ${p.closed ?? 0} closed`),
      statCard('AVG R', p.avgR != null ? `${Number(p.avgR).toFixed(2)}R` : '—', clsPos(p.avgR), 'per closed trade'),
      statCard('MAX DRAWDOWN', dd != null ? `${Math.abs(dd).toFixed(2)}%` : '—', dd ? 'neg' : '', p.maxDrawdownUsd != null ? fmtMoney(p.maxDrawdownUsd, 0) : ''),
      statCard('REALIZED P&amp;L', fmtMoney(p.realizedPnl, 0), clsPos(p.realizedPnl)),
    ].join('') + ((p.closed ?? 0) < 20 ? `<div class="warn-note wide">${closedNote(p.closed ?? 0)}</div>` : ''),
  );
  if (!charts.equity) charts.equity = new LineChart($('equity-chart'), { summaryEl: $('equity-sum'), tableEl: $('equity-table'), format: (v) => fmtMoney(v, 0), title: 'Equity curve', yLabel: 'Equity (USD)', minRangePct: 0.5 });
  const start = Number(state.positions?.account?.startingEquity);
  const curve = (p.equityCurve || []).map((e) => ({ t: e.t, v: e.equity }));
  charts.equity.set(curve, { baseline: Number.isFinite(start) && start > 0 ? start : curve[0]?.v });

  setHtml($('perf-calib'), calibrationHtml(p));
  setHtml($('perf-edge'), edgeHtml(p));
  setHtml($('perf-approval'), approvalHtml(p));
  setHtml($('perf-base'), baselinesHtml(p));
  const b = p.byBot;
  const row = (name, x, demo) => `<tr><th scope="row">${name}${demo ? ' <span class="badge-demo">DEMO DATA</span>' : ''}</th><td class="mono" data-label="Closed">${x?.closed ?? 0}</td><td class="mono" data-label="Win rate">${x?.winRate != null ? `${pctOf(x.winRate).toFixed(0)}%` : '—'}</td><td class="mono ${clsPos(x?.pnl)}" data-label="P&amp;L">${fmtMoney(x?.pnl, 0)}</td></tr>`;
  setHtml($('perf-bots'), b ? `<table class="table"><thead><tr><th scope="col">SOURCE</th><th scope="col">CLOSED</th><th scope="col">WIN</th><th scope="col">P&amp;L</th></tr></thead><tbody>${row('AI', b.ai)}${b.demo?.closed ? row('Demo AI', b.demo, true) : ''}</tbody></table>` : empty('No breakdown available'));
}

const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtMoney(Math.abs(n), 2)}`);

/** Reliability diagram (stated confidence vs actual hit rate) with a plain-language verdict and an accessible table. */
export function calibrationHtml(p) {
  const ch = p.calibrationChart;
  const sm = ch?.summary;
  if (!sm || !sm.n) return empty('Not enough scored picks yet');
  const pc = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);
  const better = sm.brier != null && sm.brierBaseline != null && sm.brier < sm.brierBaseline;
  return `<div class="rel">
    <div class="rel-chart">${reliabilitySvg(ch, { size: Math.round(Math.min(340, Math.max(240, $('perf-calib')?.clientWidth || 300))) })}</div>
    <div class="rel-side">
      <p class="rel-verdict rel-${esc(sm.verdict)}"><strong>${esc(sm.verdictText)}</strong></p>
      <dl class="rel-stats"><div><dt>Says on average</dt><dd class="mono">${pc(sm.avgConfidence)}</dd></div><div><dt>Actually right</dt><dd class="mono">${pc(sm.hitRate)}</dd></div><div><dt>Brier score</dt><dd class="mono">${sm.brier == null ? '—' : sm.brier.toFixed(3)}</dd><small class="dim">${better ? 'beats' : 'does not beat'} always guessing the base rate (${sm.brierBaseline == null ? '—' : sm.brierBaseline.toFixed(3)}); lower is better</small></div></dl>
      <p class="dim calib-note"><span class="rel-key rel-under" aria-hidden="true"></span> on or above the diagonal: it delivers at least what it claims. <span class="rel-key rel-over" aria-hidden="true"></span> below: overconfident. Bar = 95% range; bigger dot = more picks.</p>
    </div>
    <table class="sr-only"><caption>Calibration by confidence bucket</caption><thead><tr><th scope="col">Confidence</th><th scope="col">Picks</th><th scope="col">Actual hit rate</th></tr></thead><tbody>${ch.buckets.filter((b) => b.n > 0).map((b) => `<tr><th scope="row">${esc(b.bucket)}</th><td>${b.n}</td><td>${pc(b.hitRate)}</td></tr>`).join('')}</tbody></table>
  </div>`;
}

/** Net edge hero with its breakdown, avoided loss and missed gain. */
export function edgeHtml(p) {
  if (p.netEdge == null) return '';
  const parts = p.netEdgeParts || {};
  const w = parts.weights || {};
  const dd = parts.maxDrawdownUsd ?? p.maxDrawdownUsd ?? 0;
  const ddW = w.drawdown ?? 0.5;
  const avW = w.avoided ?? 1;
  const avoided = parts.avoidedLoss ?? p.avoidedLoss ?? 0;
  return `<div class="edge-hero"><div><span class="lbl">NET EDGE</span><strong class="big-num mono ${clsPos(p.netEdge)}">${signed(p.netEdge)}</strong></div>
      <div class="edge-tiles">
        <div class="edge-tile edge-good"><span class="lbl"><span aria-hidden="true">✓</span> AVOIDED LOSS</span><strong class="mono pos">${fmtMoney(p.avoidedLoss ?? 0, 2)}</strong><small>trades you passed on that would have lost</small></div>
        <div class="edge-tile edge-bad"><span class="lbl"><span aria-hidden="true">✗</span> MISSED GAIN</span><strong class="mono neg">${fmtMoney(p.missedGain ?? 0, 2)}</strong><small>trades you passed on that would have won</small></div>
      </div></div>
    <table class="edge-break"><caption class="sr-only">How net edge is built</caption><tbody>
      <tr><th scope="row">Realized P&amp;L</th><td class="mono ${clsPos(parts.realizedPnl)}">${signed(parts.realizedPnl ?? p.realizedPnl)}</td></tr>
      <tr><th scope="row">− ${esc(ddW)} × max drawdown <span class="dim mono">${fmtMoney(dd, 2)}</span></th><td class="mono neg">${signed(-ddW * dd)}</td></tr>
      <tr><th scope="row">+ ${esc(avW)} × avoided loss <span class="dim mono">${fmtMoney(avoided, 2)}</span></th><td class="mono ${avoided ? 'pos' : ''}">${signed(avW * avoided)}</td></tr>
      <tr class="edge-total"><th scope="row">Net edge</th><td class="mono ${clsPos(p.netEdge)}">${signed(p.netEdge)}</td></tr></tbody></table>
    <p class="dim edge-note">Weights are adjustable in <a class="prop-link" href="#settings/edge">Settings</a>.</p>`;
}

/** Approved vs rejected vs passed-on, in plain language. */
export function approvalHtml(p) {
  const a = p.approval;
  const pr = p.proposals;
  if (!a && !pr) return empty('No proposals decided yet');
  const n = (x) => `${x ?? 0} ${x === 1 ? 'trade' : 'trades'}`;
  const line = (label, net, cnt, hint) => `<tr><th scope="row">${label}<small class="dim">${hint}</small></th><td class="mono ${clsPos(net)}" data-label="Net">${signed(net ?? 0)}</td><td class="mono dim" data-label="Count">${n(cnt)}</td></tr>`;
  let verdict = '';
  if (a && (a.rejectedCount || 0) + (a.passedOnCount || 0) > 0) {
    const r = (a.rejectedNet || 0) + (a.passedOnNet || 0);
    verdict = r < 0 ? `<p class="verdict verdict-good"><span aria-hidden="true">✓</span> Passing on those trades saved about ${fmtMoney(Math.abs(r), 2)}.</p>` : r > 0 ? `<p class="verdict verdict-bad"><span aria-hidden="true">✗</span> Passing on those trades cost about ${fmtMoney(r, 2)} in missed gains.</p>` : '<p class="verdict">Passing on those trades made no difference so far.</p>';
  }
  return `${pr ? `<div class="dim appr-counts">${pr.total ?? 0} proposals: ${pr.approved ?? 0} approved · ${pr.rejected ?? 0} rejected · ${pr.expired ?? 0} expired · ${pr.superseded ?? 0} superseded${pr.pending ? ` · ${pr.pending} pending` : ''}</div>` : ''}
    ${a ? `<table class="table appr"><tbody>${line('Approved', a.approvedNet, a.approvedCount, 'result of the trades you took')}${line('Rejected', a.rejectedNet, a.rejectedCount, 'what they would have done')}${line('Passed on', a.passedOnNet, a.passedOnCount, 'expired or superseded, same what-if')}</tbody></table>${verdict}` : ''}`;
}

/** AI vs SPY buy-and-hold vs seeded random picks, with small-sample guards. */
export function baselinesHtml(p) {
  const bl = p.baselines;
  if (!bl) return empty('No baseline data yet');
  const row = (label, x, cls = '') => `<tr class="${cls}"><th scope="row">${label}</th><td class="mono ${clsPos(x?.pnl)}" data-label="P&amp;L">${x?.n ? signed(x.pnl) : '—'}</td><td class="mono ${clsPos(x?.pct)}" data-label="Return">${x?.pct != null ? `${x.pct > 0 ? '+' : ''}${Number(x.pct).toFixed(2)}%` : '—'}</td><td class="mono dim" data-label="Trades">n=${x?.n ?? 0}</td></tr>`;
  const chips = baselineVerdicts(bl)
    .map((v) => `<li class="vchip vchip-${v.tone}"><span aria-hidden="true">${v.tone === 'good' ? '✓' : v.tone === 'bad' ? '✗' : '…'}</span> <span>${esc(v.text)}</span></li>`)
    .join('');
  const win = bl.window?.from ? `Window: ${esc(fmtDateTime(bl.window.from))} to ${esc(fmtDateTime(bl.window.to))}` : 'No comparison window yet';
  return `<table class="table base"><thead><tr><th scope="col">STRATEGY</th><th scope="col">P&amp;L</th><th scope="col">RETURN</th><th scope="col">N</th></tr></thead><tbody>${row('AI proposals', bl.ai, 'is-ai')}${row('SPY buy &amp; hold', bl.spyHold)}${row('Random picks', bl.randomPicks)}</tbody></table>
    <ul class="vchips">${chips}</ul>
    <p class="dim base-note">${win}. Each strategy uses the same size and costs. A verdict needs ${MIN_BASELINE_N} or more scored trades on each side. With fewer, the result is mostly luck.</p>`;
}

/* performance page */
export function mountPerformance() {
  root.innerHTML = `<div class="page">
    <div id="banners"></div>
    <section class="widget perf-section" aria-labelledby="h-perf"><h2 class="widget-title" id="h-perf">PERFORMANCE</h2>${perfShellHtml()}</section>
    ${whatifShellHtml()}
    <section class="widget" style="margin-top:12px" aria-labelledby="h-runs"><h2 class="widget-title" id="h-runs">RUN HISTORY</h2><div id="runs"></div></section>
  </div>`;
  mountWhatif();
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
const RUN_STATUS = { done: 'Done', blocked: 'Blocked', error: 'Failed' };

export function runsPatch() {
  const el = $('runs');
  if (!el) return;
  const runs = state.runs;
  if (runs === null) return setHtml(el, state.loaded ? empty('Run history isn’t available from the server yet.') : skeleton(3));
  if (!runs.length) return setHtml(el, empty('No runs recorded yet. Press RUN on the dashboard.'));
  setHtml(
    el,
    `<div class="scroll-y" tabindex="0" role="region" aria-label="Run history table"><table class="table cards t-runs"><thead><tr><th scope="col">WHEN</th><th scope="col">RESULT</th><th scope="col">TRADER</th><th scope="col">PICKS</th><th scope="col">PROPOSALS</th><th scope="col">COST</th><th scope="col">NOTE</th></tr></thead><tbody>${runs
      .map((r) => {
        const st = r.status || 'done';
        const n = r.proposalCount ?? r.proposals?.length ?? 0;
        const syms = (r.proposals || []).slice(0, 4).map((t) => esc(t.symbol)).join(', ');
        const demo = r.demo || r.traderSource === 'demo';
        return `<tr><td class="mono" data-label="When">${esc(fmtDateTime(r.at))}</td><td data-label="Result"><span class="st-pill st-run-${esc(st)}">${esc(RUN_STATUS[st] || st)}</span></td><td data-label="Trader">${demo ? '<span class="badge-demo">DEMO DATA</span> ' : ''}${esc(r.traderModel || (demo ? 'test AI' : '—'))}</td><td class="mono" data-label="Picks">${esc(r.picks ?? '—')}</td><td class="mono" data-label="Proposals">${n}${syms ? ` <span class="dim">(${syms}${(r.proposals || []).length > 4 ? '…' : ''})</span>` : ''}${r.autoApproved ? ` <span class="dim">${r.autoApproved} auto</span>` : ''}</td><td class="mono" data-label="Cost">${r.costUsd != null ? fmtMoney(r.costUsd, r.costUsd && r.costUsd < 0.1 ? 4 : 2) : '—'}</td><td class="reason" data-label="Note"><div class="clamp">${esc(st !== 'done' ? r.error || r.code || r.note || '' : r.note || '')}</div></td></tr>`;
      })
      .join('')}</tbody></table></div>`,
  );
}
