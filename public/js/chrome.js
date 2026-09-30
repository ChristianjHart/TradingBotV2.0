import { api, getToken, onUnauthorized, setToken } from './api.js';
import { openSignup, signOut, updateAccountChrome } from './auth.js';
import { revealActiveNav } from './mobile.js';
import { refresh } from './data.js';
import { mountSettings } from './settings.js';
import { hooks, $, setText, state } from './state.js';
import { confirmDialog, toast, tokenDialog } from './ui.js';

export function setWorkerUI(worker) {
  const dot = $('worker-dot');
  if (!worker || !dot) return;
  const stopped = worker.status === 'stopped' || worker.status === 'killed';
  if ($('btn-start')) $('btn-start').hidden = !stopped;
  if ($('btn-stop')) $('btn-stop').hidden = stopped;
  const label = `worker ${worker.status || 'unknown'}`;
  [['worker-dot', 'worker-label'], ['worker-dot-m', 'worker-label-m']].forEach(([d, l]) => {
    const el = $(d);
    if (!el) return;
    el.classList.remove('offline', 'warn');
    if (worker.status === 'degraded') el.classList.add('warn');
    else if (worker.status !== 'online') el.classList.add('offline');
    setText($(l), label);
  });
}

export function updateAuthUI() {
  const b = $('btn-auth');
  if (!b) return;
  updateAccountChrome();
  const firstRun = state.auth.setupRequired && state.auth.mode !== 'session';
  b.hidden = !(state.auth.required || firstRun) || state.auth.mode === 'session';
  if (firstRun && !getToken()) {
    b.textContent = 'Create account';
    b.setAttribute('aria-label', 'Create the owner account');
    return;
  }
  b.textContent = getToken() ? 'Sign out' : 'Sign in';
  b.setAttribute('aria-label', getToken() ? 'Sign out (forget admin token)' : 'Sign in with admin token');
}

onUnauthorized(async () => {
  const had = !!getToken();
  const t = await tokenDialog(had ? 'The saved admin token was rejected. Enter the correct token.' : 'This action requires the admin token configured on the server (ADMIN_TOKEN).');
  if (t) {
    state.auth.required = true;
    setTimeout(updateAuthUI, 0);
  } else {
    if (had) setToken('');
    updateAuthUI();
  }
  return t;
});

export function navActive(page) {
  document.querySelectorAll('#main-nav a').forEach((a) => {
    const on = a.dataset.nav === page;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  revealActiveNav();
}

export async function authClick() {
  if (state.auth.setupRequired && state.auth.mode !== 'session' && !getToken()) {
    openSignup();
    return;
  }
  if (getToken()) {
    setToken('');
    toast('Signed out — the admin token was removed from this browser', 'info');
  } else {
    const t = await tokenDialog();
    if (t) {
      setToken(t);
      toast('Admin token saved', 'success');
    }
  }
  updateAuthUI();
  if (state.page === 'settings') mountSettings();
}

export function bindChrome() {
  $('btn-stop').addEventListener('click', async () => {
    try {
      await api('/worker/stop', { method: 'POST', body: '{}' });
      toast('Worker stopped', 'info');
      await refresh();
      hooks.patchCurrent();
    } catch (e) {
      toast(`Stop failed: ${e.message}`, 'error');
    }
  });
  $('btn-start').addEventListener('click', async () => {
    try {
      await api('/worker/start', { method: 'POST', body: '{}' });
      toast('Worker started', 'success');
      await refresh();
      hooks.patchCurrent();
    } catch (e) {
      toast(`Start failed: ${e.message}`, 'error');
    }
  });
  $('btn-kill').addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Kill the worker?', message: 'This halts all scan and monitoring cycles until the worker is restarted.', confirmText: 'Kill worker', danger: true }))) return;
    try {
      await api('/worker/kill', { method: 'POST', body: '{}' });
      toast('Worker killed — all cycles halted', 'warn');
      await refresh();
      hooks.patchCurrent();
    } catch (e) {
      toast(`Kill failed: ${e.message}`, 'error');
    }
  });
  $('btn-auth').addEventListener('click', authClick);
  $('btn-signout').addEventListener('click', (e) => signOut(e.currentTarget));
}
