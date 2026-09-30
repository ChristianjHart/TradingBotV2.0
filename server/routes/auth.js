import { Router } from 'express';
import { config, credentialSource, scrubSecrets } from '../config.js';
import { store } from '../db/store.js';
import { usersRepo } from '../db/users.js';
import { asyncHandler, clientKey } from '../middleware.js';
import { loggedFetch } from '../services/http.js';
import { hashPassword, verifyPassword, dummyVerify, passwordProblem, normalizeEmail } from '../auth/crypto.js';
import { AttemptLimiter, DelayTracker, requireUser, setSessionCookie, clearSessionCookie, cookieToken } from '../auth/index.js';
import { sessionsRepo } from '../db/sessions.js';
import { accountExists, authRequired, signupState, codeMatches, isLoopback, setupRequired, setupGuidance } from '../auth/policy.js';
import { accountSummary, saveKeys, saveModels } from '../auth/accounts.js';

// Brute-force protection (all in-memory: a process restart clears every counter and lock; locks are also always temporary).
//  - loginByPair: failures per (email, client IP) PAIR: 10 / 10 min, then a doubling lock capped at 15 min. It is never keyed by
//    email alone, so someone who merely knows the owner's email cannot lock the owner out from a different address.
//  - loginByIp: password-spray guard, much higher (60 failures / 10 min across all emails), lock capped at 10 min.
//  - loginEmailDelay: failures for one email from ANY address only add a growing DELAY (250 ms doubling, max 5 s) to that
//    email's login attempts; it never rejects, so the correct password still succeeds from a fresh IP during an attack.
//  - passwordBySession: /auth/password guesses are counted per (user id, session id), so login noise never blocks a live session.
//  - signupByIp / signupGlobal: wrong sign-up codes, per IP and in total (a botnet cannot brute-force SIGNUP_CODE).
export const loginByPair = new AttemptLimiter({ max: 10, windowMs: 10 * 60_000, lockMs: 60_000, maxLockMs: 15 * 60_000, maxKeys: 20_000 });
export const loginByIp = new AttemptLimiter({ max: 60, windowMs: 10 * 60_000, lockMs: 60_000, maxLockMs: 10 * 60_000 });
export const loginEmailDelay = new DelayTracker({ free: 3, baseMs: 250, maxMs: 5000 });
export const passwordBySession = new AttemptLimiter({ max: 10, windowMs: 10 * 60_000, lockMs: 60_000, maxLockMs: 15 * 60_000 });
export const signupByIp = new AttemptLimiter({ max: 10, windowMs: 10 * 60_000 });
export const signupGlobal = new AttemptLimiter({ max: 30, windowMs: 60 * 60_000, lockMs: 5 * 60_000, maxLockMs: 30 * 60_000, maxKeys: 4 });
const loginInflight = new Map(); // ip -> concurrent login attempts (a burst cannot slip past the counters while verifications are pending)
const MAX_INFLIGHT = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Test hook: forget every limiter. */
export function resetAuthLimiters() {
  for (const l of [loginByPair, loginByIp, loginEmailDelay, passwordBySession, signupByIp, signupGlobal]) l.clear();
  loginInflight.clear();
}

const tooMany = (res, seconds) => {
  res.set('Retry-After', String(seconds));
  return res.status(429).json({ error: 'too many attempts, try again later', code: 'rate_limited', retryAfter: seconds });
};

export const authRouter = Router();
export const accountRouter = Router();

authRouter.get('/status', (req, res) => {
  const s = signupState(req);
  const exists = accountExists();
  // First run (no account yet) always shows the create-account screen when the API is gated, whether it is gated
  // by fail-closed production setup or by an ADMIN_TOKEN — otherwise the browser only ever sees a token prompt.
  const setup = setupRequired() || (!exists && Boolean(config.adminToken));
  res.json({
    required: authRequired() || setup,
    setupRequired: !exists,
    signupOpen: s.open,
    signupNeedsCode: s.needsCode,
    mode: setup ? 'setup' : exists ? 'session' : 'none',
    user: req.auth?.user ? { email: req.auth.user.email } : null,
    ...(setup ? { guidance: setupRequired() ? setupGuidance() : 'No owner account exists yet. Create it here — the setup code is your SIGNUP_CODE (or your ADMIN_TOKEN if SIGNUP_CODE is not set).' } : {}),
  });
});

