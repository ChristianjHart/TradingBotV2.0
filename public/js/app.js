import { api, fmtMoney, fmtPct, fmtTime, clsPos } from './api.js';
import { drawCandleChart } from './charts.js';

const root = document.getElementById('view-root');
const state = {
  page: 'dashboard',
  dashboard: null,
  status: null,
  selectedSymbol: 'SPY',
  indicators: { vol: true, vwap: true, ema9: true, ema21: true },
  bars: [],
  tvWidget: null,
  picks: null,
  positions: null,
  selectedPos: null,
  runStage: null,
};

function setWorkerUI(worker) {
  const dot = document.getElementById('worker-dot');
  const badge = document.getElementById('mode-badge');
  badge.textContent = 'PREDICT';
  if (!worker) return;
  dot.classList.remove('offline', 'warn');
  if (worker.status === 'online') {
    /* green default */
  } else if (worker.status === 'degraded') {
    dot.classList.add('warn');
  } else {
    dot.classList.add('offline');
  }
}

function navActive(page) {
  document.querySelectorAll('#main-nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === page);
  });
}

function donutGradient(parts) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  let acc = 0;
  const stops = parts.map((p) => {
    const start = (acc / total) * 360;
    acc += p.value;
    const end = (acc / total) * 360;
    return `${p.color} ${start}deg ${end}deg`;
  });
  return `conic-gradient(${stops.join(', ')})`;
}

