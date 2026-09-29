import { api, escapeHtml as esc, onSessionEnded, onSetupRequired, setAuthMode } from './api.js';
import { authErrorMessage, canSignUp, initialAuthView, isSetupMode, needsAuthScreen, passwordStrength, retryAfterSeconds, shortEmail, validateLogin, validateSignup } from './auth-logic.js';
import { barsCache, destroyCharts, root, state } from './state.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);
let screen = null; // #auth-root
let view = 'signin';
let onUnlock = () => {};
let countdown = null;

/* ---------- status ---------- */

/** GET /api/auth/status; returns null when the endpoint is missing (older server) so the app degrades to legacy behaviour. */
export async function loadAuthStatus() {
  try {
    const s = await api('/auth/status', { skipAuthRedirect: true });
    Object.assign(state.auth, {
      required: !!s.required,
      mode: s.mode || (s.required ? 'token' : 'none'),
      user: s.user && s.user.email ? { email: String(s.user.email) } : null,
      setupRequired: !!s.setupRequired,
      signupOpen: !!s.signupOpen,
      signupNeedsCode: !!s.signupNeedsCode,
      guidance: typeof s.guidance === 'string' ? s.guidance : '',
    });
    setAuthMode(state.auth.mode);
    return s;
  } catch {
    setAuthMode(null);
    return null;
  }
}

export function updateAccountChrome() {
  const email = $('acct-email');
  const out = $('btn-signout');
  const on = state.auth.mode === 'session' && !!state.auth.user;
  if (email) {
    email.hidden = !on;
    email.textContent = on ? shortEmail(state.auth.user.email) : '';
    if (on) email.title = state.auth.user.email;
  }
  if (out) out.hidden = !on;
}

/* ---------- lock / unlock ---------- */

/** Replace the app with the auth screen, dropping everything private that is in memory or on screen. */
export function lock(reason = '') {
  if (state.locked) return;
  state.locked = true;
  // wipe private state + rendered DOM
  Object.assign(state, { loaded: false, loadError: null, status: null, dashboard: null, picks: null, positions: null, summary: null, perf: null, runs: null, logs: null, run: null, runLastStage: null, runLocal: null, account: null, selectedPos: null, quotes: [] });
  state.auth.user = null;
  barsCache.clear();
  try {
    destroyCharts();
  } catch {
    /* ignore */
  }
  root.innerHTML = '';
  root.__h = undefined;
  document.querySelectorAll('.modal-backdrop').forEach((n) => n.remove());
  document.querySelectorAll('.toasts').forEach((n) => (n.innerHTML = ''));
  const app = $('app');
  if (app) {
    app.hidden = true;
    app.removeAttribute('inert');
  }
  updateAccountChrome();
  mountScreen(reason);
}

function unlock() {
  state.locked = false;
  stopCountdown();
  if (screen) {
    screen.remove();
    screen = null;
  }
  document.body.classList.remove('auth-mode');
  const app = $('app');
  if (app) app.hidden = false;
  updateAccountChrome();
  document.title = 'Dashboard · tradingbot';
  onUnlock();
}

export function initAuth(cb) {
  onUnlock = cb.onUnlock;
  onSessionEnded(() => lock('Your session has ended — sign in to continue.'));
  // Any call answered 503 setup_required (fresh production server, no account): same screen as the boot-time gate, with the server's guidance.
  onSetupRequired(async (message) => {
    await loadAuthStatus();
    if (!isSetupMode(state.auth)) state.auth.mode = 'setup';
    view = 'signup';
    if (message) state.auth.guidance = message; // the server's own guidance (names the env var to set), shown in the form
    if (state.locked) {
      mountScreen('');
      return;
    }
    lock('');
  });
}

/** Boot-time decision: show the auth screen or let the app start. Returns true when the app may start. */
export async function gate() {
  const s = await loadAuthStatus();
  if (!s) return true;
  if (needsAuthScreen(state.auth)) {
    view = initialAuthView(state.auth);
    lock(isSetupMode(state.auth) ? '' : state.auth.setupRequired ? 'Welcome — create the owner account to get started.' : '');
    return false;
  }
  updateAccountChrome();
  return true;
}

export async function signOut(btn) {
  if (btn) btn.disabled = true;
  try {
    await api('/auth/logout', { method: 'POST', body: '{}', skipAuthRedirect: true });
  } catch (e) {
    if (e.code !== 'login_required' && e.status !== 401) {
      toast(`Could not sign out: ${e.message}`, 'error');
      if (btn) btn.disabled = false;
      return;
    }
  }
  if (btn) btn.disabled = false;
  await loadAuthStatus();
  view = 'signin';
  lock('You have been signed out.');
}

/** Open the create-owner-account screen from the open (no account yet) dashboard. */
export function openSignup() {
  view = 'signup';
  lock('');
}

/** Leave the auth screen and keep using the open dashboard (only offered while no login is enforced). */
export function continueWithoutAccount() {
  if (isSetupMode(state.auth)) return; // fail-closed setup: the account must be created first
  unlock();
}

