import { apiOptional, clsPos, escapeHtml as esc, fmtMoney, fmtPct } from './api.js';
import { CandleChart, aggregateBars } from './charts.js';
import { getBars, tfButtonsHtml, tfClick } from './positions.js';
import { classifyApiError, toTvSymbol } from './run-logic.js';
import { $, charts, empty, root, setHtml, setText, skeleton, state } from './state.js';

/* market page */
let retryTimer = null;
let showAll = false;
let tvPromise = null;
const INDEX_SYMS = ['SPY', 'QQQ', 'IWM'];

/** Symbols the backend will serve: current picks plus open positions. */
export function trackedSymbols() {
  return [...new Set([...(state.picks?.picks || []).map((p) => p.symbol), ...(state.positions?.open || []).map((p) => p.symbol)])];
}

export function mountMarket() {
  clearTimeout(retryTimer);
  const tracked = trackedSymbols();
  if (tracked.length && !tracked.includes(state.symbol)) state.symbol = tracked[0];
  root.innerHTML = `<div class="page">
    <div id="banners"></div>
    <div class="grid grid-market">
      <section class="widget chart-custom" aria-labelledby="h-chart">
        <h2 class="widget-title" id="h-chart"><span id="chart-sym">${esc(state.symbol)}</span>${tfButtonsHtml('tf-market')}</h2>
        <div class="chart-toolbar" role="group" aria-label="Indicators">${['VOL', 'VWAP', 'EMA9', 'EMA21'].map((id) => `<button class="ind-toggle ${state.indicators[id.toLowerCase()] ? 'active' : ''}" data-ind="${id.toLowerCase()}" aria-pressed="${!!state.indicators[id.toLowerCase()]}" type="button">${id}</button>`).join('')}</div>
        <div class="chart-box tall"><canvas id="mini-chart"></canvas></div>
        <p class="chart-msg" id="chart-msg" role="status" hidden></p>
        <p class="sr-only" id="mini-chart-sum"></p>
        <div class="sr-only" id="mini-chart-table"></div>
      </section>
      <section class="widget watchlist" aria-labelledby="h-watch"><h2 class="widget-title" id="h-watch">WATCHLIST</h2>
        <label class="watch-all"><input type="checkbox" id="watch-all" /> Include index ETFs (SPY/QQQ/IWM)</label><div id="watch-body">${skeleton(4)}</div></section>
      <section class="widget tv" id="tv-widget"><div class="tv-gate" id="tv-gate"><button class="btn btn-ghost" id="tv-load" type="button">Load TradingView chart</button><span class="dim"> Loads a third-party script from tradingview.com.</span></div><div id="tv-container" class="tv-frame" hidden></div></section>
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
    if (tvShown()) mountTradingView(state.symbol);
    patchWatch();
  });
  $('watch-all').addEventListener('change', (e) => {
    showAll = e.target.checked;
    loadQuotes();
  });
  $('tv-load').addEventListener('click', () => {
    $('tv-load').disabled = true;
    mountTradingView(state.symbol);
  });
  charts.mkt = new CandleChart($('mini-chart'), { summaryEl: $('mini-chart-sum'), tableEl: $('mini-chart-table'), tableBars: 20 });
  drawMarketChart();
  loadQuotes();
}

function chartMsg(text) {
  const el = $('chart-msg');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
}

export async function drawMarketChart(force) {
  const sym = state.symbol;
  clearTimeout(retryTimer);
  try {
    const bars = await getBars(sym, force);
    if (state.symbol !== sym || !charts.mkt) return;
    chartMsg('');
    charts.mkt.set({ bars: aggregateBars(bars, state.tf), indicators: { ...state.indicators }, levels: [], markers: [], live: null, title: sym });
  } catch (e) {
    if (state.symbol !== sym || !charts.mkt) return;
    charts.mkt.set({ bars: [], title: '' });
    if (classifyApiError(e) === 'untracked') {
      chartMsg(`${sym} is not tracked — pick a symbol from the watchlist (current picks and open positions).`);
    } else {
      chartMsg(`Live data unavailable for ${sym} — retrying`);
      setText($('mini-chart-sum'), `Chart unavailable: ${e.message}`);
      retryTimer = setTimeout(() => {
        if ($('mini-chart') && state.symbol === sym) drawMarketChart(true);
      }, 15000);
    }
  }
}

export async function loadQuotes() {
  const tracked = trackedSymbols();
  const want = showAll || !tracked.length ? [...INDEX_SYMS, ...tracked.slice(0, 8)] : tracked.slice(0, 10);
  let r = await apiOptional(`/market/quotes?symbols=${encodeURIComponent([...new Set(want)].join(','))}`);
  // One untracked symbol may 400 the whole batch: fall back to tracked-only.
  if (!r && tracked.length && want.length !== tracked.slice(0, 10).length) r = await apiOptional(`/market/quotes?symbols=${encodeURIComponent(tracked.slice(0, 10).join(','))}`);
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

export { toTvSymbol };

const tvShown = () => !!$('tv-container') && !$('tv-container').hidden;

/* tv.js is loaded on demand only (never on other pages). No `integrity`: TradingView serves the same mutable
   URL (s3.tradingview.com/tv.js) with no versioned/pinned build, so an SRI hash would break on their next deploy. */
function loadTvScript() {
  if (typeof TradingView !== 'undefined') return Promise.resolve();
  tvPromise ||= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://s3.tradingview.com/tv.js';
    sc.async = true;
    sc.referrerPolicy = 'no-referrer';
    sc.onload = resolve;
    sc.onerror = () => {
      tvPromise = null;
      sc.remove();
      reject(new Error('TradingView script failed to load'));
    };
    document.head.appendChild(sc);
  });
  return tvPromise;
}

export async function mountTradingView(symbol) {
  const container = $('tv-container');
  if (!container) return;
  try {
    await loadTvScript();
    if (!$('tv-container') || typeof TradingView === 'undefined') throw new Error('TradingView unavailable');
    $('tv-gate').hidden = true;
    container.hidden = false;
    container.innerHTML = '';
    // eslint-disable-next-line no-new
    new TradingView.widget({ container_id: 'tv-container', symbol: toTvSymbol(symbol), interval: '60', timezone: 'Etc/UTC', theme: 'dark', style: '1', locale: 'en', toolbar_bg: '#15171d', enable_publishing: false, save_image: false, width: '100%', height: '100%' });
  } catch {
    const b = $('tv-load');
    if (b) {
      b.disabled = false;
      b.textContent = 'TradingView unavailable — retry';
    }
  }
}
