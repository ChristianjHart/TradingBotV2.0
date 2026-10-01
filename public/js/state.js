import { escapeHtml as esc } from './api.js';

export const root = document.getElementById('view-root');
export const POLL_MS = 15000;
export const PAGES = ['dashboard', 'performance', 'market', 'logs', 'settings'];
export const TITLES = { dashboard: 'Dashboard', performance: 'Performance', market: 'Market', logs: 'Logs', settings: 'Settings' };
export const EXIT_LABEL = { 'stop-loss': 'Stop-loss', 'take-profit': 'Take-profit', 'time-exit': 'Time exit', manual: 'Manual', 'trailing-stop': 'Trailing stop' };

export const state = {
  page: 'dashboard',
  loaded: false,
  loadError: null,
  lastUpdate: null,
  status: null,
  dashboard: null,
  picks: null,
  positions: null,
  summary: null,
  perf: null,
  runs: null,
  proposals: null, // {proposals:[pending…], counts}
  history: null, // {proposals:[decided…], counts} (loaded lazily when the History tab is open)
  budget: null, // full /api/budget
  gamify: null, // /api/gamify: streaks + badges
  totw: null, // /api/trade-of-the-week
  calendar: null, // /api/calendar
  mood: null, // /api/mood
  why: {}, // proposal id -> true when its "Why this pick?" panel is open
  debateUi: {}, // proposal id -> { busy, error } for the bull/bear debate request
  debateLocal: {}, // proposal id -> debate just received (shown until the next poll carries it)
  propTab: 'pending',
  pendingBusy: {}, // proposal id -> 'approve' | 'reject'
  pendingMsg: {}, // proposal id -> {tone,title,message,actions} shown inline on the card
  settingsFocus: null, // 'account' | 'budget' | 'models' | null (scroll target after opening Settings)
  logs: null,
  auth: { required: false, mode: null, user: null, setupRequired: false, signupOpen: false, signupNeedsCode: false, guidance: '' },
  locked: false, // true while the sign-in screen is showing: polling/timers stop and no private data is kept
  account: null,
  run: null,
  runLastStage: null,
  runDismissed: null, // `${runId}:${stage}` of a blocked/error message the owner closed
  posTab: 'open',
  sort: { key: 'pnl', dir: 'desc' },
  selectedPos: null,
  tf: '1H',
  indicators: { vol: true, vwap: true, ema9: true, ema21: true },
  symbol: 'SPY',
  quotes: [],
  logFilter: 'all',
};
const PREF_KEY = 'tb_ui_prefs';
const SORT_KEYS = ['symbol', 'side', 'allocation', 'entry', 'stopLoss', 'takeProfit', 'progress', 'pnl', 'left'];
/** Persist view prefs (sort, positions tab, timeframe). Storage may be unavailable, so every access is guarded. */
export function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ sort: state.sort, posTab: state.posTab, tf: state.tf }));
  } catch {
    /* storage unavailable */
  }
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
    if (!p || typeof p !== 'object') return;
    if (p.sort && SORT_KEYS.includes(p.sort.key) && (p.sort.dir === 'asc' || p.sort.dir === 'desc')) state.sort = { key: p.sort.key, dir: p.sort.dir };
    if (p.posTab === 'open' || p.posTab === 'closed') state.posTab = p.posTab;
    if (['1H', '4H', '1D'].includes(p.tf)) state.tf = p.tf;
  } catch {
    /* ignore corrupt or unavailable storage */
  }
}
loadPrefs();

export let charts = {}; // per-page chart instances
export const barsCache = new Map();

/* ---------- small helpers ---------- */

/** Set innerHTML only when it changed; keeps scroll positions of inner scroll areas. */
export function setHtml(el, html) {
  if (!el || el.__h === html) return;
  const scrolls = [...el.querySelectorAll('.scroll-y')].map((n) => n.scrollTop);
  el.innerHTML = html;
  el.__h = html;
  el.querySelectorAll('.scroll-y').forEach((n, i) => {
    if (scrolls[i]) n.scrollTop = scrolls[i];
  });
}
export const $ = (id) => document.getElementById(id);
export const setText = (el, t) => {
  if (el && el.textContent !== t) el.textContent = t;
};
export const setCls = (el, c) => {
  if (el && el.className !== c) el.className = c;
};
export { pctOf } from './run-logic.js';
export const skeleton = (n = 3) => `<div class="skel-wrap" aria-hidden="true">${Array.from({ length: n }, () => '<div class="skeleton"></div>').join('')}</div>`;
export const empty = (msg) => `<div class="empty">${esc(msg)}</div>`;
export const nowMs = () => Date.now();

export function destroyCharts() {
  Object.values(charts).forEach((c) => c?.destroy?.());
  charts = {};
}

/** Late-bound callbacks so feature modules can trigger a re-patch without importing the router. */
export const hooks = { patchCurrent() {} };