authRouter.post('/signup', asyncHandler(async (req, res) => {
  const ip = clientKey(req);
  const s = signupState(req);
  if (!s.policyOpen) {
    return res.status(403).json({ error: 'sign-up is disabled: an account already exists (the server owner can set ALLOW_SIGNUP=true)', code: 'signup_disabled' });
  }
  if (!s.needsCode && !isLoopback(req)) {
    return res.status(403).json({
      error: 'sign-up is disabled for remote clients: set SIGNUP_CODE (or ADMIN_TOKEN) on the server, or create the account from the server machine (localhost)',
      code: 'signup_disabled',
    });
  }
  if (!accountExists() && usersRepo.restoreState !== 'ok') {
    // Supabase account restore pending/failed: the "no account" state may be a false negative; never mint a second owner.
    return res.status(503).json({ error: setupGuidance(), code: 'accounts_unavailable' });
  }
  const wait = Math.max(signupByIp.retryAfter(ip), s.needsCode ? signupGlobal.retryAfter('all') : 0);
  if (wait) return tooMany(res, wait);
  const { email: rawEmail, password, code } = req.body || {};
  if (s.needsCode && !codeMatches(code)) {
    console.warn(`[setup] sign-up rejected: the setup code did not match (${typeof code === 'string' ? code.trim().length : 0} characters entered)`);
    signupByIp.fail(ip);
    signupGlobal.fail('all');
    return res.status(403).json({ error: 'invalid sign-up code', code: 'invalid_signup_code' });
  }
  const email = normalizeEmail(rawEmail);
  if (!email) return res.status(400).json({ error: 'enter a valid email address', code: 'invalid_email' });
  const problem = passwordProblem(password, email);
  if (problem) return res.status(400).json({ error: problem, code: 'weak_password' });
  const passwordHash = await hashPassword(password);
  if (accountExists() && !config.allowSignup) return res.status(403).json({ error: 'sign-up is disabled: an account already exists', code: 'signup_disabled' });
  let user;
  try {
    user = await usersRepo.create({ email, passwordHash });
  } catch (err) {
    if (err.code === 'email_taken') return res.status(409).json({ error: 'that email is already registered', code: 'email_taken' });
    throw err;
  }
  store.addLog({ level: 'info', message: 'auth: account created' });
  setSessionCookie(req, res, user);
  res.json({ ok: true, user: { email: user.email } });
}));

authRouter.post('/login', asyncHandler(async (req, res) => {
  const ip = clientKey(req);
  const { email: rawEmail, password } = req.body || {};
  const email = normalizeEmail(rawEmail) || String(rawEmail ?? '').slice(0, 254).toLowerCase();
  const pair = `${email}|${ip}`;
  const wait = Math.max(loginByPair.retryAfter(pair), loginByIp.retryAfter(ip));
  if (wait) return tooMany(res, wait);
  if ((loginInflight.get(ip) || 0) >= MAX_INFLIGHT) return tooMany(res, 1);
  loginInflight.set(ip, (loginInflight.get(ip) || 0) + 1);
  try {
    const delay = loginEmailDelay.delayMs(email);
    if (delay) await sleep(delay); // pressure on this email from anywhere slows every attempt for it, but never blocks the right password
    const user = typeof password === 'string' && password.length <= 200 ? usersRepo.getByEmail(email) : null;
    const ok = user ? await verifyPassword(password, user.password_hash) : await dummyVerify(String(password ?? '').slice(0, 200));
    if (!ok) {
      loginByPair.fail(pair);
      loginByIp.fail(ip);
      loginEmailDelay.fail(email);
      store.addLog({ level: 'warn', message: 'auth: failed login attempt' });
      return res.status(401).json({ error: 'invalid email or password', code: 'invalid_credentials' });
    }
    loginByPair.success(pair);
    loginEmailDelay.success(email);
    setSessionCookie(req, res, user);
    res.json({ ok: true, user: { email: user.email } });
  } finally {
    const n = (loginInflight.get(ip) || 1) - 1;
    if (n > 0) loginInflight.set(ip, n);
    else loginInflight.delete(ip);
  }
}));

