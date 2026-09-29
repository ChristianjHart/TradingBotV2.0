import { Router } from 'express';
import { config, credentialSource, scrubSecrets } from '../config.js';
import { store } from '../db/store.js';
import { usersRepo } from '../db/users.js';
import { asyncHandler, clientKey } from '../middleware.js';
import { loggedFetch } from '../services/http.js';
import { hashPassword, verifyPassword, dummyVerify, passwordProblem, normalizeEmail } from '../auth/crypto.js';
import { AttemptLimiter, requireUser, setSessionCookie, clearSessionCookie } from '../auth/index.js';
import { accountExists, authRequired, signupState, codeMatches, isLoopback } from '../auth/policy.js';
import { accountSummary, saveKeys, saveModels } from '../auth/accounts.js';

// Brute-force protection: per client IP and per email (10 failures / 10 min, then a doubling lockout).
export const loginByIp = new AttemptLimiter({ max: 10, windowMs: 10 * 60_000 });
export const loginByEmail = new AttemptLimiter({ max: 10, windowMs: 10 * 60_000 });
export const signupByIp = new AttemptLimiter({ max: 10, windowMs: 10 * 60_000 });

const tooMany = (res, seconds) => {
  res.set('Retry-After', String(seconds));
  return res.status(429).json({ error: 'too many attempts, try again later', code: 'rate_limited', retryAfter: seconds });
};

export const authRouter = Router();
export const accountRouter = Router();

authRouter.get('/status', (req, res) => {
  const s = signupState(req);
  const exists = accountExists();
  res.json({
    required: authRequired(),
    setupRequired: !exists,
    signupOpen: s.open,
    signupNeedsCode: s.needsCode,
    mode: exists ? 'session' : config.adminToken ? 'token' : 'none',
    user: req.auth?.user ? { email: req.auth.user.email } : null,
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
  const wait = signupByIp.retryAfter(ip);
  if (wait) return tooMany(res, wait);
  const { email: rawEmail, password, code } = req.body || {};
  if (s.needsCode && !codeMatches(code)) {
    signupByIp.fail(ip);
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
  const wait = Math.max(loginByIp.retryAfter(ip), loginByEmail.retryAfter(email));
  if (wait) return tooMany(res, wait);
  const user = typeof password === 'string' && password.length <= 200 ? usersRepo.getByEmail(email) : null;
  const ok = user ? await verifyPassword(password, user.password_hash) : await dummyVerify(String(password ?? '').slice(0, 200));
  if (!ok) {
    loginByIp.fail(ip);
    loginByEmail.fail(email);
    store.addLog({ level: 'warn', message: 'auth: failed login attempt' });
    return res.status(401).json({ error: 'invalid email or password', code: 'invalid_credentials' });
  }
  loginByEmail.success(email);
  setSessionCookie(req, res, user);
  res.json({ ok: true, user: { email: user.email } });
}));

authRouter.post('/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

authRouter.post('/logout-all', requireUser, asyncHandler(async (req, res) => {
  await usersRepo.update(req.auth.user.id, { session_version: (req.auth.user.session_version || 0) + 1 });
  clearSessionCookie(req, res);
  store.addLog({ level: 'info', message: 'auth: signed out of all sessions' });
  res.json({ ok: true });
}));

authRouter.post('/password', requireUser, asyncHandler(async (req, res) => {
  const { current, next } = req.body || {};
  const user = req.auth.user;
  const wait = loginByEmail.retryAfter(user.email);
  if (wait) return tooMany(res, wait);
  if (typeof current !== 'string' || current.length > 200 || !(await verifyPassword(current, user.password_hash))) {
    loginByEmail.fail(user.email);
    return res.status(401).json({ error: 'current password is incorrect', code: 'invalid_credentials' });
  }
  const problem = passwordProblem(next, user.email);
  if (problem) return res.status(400).json({ error: problem, code: 'weak_password' });
  const updated = await usersRepo.update(user.id, { password_hash: await hashPassword(next), session_version: (user.session_version || 0) + 1 });
  loginByEmail.success(user.email);
  setSessionCookie(req, res, updated); // this session survives; every other one is invalidated
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
