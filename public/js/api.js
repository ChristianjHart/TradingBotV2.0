const API = '/api';
const TOKEN_KEY = 'tb_admin_token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
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

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function doFetch(path, options) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${API}${path}`, { ...options, headers });
}

export async function api(path, options = {}) {
  let res = await doFetch(path, options);
  if (res.status === 401 && unauthorizedHandler) {
    pendingAuth = pendingAuth || unauthorizedHandler().finally(() => (pendingAuth = null));
    const token = await pendingAuth;
    if (token) {
      setToken(token);
      res = await doFetch(path, options);
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const apiErr = new ApiError(err.error || res.statusText || `HTTP ${res.status}`, res.status);
    apiErr.data = err;
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
