import { apiOptional } from './api.js';
import { bindChrome, navActive, setWorkerUI, updateAuthUI } from './chrome.js';
import { bannersHtml, mountDashboard, patchDashboard, patchUpdated } from './dashboard.js';
import { refresh } from './data.js';
import { hydrateRun } from './run.js';
import { loadLogs, mountLogs } from './logs.js';
import { loadQuotes, mountMarket } from './market.js';
import { loadRuns, mountPerformance, patchPerformancePage } from './performance.js';
import { leftText, resetChartKey } from './positions.js';
import { isRunning, tickRun } from './run.js';
import { mountSettings } from './settings.js';
import { $, PAGES, hooks, POLL_MS, TITLES, destroyCharts, setHtml, setText, state } from './state.js';

/* ---------- routing ---------- */

export function patchCurrent() {
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
  resetChartKey();
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
  hooks.patchCurrent = patchCurrent;
  bindChrome();
  window.addEventListener('hashchange', () => {
    state.page = routeFromHash();
    render();
    $('view-root').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });
  state.page = routeFromHash();
  render();
  hydrateRun();
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

