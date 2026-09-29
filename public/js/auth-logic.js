/* Pure, DOM-free auth/account logic (unit-tested in test/frontend-auth.test.js). Never handles or logs secrets beyond validating shape. */

export const MIN_PASSWORD = 10;
const COMMON = ['password', 'passw0rd', '1234567890', 'qwertyuiop', 'letmein', 'iloveyou', 'administrator', 'tradingbot'];

export function isValidEmail(email) {
  const e = String(email ?? '').trim();
  return e.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(e);
}

/** Strength 0-4 with a short hint. Length is the main factor; a short password can never score above 1. */
export function passwordStrength(pw) {
  const p = String(pw ?? '');
  if (!p) return { score: 0, label: '', hint: `Use at least ${MIN_PASSWORD} characters.` };
  if (p.length < MIN_PASSWORD) return { score: 1, label: 'Too short', hint: `${MIN_PASSWORD - p.length} more character${MIN_PASSWORD - p.length === 1 ? '' : 's'} needed (minimum ${MIN_PASSWORD}).` };
  const lower = p.toLowerCase();
  if (COMMON.some((c) => lower.includes(c)) || /^(.)\1+$/.test(p)) return { score: 1, label: 'Too common', hint: 'Avoid common words and repeated characters.' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  let score = 2;
  if (p.length >= 14 && classes >= 2) score = 3;
  if (p.length >= 16 && classes >= 3) score = 4;
  else if (classes >= 3 && p.length >= 12) score = Math.max(score, 3);
  const label = ['', 'Weak', 'Okay', 'Good', 'Strong'][score];
  return { score, label, hint: score >= 3 ? 'Nice — hard to guess.' : 'Longer passphrases or mixing character types make it stronger.' };
}

export function validatePassword(pw) {
  const p = String(pw ?? '');
  if (p.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (p.length > 200) return 'Password is too long (200 characters max).';
  return null;
}

/** Returns {field: message} — empty object when valid. */
export function validateSignup({ email, password, confirm, code }, { needsCode = false } = {}) {
  const errs = {};
  if (!isValidEmail(email)) errs.email = 'Enter a valid email address.';
  const pe = validatePassword(password);
  if (pe) errs.password = pe;
  else if (password !== confirm) errs.confirm = 'Passwords do not match.';
  if (needsCode && !String(code ?? '').trim()) errs.code = 'Enter the setup code (SIGNUP_CODE) configured on the server.';
  return errs;
}

export function validateLogin({ email, password }) {
  const errs = {};
  if (!isValidEmail(email)) errs.email = 'Enter a valid email address.';
  if (!password) errs.password = 'Enter your password.';
  return errs;
}

export function validatePasswordChange({ current, next, confirm }) {
  const errs = {};
  if (!current) errs.current = 'Enter your current password.';
  const pe = validatePassword(next);
  if (pe) errs.next = pe;
  else if (next === current) errs.next = 'The new password must differ from the current one.';
  else if (next !== confirm) errs.confirm = 'Passwords do not match.';
  return errs;
}

/** Only ever the last 4 alphanumerics of whatever the server sent, shown as "…abcd". */
export function formatLast4(v) {
  const s = String(v ?? '').replace(/[^A-Za-z0-9]/g, '');
  return s ? `…${s.slice(-4)}` : '';
}

const CONSEQUENCE = {
  openrouter: 'OpenRouter not set → rule-based bots (no AI).',
  alpaca: 'Alpaca not set → mock data (synthetic prices).',
};

/**
 * Chip descriptor for a key group from GET /api/account `keys`.
 * kind: 'openrouter' | 'alpaca'. Returns {tone:'ok'|'warn'|'off', label, consequence, source, set}.
 */
export function keyStatus(kind, group) {
  const g = group || {};
  const last = formatLast4(kind === 'alpaca' ? g.keyLast4 : g.last4);
  const ends = last ? ` · ends ${last}` : '';
  const partial = kind === 'alpaca' && g.set === false && g.source === 'account' && !g.secretSet;
  if (g.set && g.source === 'account') return { tone: 'ok', label: `Saved on your account${ends}`, consequence: '', source: 'account', set: true };
  if (g.set && g.source === 'env') return { tone: 'warn', label: `Using server env fallback${ends}`, consequence: 'Saving a key here overrides the server .env value.', source: 'env', set: true };
  if (partial) return { tone: 'warn', label: 'Incomplete — secret missing', consequence: CONSEQUENCE.alpaca, source: 'account', set: false };
  return { tone: 'off', label: 'Not set', consequence: CONSEQUENCE[kind] || '', source: 'none', set: false };
}

/** Build PUT /api/account/keys payload from trimmed form values; returns {payload, errors}. Empty fields are omitted (never send blanks). */
export function buildKeyPayload(kind, values) {
  const errors = {};
  const payload = {};
  const clean = (s) => String(s ?? '').trim();
  if (kind === 'openrouter') {
    const k = clean(values.openrouterKey);
    if (!k) errors.openrouterKey = 'Paste your OpenRouter API key.';
    else if (/\s/.test(k) || k.length < 8) errors.openrouterKey = 'That does not look like an API key (no spaces, at least 8 characters).';
    else payload.openrouterKey = k;
  } else {
    const k = clean(values.alpacaKey);
    const s = clean(values.alpacaSecret);
    if (!k) errors.alpacaKey = 'Enter the Alpaca key ID.';
    else if (/\s/.test(k) || k.length < 8) errors.alpacaKey = 'Key ID looks too short or contains spaces.';
    if (!s) errors.alpacaSecret = 'Enter the Alpaca secret key.';
    else if (/\s/.test(s) || s.length < 8) errors.alpacaSecret = 'Secret looks too short or contains spaces.';
    if (!Object.keys(errors).length) Object.assign(payload, { alpacaKey: k, alpacaSecret: s });
  }
  return { payload, errors };
}

/** OpenRouter model ids look like "vendor/model[:variant]". */
export function validateModel(name) {
  const m = String(name ?? '').trim();
  if (!m) return 'Enter a model id (for example anthropic/claude-3.5-sonnet).';
  if (m.length > 100) return 'Model id is too long.';
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:+-]*$/i.test(m)) return 'Use the OpenRouter form vendor/model, e.g. openai/gpt-4o-mini.';
  return null;
}