function renderDashboard() {
  const d = state.dashboard;
  if (!d) {
    root.innerHTML = `<div class="page"><div class="empty">Loading…</div></div>`;
    return;
  }

  const acc = d.accuracy || {};
  const accPct = acc.accuracy != null ? `${(acc.accuracy * 100).toFixed(1)}%` : '—';
  const open = d.openPredictions || [];
  const recent = d.recentResolved || [];
  const allocation = (d.allocation || []).filter((a) => a.value > 0);
  const allocFallback = allocation.length
    ? allocation
    : [
        { label: 'LONG', value: 1, color: '#22c55e' },
        { label: 'SHORT', value: 1, color: '#ef4444' },
        { label: 'WATCH', value: 1, color: '#8b5cf6' },
      ];

  const scanned = d.watchlist?.scanned ?? 0;
  const universe = d.watchlist?.universe ?? 0;

  root.innerHTML = `
    <div class="page">
      ${d.mockData ? `<div class="banner-mock">Running on mock market data — add Alpaca keys in <code>.env</code> for live scans.</div>` : ''}
      ${!d.mockData && d.fallbacks?.count ? `<div class="banner-mock">Live data failed for ${d.fallbacks.count} symbol(s) — showing MOCK prices for: ${d.fallbacks.symbols.map((f) => `<code title="${escapeHtml(f.error)}">${escapeHtml(f.symbol)}</code>`).join(' ')}</div>` : ''}
      <div class="page-toolbar">
        <div class="tabs">
          <button class="tab active" type="button">Dashboard</button>
          <button class="tab" type="button" data-goto="decisions">Predictions</button>
          <button class="tab-add" type="button">+</button>
        </div>
        <div class="toolbar-actions">
          <button class="btn-ghost" id="btn-scan" type="button">RUN</button>
          <button class="btn-ghost" type="button">ADD WIDGET</button>
          <button class="btn-ghost" type="button">EDIT LAYOUT</button>
        </div>
      </div>

      <div class="grid grid-dashboard">
        <section class="widget allocation">
          <div class="widget-title">ALLOCATION</div>
          <div class="alloc-wrap">
            <div class="donut" style="background:${donutGradient(allocFallback)}"><div class="donut-hole"></div></div>
            <div class="legend">
              ${allocFallback
                .map(
                  (a) => `
                <div class="legend-row">
                  <span class="swatch" style="background:${a.color}"></span>
                  <span>${a.label}</span>
                  <span class="muted mono">${a.value}</span>
                </div>`,
                )
                .join('')}
            </div>
          </div>
        </section>

        <section class="widget portfolio">
          <div class="widget-title">
            <span>PREDICTION ACCURACY</span>
            <div class="range-tabs">
              <button class="active" type="button">1D</button>
              <button type="button">1W</button>
              <button type="button">1M</button>
            </div>
          </div>
          <div class="big-num">${accPct}</div>
          <div class="sub-num ${acc.hits != null ? 'pos' : ''}">
            ${acc.hits ?? 0} hits / ${acc.total ?? 0} resolved · ${acc.open ?? 0} open
          </div>
          <div class="chart-area"><canvas id="acc-chart"></canvas></div>
        </section>

        <section class="widget buying">
          <div class="widget-title">SCANNER</div>
          <div class="big-num">${scanned}<span class="muted" style="font-size:16px"> / ${universe}</span></div>
          <div class="sub-num">${d.watchlist?.symbols?.length || 0} on today's watchlist · horizon ${d.horizonHours || 24}h</div>
        </section>

        <section class="widget positions">
          <div class="widget-title">OPEN PREDICTIONS</div>
          ${
            open.length
              ? `<table class="table">
            <thead><tr><th>SYMBOL</th><th>DIR</th><th>ENTRY</th><th>TARGET</th><th>CONF</th><th></th></tr></thead>
            <tbody>
              ${open
                .slice(0, 12)
                .map(
                  (p) => `
                <tr>
                  <td><span class="sym">${p.symbol}</span> <span class="dim">${p.direction}</span></td>
                  <td><span class="pill pill-${p.direction}">${p.direction}</span></td>
                  <td class="mono">${fmtMoney(p.entryPrice)}</td>
                  <td class="mono ${clsPos(p.expectedMovePct)}">${fmtPct(p.expectedMovePct)}</td>
                  <td class="mono">${(p.confidence * 100).toFixed(0)}%</td>
                  <td><button class="btn-close" data-sym="${p.symbol}" type="button">Chart</button></td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>`
              : `<div class="empty">No open predictions — run a scan</div>`
          }
        </section>

        <section class="widget trades">
          <div class="widget-title">RECENT RESULTS</div>
          ${
            recent.length
              ? `<table class="table">
            <thead><tr><th>SYMBOL</th><th>DIR</th><th>MOVE</th><th>RESULT</th></tr></thead>
            <tbody>
              ${recent
                .slice(0, 12)
                .map(
                  (p) => `
                <tr>
                  <td class="sym">${p.symbol}</td>
                  <td><span class="pill pill-${p.direction}">${p.direction}</span></td>
                  <td class="mono ${clsPos(p.actualMovePct)}">${fmtPct(p.actualMovePct)}</td>
                  <td><span class="pill pill-${p.correct ? 'hit' : 'miss'}">${p.correct ? 'HIT' : 'MISS'}</span></td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>`
              : `<div class="empty">No settled predictions yet</div>`
          }
        </section>

        <section class="widget perf">
          <div class="widget-title">AI PERFORMANCE</div>
          <div class="perf-hero">
            <label>MODEL ACCURACY</label>
            <div class="big-num" style="font-size:22px">${accPct}</div>
          </div>
          <div class="perf-grid">
            <div class="perf-stat"><label>WINS</label><strong>${acc.hits ?? 0}/${acc.total ?? 0}</strong></div>
            <div class="perf-stat"><label>MODE</label><strong>predict</strong></div>
            <div class="perf-stat"><label>BOT</label><strong>${d.worker?.status || '—'}</strong></div>
            <div class="perf-stat"><label>WORKER</label><strong>${d.worker?.scanning ? 'scanning' : 'online'}</strong></div>
            <div class="perf-stat"><label>MODEL</label><strong>v${d.model?.version ?? 1}</strong></div>
            <div class="perf-stat"><label>TRAINED</label><strong>${d.model?.trainedOn ?? 0}</strong></div>
          </div>
        </section>

        <section class="widget log">
          <div class="widget-title">AI LOG</div>
          <div class="log-list">
            ${(d.logs || [])
              .slice(0, 30)
              .map(
                (l) => `
              <div class="log-row ${l.level}">
                <span class="ts">${fmtTime(l.ts)}</span>
                <span class="msg">${escapeHtml(l.message)}</span>
              </div>`,
              )
              .join('') || '<div class="empty">No logs</div>'}
          </div>
        </section>
      </div>
      ${aiSectionHtml()}
    </div>
  `;

  drawAccuracyChart(document.getElementById('acc-chart'), acc.series || []);
  drawPositionChart();

  document.getElementById('btn-scan')?.addEventListener('click', runAiPipeline);
  bindAiWidgets();

  root.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.goto));
  });

  root.querySelectorAll('[data-sym]').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedSymbol = el.dataset.sym;
      navigate('market');
    });
  });
}