/** After password change / sign-out-everywhere. */
export function forceLock(reason) {
  view = 'signin';
  lock(reason);
}

/* ---------- screen ---------- */

function stopCountdown() {
  if (countdown) clearInterval(countdown);
  countdown = null;
}

function eyeBtn(target) {
  return `<button type="button" class="pw-toggle" data-toggle="${target}" aria-pressed="false" aria-controls="${target}" aria-label="Show password">Show</button>`;
}

function field({ id, label, type = 'text', auto, extra = '', hint = '', pw = false, inputmode = '' }) {
  return `<div class="af">
    <label for="${id}">${label}</label>
    <div class="af-wrap"><input id="${id}" name="${id}" type="${type}" autocomplete="${auto}" ${inputmode ? `inputmode="${inputmode}"` : ''} spellcheck="false" autocapitalize="none" ${extra} aria-describedby="${id}-err${hint ? ` ${id}-hint` : ''}" />${pw ? eyeBtn(id) : ''}</div>
    ${hint ? `<div class="af-hint" id="${id}-hint">${hint}</div>` : ''}
    <div class="af-err" id="${id}-err" aria-live="polite"></div></div>`;
}

function signinHtml() {
  return `<form id="f-signin" novalidate aria-labelledby="auth-h">
    ${field({ id: 'si-email', label: 'Email', type: 'email', auto: 'username', extra: 'required', inputmode: 'email' })}
    ${field({ id: 'si-pw', label: 'Password', type: 'password', auto: 'current-password', extra: 'required', pw: true })}
    <button class="auth-submit" type="submit"><span class="spin" aria-hidden="true" hidden></span><span class="lbl">Sign in</span></button>
  </form>`;
}

function signupHtml() {
  const a = state.auth;
  return `<form id="f-signup" novalidate aria-labelledby="auth-h">
    ${isSetupMode(a) && a.guidance ? `<p class="auth-note" id="setup-guidance" role="note">${esc(a.guidance)}</p>` : ''}
    <p class="auth-note">${a.setupRequired ? 'No account exists yet. <strong>The first account becomes the owner</strong> of this dashboard and holds its API keys.' : 'This dashboard has a single owner account. Creating one requires the setup code configured on the server.'}</p>
    ${field({ id: 'su-email', label: 'Email', type: 'email', auto: 'username', extra: 'required', inputmode: 'email' })}
    ${field({ id: 'su-pw', label: 'Password', type: 'password', auto: 'new-password', extra: 'required minlength="10"', pw: true, hint: 'At least 10 characters. A long passphrase is best.' })}
    <div class="strength" id="su-strength" aria-live="polite"><div class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i></div><span id="su-strength-txt">Use at least 10 characters.</span></div>
    ${field({ id: 'su-pw2', label: 'Confirm password', type: 'password', auto: 'new-password', extra: 'required', pw: true })}
    ${a.signupNeedsCode ? field({ id: 'su-code', label: 'Setup code', type: 'password', auto: 'off', extra: 'required', hint: 'This is the <code>SIGNUP_CODE</code> value set in the server environment.' }) : ''}
    <button class="auth-submit" type="submit"><span class="spin" aria-hidden="true" hidden></span><span class="lbl">Create account</span></button>
  </form>`;
}

function mountScreen(reason) {
  document.body.classList.add('auth-mode');
  if (!screen) {
    screen = document.createElement('div');
    screen.id = 'auth-root';
    document.body.appendChild(screen);
  }
  const signup = canSignUp(state.auth);
  if (view === 'signup' && !signup) view = 'signin';
  const isSignup = view === 'signup';
  document.title = `${isSignup ? 'Create account' : 'Sign in'} · tradingbot`;
  screen.innerHTML = `<main class="auth-card" aria-labelledby="auth-h">
    <div class="auth-brand" aria-hidden="true">tradingbot</div>
    <h1 id="auth-h" tabindex="-1">${isSignup ? 'Create owner account' : 'Sign in'}</h1>
    <p class="auth-sub">${isSignup ? 'Paper trading only — no orders are ever sent.' : 'Sign in to view your paper-trading dashboard.'}</p>
    <div class="auth-msg" id="auth-msg" role="alert"></div>
    <div class="auth-info" id="auth-info" role="status">${esc(reason || '')}</div>
    ${isSignup ? signupHtml() : signinHtml()}
    <div class="auth-alt">${
      isSignup
        ? state.auth.setupRequired
          ? ''
          : '<button type="button" class="linklike" id="auth-toggle">Already have an account? Sign in</button>'
        : signup
          ? '<button type="button" class="linklike" id="auth-toggle">Need an account? Create one</button>'
          : '<span class="auth-note">Accounts are closed. To allow creating one, the server owner must set <code>SIGNUP_CODE</code> in the server environment and restart.</span>'
    }</div>
    ${state.auth.mode !== 'session' && !isSetupMode(state.auth) ? '<div class="auth-alt"><button type="button" class="linklike" id="auth-skip">Continue without an account (open dashboard)</button></div>' : ''}
  </main>`;
  wire();
  const first = screen.querySelector('input');
  if (first) first.focus({ preventScroll: true });
}