// Logout revokes THIS session server-side (its random sid is remembered until the token would have expired); other
// sessions of the same account stay valid. /auth/logout-all still bumps session_version to end every session.
authRouter.post('/logout', (req, res) => {
  const tok = cookieToken(req);
  if (tok) sessionsRepo.revoke(tok.sid, tok.exp, tok.uid);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

authRouter.post('/logout-all', requireUser, asyncHandler(async (req, res) => {
  await usersRepo.update(req.auth.user.id, { session_version: (req.auth.user.session_version || 0) + 1 });
  clearSessionCookie(req, res);
  store.addLog({ level: 'info', message: 'auth: signed out of all sessions' });
  res.json({ ok: true });
}));

// A live session is not subject to the login limiters (an attacker hammering the login form cannot block the owner here);
// guesses of the current password are only counted against this very (user, session).
authRouter.post('/password', requireUser, asyncHandler(async (req, res) => {
  const { current, next } = req.body || {};
  const user = req.auth.user;
  const key = `${user.id}:${req.auth.sid}`;
  const wait = passwordBySession.retryAfter(key);
  if (wait) return tooMany(res, wait);
  if (typeof current !== 'string' || current.length > 200 || !(await verifyPassword(current, user.password_hash))) {
    passwordBySession.fail(key);
    return res.status(401).json({ error: 'current password is incorrect', code: 'invalid_credentials' });
  }
  const problem = passwordProblem(next, user.email);
  if (problem) return res.status(400).json({ error: problem, code: 'weak_password' });
  const updated = await usersRepo.update(user.id, { password_hash: await hashPassword(next), session_version: (user.session_version || 0) + 1 });
  passwordBySession.success(key);
  setSessionCookie(req, res, updated); // this session survives (new sid); every other one is invalidated
  store.addLog({ level: 'info', message: 'auth: password changed' });
  res.json({ ok: true });
}));

// ---- account (behind the gate) ----
accountRouter.get('/', (req, res) => res.json(accountSummary(req.auth?.user)));

accountRouter.put('/keys', asyncHandler(async (req, res) => {
  const r = await saveKeys(req.body);
  if (!r.ok) return res.status(r.status).json({ error: r.error, ...(r.code ? { code: r.code } : {}) });
  res.json(accountSummary(req.auth?.user));
}));

accountRouter.put('/models', asyncHandler(async (req, res) => {
  const r = await saveModels(req.body);
  if (!r.ok) return res.status(r.status).json({ error: r.error, ...(r.code ? { code: r.code } : {}) });
  res.json(accountSummary(req.auth?.user));
}));

accountRouter.post('/test', asyncHandler(async (req, res) => {
  const service = req.body?.service;
  if (service !== 'openrouter' && service !== 'alpaca') return res.status(400).json({ error: "service must be 'openrouter' or 'alpaca'" });
  const src = credentialSource()[service];
  if (src === 'none') return res.json({ ok: false, message: 'no key configured' });
  const label = service === 'openrouter' ? 'OpenRouter' : 'Alpaca';
  try {
    const r =
      service === 'openrouter'
        ? await loggedFetch('openrouter', `${config.openrouter.baseUrl}/auth/key`, {
            headers: { Authorization: `Bearer ${config.openrouter.key}` },
            signal: AbortSignal.timeout(10_000),
          })
        : await loggedFetch('alpaca', `${config.alpaca.baseUrl}/v2/account`, {
            headers: { 'APCA-API-KEY-ID': config.alpaca.key, 'APCA-API-SECRET-KEY': config.alpaca.secret },
            signal: AbortSignal.timeout(10_000),
          });
    if (r.ok) return res.json({ ok: true, message: `${label} accepted the ${src === 'account' ? 'account' : 'environment'} key` });
    const hint = r.status === 401 || r.status === 403 ? 'key rejected' : 'unexpected response';
    return res.json({ ok: false, message: `${label}: ${hint} (HTTP ${r.status})` });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return res.json({ ok: false, message: timedOut ? `${label}: request timed out` : `${label}: could not connect (${scrubSecrets(err.message).slice(0, 80)})` });
  }
}));
