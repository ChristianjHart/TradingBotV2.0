import net from 'node:net';
import { config } from './config.js';

function expandV6(a) {
  let addr = a;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    addr = addr.slice(0, -dotted[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
}

/**
 * Canonical limiter key for a client address: IPv4-mapped IPv6 (::ffff:1.2.3.4) becomes plain IPv4, and every other
 * IPv6 address collapses to its /64 prefix (one subscriber can rotate through billions of addresses inside a /64).
 */
export function normalizeIp(raw) {
  let a = String(raw ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!a) return 'unknown';
  if (!net.isIPv6(a)) return a;
  const g = expandV6(a);
  if (g.length === 8 && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.length !== 8 || g.some((x) => !Number.isFinite(x))) return a;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * Client key for rate limiting. Behind a reverse proxy (Render, nginx) req.ip is the proxy for every
 * visitor unless TRUST_PROXY=true; with it we use the address the trusted proxy appended to
 * X-Forwarded-For (the LAST entry; earlier entries are client-supplied and spoofable). Normalised by normalizeIp.
 */
export function clientKey(req) {
  if (config.trustProxy) {
    const xff = req.get?.('x-forwarded-for');
    const last = xff && xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return normalizeIp(last);
  }
  return normalizeIp(req.ip);
}

/** True when the request arrived over https (directly, or via a trusted proxy that says so). */
export const isHttps = (req) => Boolean(req.secure || (config.trustProxy && /^https\b/i.test(req.get?.('x-forwarded-proto') || '')));

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
  const value = Object.create(null);
  for (const [k, v] of Object.entries(body)) {
    if (k === 'tradingEnabled' || k === 'mode' || k === 'paper') continue; // locked, silently ignored
    if (!Object.hasOwn(SETTING_RULES, k)) return { error: `unknown setting: ${k}` }; // also rejects __proto__ / constructor / prototype
    if (!SETTING_RULES[k](v)) return { error: `invalid value for ${k}` };
    value[k] = v;
  }
  return { value: { ...value } };
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

export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': CSP,
  });
  // HSTS whenever we are (or are deployed as) https-only.
  if (config.isProduction || isHttps(req)) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // API responses carry account data and session state: never cached by browsers or shared caches (ETags are off, see app.js).
  if (req.originalUrl === '/api' || req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/api?')) res.set('Cache-Control', 'no-store');
  next();
}

/**
 * Rejects (400) any JSON body carrying an own "__proto__" key at any depth. JSON.parse makes it a plain own property
 * (no pollution by itself), but a later merge/assign of the body would; we refuse it outright. Iterative (no recursion).
 */
export function rejectProtoKeys(req, res, next) {
  const stack = [req.body];
  let seen = 0;
  while (stack.length && seen++ < 20_000) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (Object.hasOwn(v, '__proto__')) return res.status(400).json({ error: 'invalid JSON body (reserved key)', code: 'bad_body' });
    for (const k of Object.keys(v)) stack.push(v[k]);
  }
  next();
}

/** JSON error responses for body-parser failures and anything uncaught. */
export function errorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err);
  if (res.headersSent) return;
  res.status(status).json({ error: status === 413 ? 'request body too large' : status < 500 ? 'bad request' : 'internal error' });
}