function setBusy(form, busy) {
  const b = form.querySelector('.auth-submit');
  b.disabled = busy;
  b.setAttribute('aria-busy', busy ? 'true' : 'false');
  b.querySelector('.spin').hidden = !busy;
  b.querySelector('.lbl').textContent = busy ? (form.id === 'f-signup' ? 'Creating…' : 'Signing in…') : form.id === 'f-signup' ? 'Create account' : 'Sign in';
  form.querySelectorAll('input').forEach((i) => (i.readOnly = busy));
}

function showFieldErrors(form, errs, map) {
  let firstBad = null;
  Object.entries(map).forEach(([key, id]) => {
    const input = $(id);
    const msg = errs[key] || '';
    $(`${id}-err`).textContent = msg;
    if (msg) {
      input.setAttribute('aria-invalid', 'true');
      firstBad = firstBad || input;
    } else input.removeAttribute('aria-invalid');
  });
  if (firstBad) firstBad.focus();
  return !!firstBad;
}

function showMsg(text) {
  const m = $('auth-msg');
  if (m) m.textContent = text || '';
  const i = $('auth-info');
  if (i && text) i.textContent = '';
}

function startCountdown(form, err, ctx) {
  stopCountdown();
  let left = retryAfterSeconds(err.retryAfter);
  if (!left) return;
  const b = form.querySelector('.auth-submit');
  const tick = () => {
    if (left <= 0) {
      stopCountdown();
      showMsg('');
      b.disabled = false;
      return;
    }
    showMsg(authErrorMessage({ status: 429, retryAfter: left }, ctx));
    b.disabled = true;
    left -= 1;
  };
  tick();
  countdown = setInterval(tick, 1000);
}

async function submit(form, ctx, path, body, errMap) {
  showMsg('');
  setBusy(form, true);
  try {
    await api(path, { method: 'POST', body: JSON.stringify(body), skipAuthRedirect: true });
  } catch (e) {
    setBusy(form, false);
    if (e.status === 429) {
      startCountdown(form, e, ctx);
      return;
    }
    showMsg(authErrorMessage(e, ctx));
    if (e.code === 'invalid_credentials') {
      const pw = $(errMap.password);
      if (pw) {
        pw.value = '';
        pw.focus();
      }
    }
    return;
  }
  // success: never keep credentials in the DOM
  form.querySelectorAll('input').forEach((i) => (i.value = ''));
  const s = await loadAuthStatus();
  if (!s || !state.auth.user) {
    setBusy(form, false);
    showMsg('Signed in, but the session cookie was not accepted. Check that cookies are enabled and reload the page.');
    return;
  }
  unlock();
}

function wire() {
  $('auth-skip')?.addEventListener('click', () => continueWithoutAccount());
  const t = $('auth-toggle');
  if (t)
    t.addEventListener('click', () => {
      view = view === 'signup' ? 'signin' : 'signup';
      stopCountdown();
      mountScreen('');
      $('auth-h').focus();
    });
  screen.querySelectorAll('.pw-toggle').forEach((b) =>
    b.addEventListener('click', () => {
      const input = $(b.dataset.toggle);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
      b.setAttribute('aria-pressed', String(show));
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    })
  );
  const si = $('f-signin');
  if (si)
    si.addEventListener('submit', (e) => {
      e.preventDefault();
      if (si.querySelector('.auth-submit').disabled) return;
      const v = { email: $('si-email').value.trim(), password: $('si-pw').value };
      const errs = validateLogin(v);
      if (showFieldErrors(si, errs, { email: 'si-email', password: 'si-pw' })) return;
      submit(si, 'login', '/auth/login', v, { password: 'si-pw' });
    });
  const su = $('f-signup');
  if (su) {
    const pw = $('su-pw');
    pw.addEventListener('input', () => {
      const s = passwordStrength(pw.value, $('su-email')?.value.trim() || '');
      const box = $('su-strength');
      box.dataset.score = String(s.score);
      $('su-strength-txt').textContent = s.label ? `${s.label}. ${s.hint}` : s.hint;
    });
    su.addEventListener('submit', (e) => {
      e.preventDefault();
      if (su.querySelector('.auth-submit').disabled) return;
      const v = { email: $('su-email').value.trim(), password: pw.value, confirm: $('su-pw2').value, code: $('su-code')?.value.trim() || '' };
      const errs = validateSignup(v, { needsCode: state.auth.signupNeedsCode });
      const map = { email: 'su-email', password: 'su-pw', confirm: 'su-pw2' };
      if (state.auth.signupNeedsCode) map.code = 'su-code';
      if (showFieldErrors(su, errs, map)) return;
      const body = { email: v.email, password: v.password };
      if (state.auth.signupNeedsCode) body.code = v.code;
      submit(su, 'signup', '/auth/signup', body, { password: 'su-pw' });
    });
  }
}