export function retryAfterSeconds(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.ceil(n), 3600);
  return null;
}

/**
 * Map an API failure to a user-facing message. `err` = {status, code, message, retryAfter}.
 * context: 'login' | 'signup' | 'password' | 'keys' | 'test' | 'generic'
 */
export function authErrorMessage(err, context = 'generic') {
  const e = err || {};
  if (e.status === 429) {
    const s = retryAfterSeconds(e.retryAfter);
    return s ? `Too many attempts — try again in ${s} s.` : 'Too many attempts — please wait a moment and try again.';
  }
  switch (e.code) {
    case 'invalid_credentials':
      return context === 'password' ? 'Current password is incorrect.' : 'Incorrect email or password.';
    case 'signup_disabled':
      return 'Sign-up is disabled on this server. The server owner must set SIGNUP_CODE (and restart) to allow creating an account.';
    case 'csrf':
      return 'The request was blocked as cross-site. Reload the page and try again from the same address you normally use.';
    case 'encryption_not_configured':
      return 'Server needs APP_SECRET before keys can be saved.';
    case 'login_required':
      return 'Your session has ended — please sign in again.';
    case 'invalid_code':
    case 'invalid_signup_code':
      return 'That setup code is not correct.';
    case 'email_taken':
      return 'An account with that email already exists. Try signing in.';
    default:
  }
  if (e.status === 0 || e.network) return 'Cannot reach the server. Check your connection and try again.';
  if (e.status === 404) return 'This server does not support accounts yet (endpoint not found).';
  if (e.status >= 500) return 'The server had a problem. Try again shortly.';
  return e.message ? String(e.message) : 'Something went wrong. Please try again.';
}

/**
 * What should api() do with a 401?  -> 'login' (drop to the auth screen), 'token' (legacy bearer dialog), 'error' (surface).
 * `skipRedirect` is set for the auth endpoints themselves (a wrong password must not bounce to the login screen).
 */
export function decide401({ code, mode, skipRedirect = false } = {}) {
  if (skipRedirect) return 'error';
  if (code === 'login_required') return 'login';
  if (mode === 'session') return 'error';
  if (mode === 'none') return 'error';
  return 'token';
}

/** Should the SPA show the auth screen given GET /api/auth/status? */
export function needsAuthScreen(status) {
  if (!status || typeof status !== 'object') return false;
  if (status.mode === 'session') return !status.user;
  return false;
}

/** Which tab is offered first on the auth screen. */
export function initialAuthView(status) {
  const s = status || {};
  if (s.setupRequired) return 'signup';
  return 'signin';
}

export function canSignUp(status) {
  const s = status || {};
  return !!(s.setupRequired || s.signupOpen);
}

/** Only same-app hash routes are restored after login (no open redirects). */
export function safeRoute(hash, pages) {
  const p = String(hash ?? '').replace(/^#/, '');
  return pages.includes(p) ? p : 'dashboard';
}

/** Truncate an email for the header while keeping the domain visible. */
export function shortEmail(email, max = 24) {
  const e = String(email ?? '');
  if (e.length <= max) return e;
  const at = e.lastIndexOf('@');
  if (at < 1) return `${e.slice(0, max - 1)}…`;
  const dom = e.slice(at);
  const keep = Math.max(3, max - dom.length - 1);
  return `${e.slice(0, keep)}…${dom}`;
}
