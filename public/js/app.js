import { gate, initAuth } from './auth.js';
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
  if (document.hidden || state.locked) return;
  try {
    await refresh();
  } catch {
    /* state.loadError is set */
  }
  if (!state.locked) patchCurrent();
}

/** Load data for the current hash route (used at boot and again after signing in). */
async function startApp() {
  state.page = routeFromHash();
  render();
  hydrateRun();
  updateAuthUI();
  try {
    await refresh();
  } catch {
    state.loaded = true; // stop skeletons; banner explains
  }
  if (state.locked) return;
  patchCurrent();
  if (state.page === 'settings') mountSettings();
}

async function boot() {
  hooks.patchCurrent = patchCurrent;
  bindChrome();
  window.addEventListener('hashchange', () => {
    if (state.locked) return; // the route is kept and restored after sign-in
    state.page = routeFromHash();
    render();
    $('view-root').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });
  initAuth({ onUnlock: startApp });
  const open = await gate(); // shows the sign-in screen (and stops here) when a login is required
  if (open) await startApp();
  pollTimer = setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });
  // 1s ticker: countdowns + run timer (paused when hidden)
  setInterval(() => {
    if (document.hidden || state.locked) return;
    document.querySelectorAll('[data-exp]').forEach((el) => {
      if (el.dataset.exp) setText(el, leftText(el.dataset.exp));
    });
    if (isRunning()) tickRun();
  }, 1000);
}

boot();