function runButtonLabel() {
  const stage = state.runStage;
  if (stage === 'fetching') return 'FETCHING DATA…';
  if (stage === 'scanning') return 'SCANNER BOT…';
  if (stage === 'trading') return 'TRADER BOT…';
  return 'RUN';
}

async function runAiPipeline() {
  const btn = document.getElementById('btn-scan');
  if (btn) btn.disabled = true;
  try {
    await api('/run', { method: 'POST' });
    for (;;) {
      const st = await api('/run/status');
      state.runStage = st.running ? st.stage : null;
      if (btn) btn.textContent = runButtonLabel();
      if (st.stage === 'trading' || !st.running) {
        await refresh();
        render();
      }
      if (!st.running) {
        if (st.error) alert(`Run failed: ${st.error}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) {
    alert(e.message);
  } finally {
    state.runStage = null;
    const b = document.getElementById('btn-scan');
    if (b) {
      b.textContent = 'RUN';
      b.disabled = false;
    }
  }
}

function aiSectionHtml() {
  const picks = state.picks?.picks || [];
  const pos = state.positions;
  const open = pos?.open || [];
  const acct = pos?.account;
  const sel = open.find((p) => p.id === state.selectedPos) || open[0];
  if (sel) state.selectedPos = sel.id;
  const badge = state.picks?.source === 'ai' ? `AI · ${escapeHtml(state.picks.model || '')}` : picks.length ? 'RULE-BASED (no OpenRouter key)' : '';

  const st = state.status || {};
  const run = st.run || {};
  const runLine = run.error
    ? `<span class="neg">Last run FAILED: ${escapeHtml(run.error)}</span>`
    : run.stage === 'done'
      ? `Last run: ${run.picks} picks · ${run.opened} position(s) opened`
      : run.running
        ? `Running: ${{ fetching: 'fetching market data', scanning: 'scanner bot (AI can take 1–3 min)', trading: 'trader bot' }[run.stage] || run.stage}…`
        : 'No run since the server started';
  const flags = `OpenRouter key: ${st.openrouterConfigured ? 'yes' : '<span class="neg">MISSING</span>'} · Supabase: ${st.supabaseConfigured ? 'yes' : 'no'} · Data: ${escapeHtml(st.dataMode || '?')}`;

  return `
    <div class="run-status">${runLine} <span class="dim">— ${flags}</span></div>
    <div class="grid grid-ai">
      <section class="widget ai-picks">
        <div class="widget-title"><span>AI TOP ${picks.length || 100} PICKS</span><span class="dim">${badge}</span></div>
        ${
          picks.length
            ? `<div class="scroll-y"><table class="table">
          <thead><tr><th>#</th><th>SYMBOL</th><th>DIR</th><th>CONF</th><th>REASON</th></tr></thead>
          <tbody>${picks
            .map(
              (p, i) => `<tr>
              <td class="dim mono">${i + 1}</td>
              <td class="sym">${escapeHtml(p.symbol)}</td>
              <td><span class="pill pill-${p.direction}">${p.direction}</span></td>
              <td class="mono">${(p.confidence * 100).toFixed(0)}%</td>
              <td class="reason">${escapeHtml(p.reason)}</td></tr>`,
            )
            .join('')}</tbody></table></div>`
            : `<div class="empty">Press RUN — the scanner bot will rank the top 100 symbols</div>`
        }
      </section>

      <section class="widget ai-positions">
        <div class="widget-title"><span>OPEN POSITIONS (SIMULATED)</span>
          <span class="dim mono">${acct ? `equity ${fmtMoney(acct.equity, 0)} · cash ${fmtMoney(acct.cash, 0)} · P&L ${fmtMoney(acct.realizedPnl + acct.unrealizedPnl, 0)}` : ''}</span></div>
        ${
          open.length
            ? `<div class="scroll-y short"><table class="table">
          <thead><tr><th>SYMBOL</th><th>SIDE</th><th>ALLOC</th><th>ENTRY</th><th>STOP</th><th>TARGET</th><th>P&L</th><th></th></tr></thead>
          <tbody>${open
            .map(
              (p) => `<tr class="pos-row ${p.id === state.selectedPos ? 'sel' : ''}" data-pos="${p.id}" title="${escapeHtml(p.reason)}">
              <td class="sym">${escapeHtml(p.symbol)}</td>
              <td><span class="pill pill-${p.side}">${p.side}</span></td>
              <td class="mono">${fmtMoney(p.allocation, 0)}</td>
              <td class="mono">${fmtMoney(p.entry)}</td>
              <td class="mono neg">${fmtMoney(p.stopLoss)}</td>
              <td class="mono pos">${fmtMoney(p.takeProfit)}</td>
              <td class="mono ${clsPos(p.pnl)}">${fmtMoney(p.pnl)} <span class="dim">${fmtPct(p.pnlPct)}</span></td>
              <td><button class="btn-close" data-close="${p.id}" type="button">Close</button></td></tr>`,
            )
            .join('')}</tbody></table></div>
          <div class="pos-chart-head">${sel ? `${escapeHtml(sel.symbol)} · ${sel.side.toUpperCase()} — <span class="dim">${escapeHtml(sel.reason)}</span>` : ''}</div>
          <canvas id="pos-chart"></canvas>`
            : `<div class="empty">No open positions — the trader bot opens up to 10 after each run</div>`
        }
      </section>
    </div>`;
}

async function drawPositionChart() {
  const canvas = document.getElementById('pos-chart');
  const sel = (state.positions?.open || []).find((p) => p.id === state.selectedPos);
  if (!canvas || !sel) return;
  try {
    const { bars } = await api(`/market/bars/${encodeURIComponent(sel.symbol)}?limit=100`);
    drawCandleChart(document.getElementById('pos-chart'), bars, {
      ema9: true,
      ema21: true,
      levels: [
        { price: sel.takeProfit, label: 'TARGET', color: '#22c55e', dash: true },
        { price: sel.entry, label: 'ENTRY', color: '#e5e7eb', dash: false },
        { price: sel.stopLoss, label: 'STOP', color: '#ef4444', dash: true },
      ],
    });
  } catch {
    /* chart is best-effort */
  }
}

function bindAiWidgets() {
  root.querySelectorAll('[data-pos]').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedPos = row.dataset.pos;
      render();
    });
  });
  root.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Close this simulated position at the current price?')) return;
      await api(`/positions/${btn.dataset.close}/close`, { method: 'POST' });
      await refresh();
      render();
    });
  });
}

function drawAccuracyChart(canvas, series) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = Math.max(120, rect.height) * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = Math.max(120, rect.height);
  ctx.clearRect(0, 0, w, h);

  const points = series.length
    ? series
    : Array.from({ length: 12 }, (_, i) => ({
        accuracy: 0.45 + Math.sin(i / 2) * 0.08 + i * 0.01,
      }));

  const pad = 8;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = pad + (i / Math.max(1, points.length - 1)) * (w - pad * 2);
    const y = h - pad - p.accuracy * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  const lastX = pad + (w - pad * 2);
  const firstX = pad;
  ctx.lineTo(lastX, h);
  ctx.lineTo(firstX, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(34,197,94,0.35)');
  grad.addColorStop(1, 'rgba(34,197,94,0)');
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => {
    const x = pad + (i / Math.max(1, points.length - 1)) * (w - pad * 2);
    const y = h - pad - p.accuracy * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function renderMarket() {
  const wl = state.dashboard?.watchlist?.symbols || [];
  const quotes = await api(`/market/quotes?symbols=${encodeURIComponent(['SPY', 'QQQ', 'IWM'].join(','))}`).catch(
    () => ({ quotes: [] }),
  );

  root.innerHTML = `
    <div class="page">
      <div class="grid grid-market">
        <section class="widget chart-custom">
          <div class="chart-toolbar">
            <button class="active" type="button">CANDLES</button>
            ${['VOL', 'VWAP', 'EMA9', 'EMA21', 'SMA50', 'BB', 'RSI', 'MACD']
              .map((id) => {
                const key = id.toLowerCase();
                const on = state.indicators[key] ? 'active' : '';
                return `<button class="ind-toggle ${on}" data-ind="${key}" type="button">${id}</button>`;
              })
              .join('')}
          </div>
          <canvas id="mini-chart"></canvas>
        </section>

        <section class="widget watchlist">
          <div class="widget-title">WATCHLIST</div>
          <div id="watch-body">
            ${(quotes.quotes || [])
              .map(
                (q) => `
              <div class="watch-row" data-pick="${q.symbol}">
                <div>
                  <div class="sym">${q.symbol}</div>
                </div>
                <div style="text-align:right">
                  <div class="mono">${fmtMoney(q.price)}</div>
                  <div class="mono ${clsPos(q.changePct)}">${fmtPct(q.changePct)}</div>
                </div>
              </div>`,
              )
              .join('')}
            ${
              wl.length
                ? wl
                    .slice(0, 8)
                    .map(
                      (w) => `
              <div class="watch-row" data-pick="${w.symbol}">
                <div>
                  <div class="sym">${w.symbol}</div>
                  <div class="dim"><span class="pill pill-${w.direction}">${w.direction}</span> ${(w.confidence * 100).toFixed(0)}%</div>
                </div>
                <div style="text-align:right">
                  <div class="mono">${fmtMoney(w.price)}</div>
                  <div class="mono ${clsPos(w.expectedMovePct)}">${fmtPct(w.expectedMovePct)}</div>
                </div>
              </div>`,
                    )
                    .join('')
                : ''
            }
          </div>
          <a class="manage-link" href="#ai-desk">Manage watchlist / rescan</a>
        </section>

        <section class="widget strategies">
          <div class="widget-title">SIGNAL ENGINES</div>
          ${[
            { name: 'Momentum Scan', on: true, meta: 'equities + crypto' },
            { name: 'RSI Extremes', on: true, meta: 'mean reversion bias' },
            { name: 'MACD Cross', on: true, meta: 'trend confirmation' },
            { name: 'Volume Spike', on: true, meta: 'relative volume' },
            { name: 'EMA Trend Pullback', on: true, meta: 'EMA9 / EMA21' },
            { name: 'Live Trading', on: false, meta: 'DISABLED — predict only' },
          ]
            .map(
              (s) => `
            <div class="strategy-row">
              <div>
                <div class="strategy-name"><span class="status-dot ${s.on ? 'on' : ''}"></span>${s.name}</div>
                <div class="strategy-meta">${s.on ? 'ACTIVE' : 'DISABLED'} · ${s.meta}</div>
              </div>
              <div class="strategy-actions">
                <button class="btn-mini" type="button">${s.on ? 'On' : 'Off'}</button>
                <button class="btn-mini kill" type="button">Kill</button>
              </div>
            </div>`,
            )
            .join('')}
        </section>

        <section class="widget tv">
          <div id="tv-container" class="tv-frame"></div>
        </section>
      </div>
    </div>
  `;

  await loadBarsAndDraw();
  mountTradingView(state.selectedSymbol);

  root.querySelectorAll('[data-ind]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.ind;
      if (['sma50', 'bb', 'rsi', 'macd'].includes(key)) return; // reserved toggles
      state.indicators[key] = !state.indicators[key];
      btn.classList.toggle('active', state.indicators[key]);
      drawCandleChart(document.getElementById('mini-chart'), state.bars, state.indicators);
    });
  });

  root.querySelectorAll('[data-pick]').forEach((el) => {
    el.addEventListener('click', async () => {
      state.selectedSymbol = el.dataset.pick;
      await loadBarsAndDraw();
      mountTradingView(state.selectedSymbol);
    });
  });
}

async function loadBarsAndDraw() {
  try {
    const data = await api(`/market/bars/${encodeURIComponent(state.selectedSymbol)}?limit=120`);
    state.bars = data.bars || [];
    drawCandleChart(document.getElementById('mini-chart'), state.bars, state.indicators);
  } catch (e) {
    console.warn(e);
  }
}

function toTvSymbol(symbol) {
  if (symbol.includes('/')) {
    const [base, quote] = symbol.split('/');
    return `BINANCE:${base}${quote === 'USD' ? 'USDT' : quote}`;
  }
  return symbol;
}

function mountTradingView(symbol) {
  const container = document.getElementById('tv-container');
  if (!container || typeof TradingView === 'undefined') return;
  container.innerHTML = '';
  // eslint-disable-next-line no-new
  state.tvWidget = new TradingView.widget({
    container_id: 'tv-container',
    symbol: toTvSymbol(symbol),
    interval: '5',
    timezone: 'Etc/UTC',
    theme: 'dark',
    style: '1',
    locale: 'en',
    toolbar_bg: '#15171d',
    enable_publishing: false,
    hide_top_toolbar: false,
    hide_legend: false,
    save_image: false,
    studies: ['Volume@tv-basicstudies', 'VWAP@tv-basicstudies'],
    width: '100%',
    height: '100%',
  });
}

function renderAiDesk() {
  const wl = state.dashboard?.watchlist;
  const model = state.dashboard?.model;
  const open = state.dashboard?.openPredictions || [];

  root.innerHTML = `
    <div class="page">
      <div class="notice">Predict-only mode: the AI scans markets, builds today's watchlist, and logs predictions. No orders are ever sent to Alpaca.</div>
      <div class="page-toolbar">
        <div class="tabs">
          <button class="tab active" type="button">AI Desk</button>
        </div>
        <div class="toolbar-actions">
          <button class="btn-primary" id="btn-scan2" type="button">Super Scan Markets</button>
          <button class="btn-ghost" id="btn-eval" type="button">Evaluate Due</button>
          <button class="btn-ghost" id="btn-train" type="button">Train Model</button>
        </div>
      </div>
      <div class="panel-stack">
        <section class="widget">
          <div class="widget-title">TODAY'S WATCHLIST ${wl?.date ? `· ${wl.date}` : ''}</div>
          ${
            (wl?.symbols || [])
              .map(
                (w) => `
            <div class="pred-card">
              <h3>${w.symbol} <span class="pill pill-${w.direction}">${w.direction}</span></h3>
              <div class="pred-meta">
                <span>${fmtMoney(w.price)}</span>
                <span class="${clsPos(w.expectedMovePct)}">${fmtPct(w.expectedMovePct)} expected</span>
                <span>${(w.confidence * 100).toFixed(0)}% confidence</span>
                <span class="dim">${w.assetClass}</span>
              </div>
              <ul class="reasons">${(w.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
            </div>`,
              )
              .join('') || '<div class="empty">No watchlist yet</div>'
          }
        </section>
        <section class="widget">
          <div class="widget-title">MODEL WEIGHTS · v${model?.version ?? 1}</div>
          <table class="table">
            <tbody>
              ${Object.entries(model?.weights || {})
                .map(
                  ([k, v]) => `
                <tr><td class="sym">${k}</td><td class="mono">${Number(v).toFixed(3)}</td></tr>`,
                )
                .join('')}
              <tr><td class="sym">bias</td><td class="mono">${Number(model?.bias || 0).toFixed(3)}</td></tr>
              <tr><td class="sym">trainedOn</td><td class="mono">${model?.trainedOn ?? 0}</td></tr>
            </tbody>
          </table>
          <div class="widget-title" style="margin-top:16px">OPEN CALLS</div>
          ${open
            .slice(0, 6)
            .map(
              (p) => `
            <div class="pred-card">
              <h3>${p.symbol}</h3>
              <div class="pred-meta">
                <span class="pill pill-${p.direction}">${p.direction}</span>
                <span>resolve ${fmtTime(p.resolveAt)}</span>
                <span>${(p.confidence * 100).toFixed(0)}%</span>
              </div>
            </div>`,
            )
            .join('') || '<div class="empty">None open</div>'}
        </section>
      </div>
    </div>
  `;

  document.getElementById('btn-scan2')?.addEventListener('click', async () => {
    await api('/scan', { method: 'POST' });
    await refresh();
    renderAiDesk();
  });
  document.getElementById('btn-eval')?.addEventListener('click', async () => {
    await api('/evaluate', { method: 'POST' });
    await refresh();
    renderAiDesk();
  });
  document.getElementById('btn-train')?.addEventListener('click', async () => {
    await api('/train', { method: 'POST' });
    await refresh();
    renderAiDesk();
  });
}

function renderDecisions() {
  const open = state.dashboard?.openPredictions || [];
  const recent = state.dashboard?.recentResolved || [];
  root.innerHTML = `
    <div class="page">
      <div class="widget">
        <div class="widget-title">DECISIONS · OPEN</div>
        <table class="table">
          <thead><tr><th>SYMBOL</th><th>DIR</th><th>ENTRY</th><th>TARGET</th><th>CONF</th><th>REASONS</th><th>RESOLVE</th></tr></thead>
          <tbody>
            ${open
              .map(
                (p) => `
              <tr>
                <td class="sym">${p.symbol}</td>
                <td><span class="pill pill-${p.direction}">${p.direction}</span></td>
                <td class="mono">${fmtMoney(p.entryPrice)}</td>
                <td class="mono">${fmtMoney(p.targetPrice)}</td>
                <td class="mono">${(p.confidence * 100).toFixed(0)}%</td>
                <td class="muted">${escapeHtml((p.reasons || []).slice(0, 2).join('; '))}</td>
                <td class="mono dim">${fmtTime(p.resolveAt)}</td>
              </tr>`,
              )
              .join('') || '<tr><td colspan="7" class="dim">No open decisions</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="widget" style="margin-top:12px">
        <div class="widget-title">SETTLED</div>
        <table class="table">
          <thead><tr><th>SYMBOL</th><th>DIR</th><th>PRED</th><th>ACTUAL</th><th>RESULT</th></tr></thead>
          <tbody>
            ${recent
              .map(
                (p) => `
              <tr>
                <td class="sym">${p.symbol}</td>
                <td><span class="pill pill-${p.direction}">${p.direction}</span></td>
                <td class="mono ${clsPos(p.expectedMovePct)}">${fmtPct(p.expectedMovePct)}</td>
                <td class="mono ${clsPos(p.actualMovePct)}">${fmtPct(p.actualMovePct)}</td>
                <td><span class="pill pill-${p.correct ? 'hit' : 'miss'}">${p.correct ? 'HIT' : 'MISS'}</span></td>
              </tr>`,
              )
              .join('') || '<tr><td colspan="5" class="dim">Nothing settled yet — predictions resolve after the horizon</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderLogs() {
  const logs = state.dashboard?.logs || [];
  root.innerHTML = `
    <div class="page">
      <section class="widget" style="min-height:70vh">
        <div class="widget-title">LOGS</div>
        <div class="log-list">
          ${logs
            .map(
              (l) => `
            <div class="log-row ${l.level}">
              <span class="ts">${fmtTime(l.ts)}</span>
              <span class="msg">[${l.level}] ${escapeHtml(l.message)}</span>
            </div>`,
            )
            .join('') || '<div class="empty">No logs</div>'}
        </div>
      </section>
    </div>
  `;
}

function renderSettings() {
  const s = state.status?.settings || {};
  root.innerHTML = `
    <div class="page">
      <div class="notice">Trading is permanently disabled in this build. Alpaca is used for market data only.</div>
      <section class="widget">
        <div class="widget-title">SETTINGS</div>
        <form class="settings-form" id="settings-form">
          <label>Watchlist size
            <input name="watchlistSize" type="number" min="3" max="40" value="${s.watchlistSize ?? 12}" />
          </label>
          <label>Prediction horizon (hours)
            <input name="horizonHours" type="number" min="1" max="168" value="${s.horizonHours ?? 24}" />
          </label>
          <label>Auto scan
            <select name="autoScan">
              <option value="true" ${s.autoScan !== false ? 'selected' : ''}>On</option>
              <option value="false" ${s.autoScan === false ? 'selected' : ''}>Off</option>
            </select>
          </label>
          <label>Data mode
            <input value="${state.status?.dataMode || 'mock'}" disabled />
          </label>
          <button class="btn-primary" type="submit">Save</button>
        </form>
      </section>
    </div>
  `;
  document.getElementById('settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        watchlistSize: Number(fd.get('watchlistSize')),
        horizonHours: Number(fd.get('horizonHours')),
        autoScan: fd.get('autoScan') === 'true',
      }),
    });
    await refresh();
    renderSettings();
  });
}

function renderSimple(title, body) {
  root.innerHTML = `
    <div class="page">
      <section class="widget">
        <div class="widget-title">${title}</div>
        <div class="empty" style="min-height:240px">${body}</div>
      </section>
    </div>
  `;
}

function render() {
  navActive(state.page);
  switch (state.page) {
    case 'dashboard':
      renderDashboard();
      break;
    case 'market':
      renderMarket();
      break;
    case 'ai-desk':
      renderAiDesk();
      break;
    case 'strategies':
      navigateKeepStrategies();
      break;
    case 'activity':
      renderDecisions();
      break;
    case 'chat':
      renderSimple('CHAT', 'Chat with the desk coming later — use AI Desk for scans & training.');
      break;
    case 'decisions':
      renderDecisions();
      break;
    case 'logs':
      renderLogs();
      break;
    case 'settings':
      renderSettings();
      break;
    default:
      renderDashboard();
  }
}

function navigateKeepStrategies() {
  // Re-use market strategies panel feel
  root.innerHTML = `
    <div class="page">
      <section class="widget" style="max-width:520px">
        <div class="widget-title">STRATEGIES · PREDICT MODE</div>
        ${[
          { name: 'Momentum Scan', on: true },
          { name: 'RSI Extremes', on: true },
          { name: 'MACD Cross', on: true },
          { name: 'Volume Spike', on: true },
          { name: 'EMA Trend Pullback', on: true },
          { name: 'Live Trading / Order Router', on: false },
        ]
          .map(
            (s) => `
          <div class="strategy-row">
            <div>
              <div class="strategy-name"><span class="status-dot ${s.on ? 'on' : ''}"></span>${s.name}</div>
              <div class="strategy-meta">${s.on ? 'ACTIVE · feeds predictions' : 'DISABLED · no orders'}</div>
            </div>
            <div class="strategy-actions">
              <button class="btn-mini" type="button">${s.on ? 'On' : 'Off'}</button>
              <button class="btn-mini kill" type="button">Kill</button>
            </div>
          </div>`,
          )
          .join('')}
      </section>
    </div>
  `;
}

export function navigate(page) {
  state.page = page;
  window.location.hash = page;
  render();
}

async function refresh() {
  const [dashboard, status, picks, positions] = await Promise.all([
    api('/dashboard'),
    api('/status'),
    api('/ai/picks').catch(() => null),
    api('/positions').catch(() => null),
  ]);
  state.picks = picks;
  state.positions = positions;
  state.dashboard = dashboard;
  state.status = status;
  setWorkerUI(status.worker);
}

function bindChrome() {
  document.querySelectorAll('#main-nav a, .brand').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(a.dataset.nav || 'dashboard');
    });
  });

  document.getElementById('btn-stop')?.addEventListener('click', async () => {
    await api('/worker/stop', { method: 'POST' });
    await refresh();
    render();
  });
  document.getElementById('btn-kill')?.addEventListener('click', async () => {
    await api('/worker/kill', { method: 'POST' });
    await refresh();
    render();
  });
}

async function boot() {
  bindChrome();
  window.addEventListener('hashchange', () => {
    const page = (window.location.hash || '#dashboard').replace('#', '') || 'dashboard';
    state.page = page;
    render();
  });
  const hash = (window.location.hash || '#dashboard').replace('#', '');
  state.page = hash || 'dashboard';
  try {
    await refresh();
  } catch (e) {
    root.innerHTML = `<div class="page"><div class="notice">Failed to load API: ${escapeHtml(e.message)}</div></div>`;
    return;
  }
  render();
  setInterval(async () => {
    try {
      await refresh();
      if (['dashboard', 'ai-desk', 'decisions', 'activity', 'logs'].includes(state.page)) {
        render();
      } else {
        setWorkerUI(state.status?.worker);
      }
    } catch {
      /* ignore transient */
    }
  }, 20000);
}

boot();
