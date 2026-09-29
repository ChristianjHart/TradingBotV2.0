import crypto from 'crypto';
import { config } from './config.js';

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Bearer-token guard. Disabled (open) when ADMIN_TOKEN is unset. */
export function requireAdmin(req, res, next) {
  const token = config.adminToken;
  if (!token) return next();
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (m && crypto.timingSafeEqual(digest(m[1]), digest(token))) return next();
  res.status(401).json({ error: 'unauthorized' });
}

/** Tiny fixed-window in-memory rate limiter, keyed by client IP. */
export function rateLimit({ windowMs, max, name = 'rate' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    let h = hits.get(key);
    if (!h || h.reset <= now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
    if (++h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: `too many requests (${name})` });
    }
    next();
  };
}

const num = (min, max) => (v) => Number.isFinite(v) && v >= min && v <= max;
const bool = (v) => typeof v === 'boolean';

/** Whitelist of user-editable settings and their validators. */
export const SETTING_RULES = {
  autoScan: bool,
  autoRun: bool,
  breakEven: bool,
  watchlistSize: (v) => Number.isInteger(v) && v >= 1 && v <= 100,
  horizonHours: num(1, 168),
  slippageBps: num(0, 200),
  feeBps: num(0, 200),
  trailR: num(0, 10),
  maxGrossPct: num(1, 100),
  maxClassPct: num(1, 100),
  maxPerGroup: (v) => Number.isInteger(v) && v >= 1 && v <= 20,
  dailyLossHaltPct: num(0, 50),
};

/** Returns { value } of accepted fields, or { error } naming the first bad/unknown one. */
export function validateSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const value = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'tradingEnabled' || k === 'mode' || k === 'paper') continue; // locked, silently ignored
    if (!SETTING_RULES[k]) return { error: `unknown setting: ${k}` };
    if (!SETTING_RULES[k](v)) return { error: `invalid value for ${k}` };
    value[k] = v;
  }
  return { value };
}

const SYMBOL_RE = /^[A-Za-z0-9.]{1,10}(\/[A-Za-z]{2,5})?$/;
export const validSymbol = (s) => SYMBOL_RE.test(s);

/** JSON error responses for body-parser failures and anything uncaught. */
export function errorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 413 ? 'request body too large' : status < 500 ? 'bad request' : 'internal error' });
}
