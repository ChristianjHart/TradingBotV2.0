import { decide401 } from './auth-logic.js';

const API = '/api';
const TOKEN_KEY = 'tb_admin_token';

// The legacy admin token lives in sessionStorage (tab-scoped, gone when the tab closes), not localStorage: an XSS or another
// tab/profile session cannot pick it up later. Any token an older version left in localStorage is deleted on first use.
function dropLegacyToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}
export function getToken() {
  dropLegacyToken();
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
export function setToken(t) {
  dropLegacyToken();
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

let unauthorizedHandler = null;
let pendingAuth = null;
/** Registered by the UI: () => Promise<string|null> (resolves to a new token, or null if cancelled). */
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

/** Registered by the auth module: called once when any request gets 401 login_required. */
let sessionEndedHandler = null;
export function onSessionEnded(fn) {
  sessionEndedHandler = fn;
}
/** Registered by the auth module: called when any request gets 503 setup_required (fresh production server, no account yet). */
let setupRequiredHandler = null;
export function onSetupRequired(fn) {
  setupRequiredHandler = fn;
}
/** 'session' | 'token' | 'setup' | | 'none' | null (unknown) — set from GET /api/auth/status. */
let authMode = null;
export function setAuthMode(m) {
  authMode = m || null;
}
export function getAuthMode() {
  return authMode;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.code = null;
    this.retryAfter = null;
  }
}

async function doFetch(path, options) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${API}${path}`, { ...options, headers });
}

/**
 * options.skipAuthRedirect: for /auth/* calls — a 401 there is a normal error (wrong password), not "session ended".
 * Never logs request bodies (they can contain passwords / API keys).
 */
export async function api(path, options = {}) {
  const { skipAuthRedirect = false, ...fetchOpts } = options;
  let res;
  try {
    res = await doFetch(path, fetchOpts);
  } catch {
    const ne = new ApiError('Cannot reach the server', 0);
    ne.network = true;
    throw ne;
  }
  let errBody = null;
  if (res.status === 401) {
    errBody = await res
      .clone()
      .json()
      .catch(() => ({}));
    const action = decide401({ code: errBody?.code, mode: authMode, skipRedirect: skipAuthRedirect });
    if (action === 'token' && unauthorizedHandler) {
      pendingAuth = pendingAuth || unauthorizedHandler().finally(() => (pendingAuth = null));
      const token = await pendingAuth;
      if (token) {
        setToken(token);
        res = await doFetch(path, fetchOpts);
        errBody = null;
      }
    } else if (action === 'login' && sessionEndedHandler) {
      try {
        sessionEndedHandler();
      } catch {
        /* handler must never break the request flow */
      }
    }
  }
  if (res.status === 503 && !skipAuthRedirect) {
    errBody = await res
      .clone()
      .json()
      .catch(() => ({}));
    if (errBody?.code === 'setup_required' && setupRequiredHandler) {
      try {
        setupRequiredHandler(errBody.error || '');
      } catch {
        /* handler must never break the request flow */
      }
    }
  }
  if (!res.ok) {
    const err = errBody || (await res.json().catch(() => ({ error: res.statusText })));
    const apiErr = new ApiError(err.error || res.statusText || `HTTP ${res.status}`, res.status);
    apiErr.data = err;
    apiErr.code = err.code || null;
    apiErr.retryAfter = res.headers.get('Retry-After');
    apiErr.stale = err.stale === true;
    throw apiErr;
  }
  return res.json();
}

/** GET that treats 404 / failure as "not available" (null). */
export async function apiOptional(path) {
  try {
    return await api(path);
  } catch {
    return null;
  }
}

export function fmtMoney(n, digits = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(n, digits = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(digits)}%`;
}

export function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  } catch {
    return String(iso);
  }
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const out = d ? `${d}d ${h}h` : h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  return neg ? `-${out}` : out;
}

export function clsPos(n) {
  if (n > 0) return 'pos';
  if (n < 0) return 'neg';
  return '';
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
