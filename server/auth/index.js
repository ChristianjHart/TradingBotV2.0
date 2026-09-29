// Request-level auth: resolves the caller (session cookie or Bearer ADMIN_TOKEN), CSRF guard, gate, brute-force limiter.
import { config } from '../config.js';
import { usersRepo } from '../db/users.js';
import { COOKIE_NAME, SESSION_TTL_S, verifyToken, issueToken, parseCookies, safeEqual } from './crypto.js';
import { authRequired, setupRequired, setupGuidance } from './policy.js';
import { sessionsRepo } from '../db/sessions.js';
import { isHttps } from '../middleware.js';

/** Sets req.auth = {mode:'session', user} | {mode:'token', user:null} | null. Never throws. */
export function resolveAuth(req, _res, next) {
  req.auth = null;
  const tok = verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  if (tok) {
    const user = usersRepo.getById(tok.uid);
    if (user && (user.session_version || 0) === tok.sv && !sessionsRepo.isRevoked(tok.sid)) req.auth = { mode: 'session', user, sid: tok.sid };
  }
  if (!req.auth && config.adminToken) {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (m && safeEqual(m[1], config.adminToken)) req.auth = { mode: 'token', user: null };
  }
  next();
}

/**
 * Fail-closed first run: in production (see setupRequired) with no account and no ADMIN_TOKEN, everything except
 * GET /api/health and /api/auth/* answers 503 setup_required (mounted just before authGate).
 */
export function setupGuard(req, res, next) {
  if (!setupRequired()) return next();
  res.status(503).json({ error: setupGuidance(), code: 'setup_required' });
}

/** Everything under /api except GET /api/health and /api/auth/* needs a session or the admin token (once auth is required). */
export function authGate(req, res, next) {
  if (!authRequired() || req.auth) return next();
  res.status(401).json({ error: 'unauthorized', code: 'login_required' });
}

export function requireUser(req, res, next) {
  if (req.auth?.user) return next();
  res.status(401).json({ error: 'unauthorized', code: 'login_required' });
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie auth (on top of SameSite=Lax): state-changing requests must be JSON (or carry X-Requested-With),
 * and an Origin header, when present, must match Host (or CORS_ORIGIN). Requests authenticated by an explicit
 * Authorization header cannot be forged cross-site, so they skip the content-type rule.
 */
export function csrfGuard(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const deny = (why) => res.status(403).json({ error: `request blocked (${why})`, code: 'csrf' });
  const origin = req.get('origin');
  if (origin) {
    let ok = origin === config.corsOrigin;
    if (!ok) {
      try {
        ok = new URL(origin).host === req.get('host');
      } catch {
        ok = false;
      }
    }
    if (!ok) return deny('cross-origin');
  }
  const json = /^application\/json\b/i.test(req.get('content-type') || '');
  const hasBearer = /^Bearer /.test(req.get('authorization') || '');
  if (!json && !req.get('x-requested-with') && !hasBearer) return deny('use application/json');
  next();
}

// Always Secure when deployed (NODE_ENV=production / RENDER) regardless of TRUST_PROXY or x-forwarded-proto; otherwise only over https.
const secureFlag = (req) => (config.isProduction || isHttps(req) ? '; Secure' : '');

export function setSessionCookie(req, res, user) {
  res.append('Set-Cookie', `${COOKIE_NAME}=${issueToken(user)}; Path=/; Max-Age=${SESSION_TTL_S}; HttpOnly; SameSite=Lax${secureFlag(req)}`);
}

export function clearSessionCookie(req, res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureFlag(req)}`);
}

/** The genuine, unexpired token in the request's session cookie (or null). Does not check revocation. */
export const cookieToken = (req) => verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);

/**
 * Failure counter with lockout backoff, keyed by string. After `max` failures in `windowMs` the key is locked for
 * lockMs * 2^(strikes-1), never longer than maxLockMs (locks always expire: nothing is permanent), and success() clears it.
 * Strikes decay after `decayMs` of quiet. Memory is bounded: at most maxKeys entries, least recently failed evicted first.
 * State is in-memory only: a process restart clears every limiter.
 */
export class AttemptLimiter {
  constructor({ max = 10, windowMs = 10 * 60_000, lockMs = 60_000, maxLockMs = 15 * 60_000, maxKeys = 10_000, decayMs = 60 * 60_000 } = {}) {
    Object.assign(this, { max, windowMs, lockMs, maxLockMs, maxKeys, decayMs });
    this.map = new Map();
  }
  /** Seconds to wait if locked, else 0. */
  retryAfter(key) {
    const e = this.map.get(key);
    return e && e.lockedUntil > Date.now() ? Math.ceil((e.lockedUntil - Date.now()) / 1000) : 0;
  }
  fail(key) {
    const now = Date.now();
    let e = this.map.get(key);
    if (!e || (e.reset <= now && e.lockedUntil <= now)) {
      const stale = !e || now - e.last > this.decayMs;
      e = { n: 0, reset: now + this.windowMs, strikes: stale ? 0 : e.strikes, lockedUntil: 0, last: now };
    }
    e.last = now;
    this.map.delete(key);
    this.map.set(key, e); // most recently failed = last in insertion order (LRU)
    while (this.map.size > this.maxKeys) this.map.delete(this.map.keys().next().value);
    if (++e.n >= this.max) {
      e.strikes++;
      e.n = 0;
      e.lockedUntil = now + Math.min(this.maxLockMs, this.lockMs * 2 ** (e.strikes - 1));
      e.reset = e.lockedUntil + this.windowMs;
    }
  }
  success(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

/**
 * Escalating DELAY (never a lock) by failure count for one key, e.g. all failed logins for one email from any IP.
 * Below `free` failures there is no delay; then base * 2^(n-free-1) ms, capped at maxMs. Bounded and in-memory like above.
 */
export class DelayTracker {
  constructor({ free = 3, baseMs = 250, maxMs = 5000, windowMs = 10 * 60_000, maxKeys = 10_000 } = {}) {
    Object.assign(this, { free, baseMs, maxMs, windowMs, maxKeys });
    this.map = new Map();
  }
  delayMs(key) {
    const e = this.map.get(key);
    if (!e || e.reset <= Date.now() || e.n <= this.free) return 0;
    return Math.min(this.maxMs, this.baseMs * 2 ** (e.n - this.free - 1));
  }
  fail(key) {
    const now = Date.now();
    let e = this.map.get(key);
    if (!e || e.reset <= now) e = { n: 0, reset: 0 };
    e.n++;
    e.reset = now + this.windowMs;
    this.map.delete(key);
    this.map.set(key, e);
    while (this.map.size > this.maxKeys) this.map.delete(this.map.keys().next().value);
  }
  success(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}
