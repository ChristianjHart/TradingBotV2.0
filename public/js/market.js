import { apiOptional, clsPos, escapeHtml as esc, fmtMoney, fmtPct } from './api.js';
import { CandleChart, aggregateBars } from './charts.js';
import { getBars, tfButtonsHtml, tfClick } from './positions.js';
import { $, charts, empty, root, setHtml, setText, skeleton, state } from './state.js';

/* market page */
export function mountMarket() {
  root.innerHTML = `<div class="page">
    <div id="banners"></div>
    <div class="grid grid-market">
      <section class="widget chart-custom" aria-labelledby="h-chart">
        <h2 class="widget-title" id="h-chart"><span id="chart-sym">${esc(state.symbol)}</span>${tfButtonsHtml('tf-market')}</h2>
        <div class="chart-toolbar" role="group" aria-label="Indicators">${['VOL', 'VWAP', 'EMA9', 'EMA21'].map((id) => `<button class="ind-toggle ${state.indicators[id.toLowerCase()] ? 'active' : ''}" data-ind="${id.toLowerCase()}" aria-pressed="${!!state.indicators[id.toLowerCase()]}" type="button">${id}</button>`).join('')}</div>
        <div class="chart-box tall"><canvas id="mini-chart"></canvas></div>
        <p class="sr-only" id="mini-chart-sum"></p>
        <div class="sr-only" id="mini-chart-table"></div>
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
  charts.mkt = new CandleChart($('mini-chart'), { summaryEl: $('mini-chart-sum'), tableEl: $('mini-chart-table'), tableBars: 20 });
  drawMarketChart();
  loadQuotes();
  mountTradingView(state.symbol);
}

export async function drawMarketChart() {
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

export async function loadQuotes() {
  const syms = ['SPY', 'QQQ', 'IWM', ...(state.picks?.picks || []).slice(0, 6).map((p) => p.symbol)];
  const r = await apiOptional(`/market/quotes?symbols=${encodeURIComponent([...new Set(syms)].join(','))}`);
  state.quotes = r?.quotes || state.quotes;
  patchWatch();
}
export function patchWatch() {
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

export function toTvSymbol(symbol) {
  if (symbol.includes('/')) {
    const [base, quote] = symbol.split('/');
    return `BINANCE:${base}${quote === 'USD' ? 'USDT' : quote}`;
  }
  return symbol;
}
export function mountTradingView(symbol) {
  const container = $('tv-container');
  if (!container || typeof TradingView === 'undefined') return;
  $('tv-widget').hidden = false;
  container.innerHTML = '';
  // eslint-disable-next-line no-new
  new TradingView.widget({ container_id: 'tv-container', symbol: toTvSymbol(symbol), interval: '60', timezone: 'Etc/UTC', theme: 'dark', style: '1', locale: 'en', toolbar_bg: '#15171d', enable_publishing: false, save_image: false, width: '100%', height: '100%' });
}
