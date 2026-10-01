import { gate, initAuth } from './auth.js';
import { bindChrome, navActive, setWorkerUI, updateAuthUI } from './chrome.js';
import { bannersHtml, mountDashboard, patchDashboard, patchUpdated } from './dashboard.js';
import { refresh } from './data.js';
import { hydrateRun } from './run.js';
import { loadLogs, mountLogs } from './logs.js';
import { initMobile } from './mobile.js';
import { patchBudgetCard, patchBudgetChip } from './budget.js';
import { loadQuotes, mountMarket } from './market.js';
import { applyBadge, tickProposals } from './proposals.js';
import { loadRuns, mountPerformance, patchPerformancePage } from './performance.js';
import { leftText, resetChartKey } from './positions.js';
import { isRunning, tickRun } from './run.js';
import { applySettingsFocus, mountSettings } from './settings.js';
import { jumpTo } from './ui.js';
import { bindMood, patchMood } from './mood.js';
import { $, PAGES, hooks, POLL_MS, TITLES, destroyCharts, setHtml, setText, state } from './state.js';

/* ---------- routing ---------- */

export function patchCurrent() {
  patchUpdated();
  setWorkerUI(state.status?.worker);
  applyBadge();
  patchBudgetChip();
  patchMood();
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
    case 'settings':
      patchBudgetCard();
      break;
    default:
  }
}

function render() {
  destroyCharts();
  resetChartKey();
  navActive(state.page);
  applyBadge();
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

/** `#settings/models` -> {page:'settings', sub:'models'}; unknown pages fold into the dashboard. */
function parseHash() {
  const [p, sub] = (window.location.hash || '#dashboard').replace('#', '').split('/');
  const page = PAGES.includes(p) ? p : 'dashboard'; // retired pages (ai-desk, decisions, chat…) fold into the dashboard
  return { page, sub: page === 'settings' && sub ? sub : null };
}
function routeFromHash() {
  const { page, sub } = parseHash();
  state.settingsFocus = sub;
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
  bindMood();
  initMobile();
  window.addEventListener('hashchange', () => {
    if (state.locked) return; // the route is kept and restored after sign-in
    const before = state.page;
    state.page = routeFromHash();
    if (state.page === 'settings' && before === 'settings') return applySettingsFocus(); // same page: just scroll to the section
    render();
    $('view-root').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });
  // in-page jumps (toasts, run bar, summary): data-jump="element-id"; from another page go to the dashboard first
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('[data-jump]');
    if (!a) return;
    e.preventDefault();
    const id = a.dataset.jump;
    if (state.page === 'dashboard') return void jumpTo(id);
    window.location.hash = '#dashboard';
    setTimeout(() => jumpTo(id), 450);
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
    tickProposals();
  }, 1000);
}

boot();

