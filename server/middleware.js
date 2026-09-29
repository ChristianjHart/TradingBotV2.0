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

/**
 * Client key for rate limiting. Behind a reverse proxy (Render, nginx) req.ip is the proxy for every
 * visitor unless TRUST_PROXY=true; with it we use the address the trusted proxy appended to
 * X-Forwarded-For (the LAST entry; earlier entries are client-supplied and spoofable).
 */
export function clientKey(req) {
  if (config.trustProxy) {
    const xff = req.get?.('x-forwarded-for');
    const last = xff && xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.ip || 'unknown';
}

/** Warn when running behind Render / in production without TRUST_PROXY: all users would share one bucket. */
export function warnIfProxyMisconfigured(log = () => {}) {
  if (config.trustProxy) return false;
  if (!(process.env.RENDER || config.nodeEnv === 'production')) return false;
  const msg = 'TRUST_PROXY is not set: behind a proxy every client shares one rate-limit bucket (set TRUST_PROXY=true on Render)';
  console.warn(`[security] ${msg}`);
  log(msg);
  return true;
}

/**
 * Tiny fixed-window in-memory rate limiter, keyed by client IP.
 * `refundWhen(res)` (optional) gives the hit back once the response is sent, e.g. for no-op 200s.
 */
export function rateLimit({ windowMs, max, name = 'rate', refundWhen }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const key = clientKey(req);
    let h = hits.get(key);
    if (!h || h.reset <= now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
    if (++h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: `too many requests (${name})` });
    }
    if (refundWhen) res.on('finish', () => refundWhen(res) && h.n > 0 && h.n--);
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

/** Wrap an async route handler so a rejection is forwarded to the Express error middleware (never an unhandled rejection). */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve().then(() => fn(req, res, next)).catch(next);
};

/**
 * Security headers for every response (API and static). CSP allows only same-origin plus TradingView
 * (scripts/frames/connect on *.tradingview.com) and Google Fonts. Styles need 'unsafe-inline' (inline style=""
 * attributes). script-src stays strict; script-src-attr 'unsafe-inline' exists only for the font stylesheet's
 * `onload="this.media='all'"` attribute in index.html (inline <script> blocks are NOT allowed).
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://s3.tradingview.com https://*.tradingview.com",
  "script-src-attr 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://*.tradingview.com",
  "frame-src 'self' https://*.tradingview.com https://*.tradingview-widget.com",
  "connect-src 'self' https://*.tradingview.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

export function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': CSP,
  });
  next();
}

/** JSON error responses for body-parser failures and anything uncaught. */
export function errorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err);
  if (res.headersSent) return;
  res.status(status).json({ error: status === 413 ? 'request body too large' : status < 500 ? 'bad request' : 'internal error' });
}
