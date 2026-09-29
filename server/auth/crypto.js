// Password hashing, secret encryption and signed session tokens (node:crypto only). Nothing here logs.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { passwordRuleProblem } from '../../public/js/password-rules.js';

const scrypt = promisify(crypto.scrypt);
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ---- passwords ----
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${b64u(salt)}$${b64u(dk)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, n, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64url');
    const dk = await scrypt(password, Buffer.from(salt, 'base64url'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
    return dk.length === want.length && crypto.timingSafeEqual(dk, want);
  } catch {
    return false;
  }
}

let dummyHash;
/** Burns the same scrypt time as a real check (unknown email) so timing does not reveal which emails exist. */
export async function dummyVerify(password) {
  dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(password, dummyHash);
  return false;
}

/**
 * Returns an error message, or null when the password is acceptable: 10-200 chars, not on the embedded common-password
 * blocklist, no repeating / sequential / keyboard patterns, and it must not contain the email's local part.
 * The rules live in public/js/password-rules.js so the browser's strength meter applies the same checks.
 */
export function passwordProblem(password, email = '') {
  return passwordRuleProblem(password, email);
}

export function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

// ---- encryption of stored API keys (AES-256-GCM, key = scrypt(APP_SECRET, fixed salt)) ----
const KEY_SALT = 'tradingbot-v2/api-keys/v1';
const keyCache = new Map();
function encKey(secret) {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.scryptSync(secret, KEY_SALT, 32);
    keyCache.set(secret, k);
    if (keyCache.size > 8) keyCache.delete(keyCache.keys().next().value);
  }
  return k;
}

/** Keys can only be stored when a real APP_SECRET is configured (the ephemeral boot secret would lose them on restart). */
export const encryptionReady = () => Boolean(config.appSecret);

export function encryptValue(plain, secret = config.appSecret) {
  if (!secret) throw Object.assign(new Error('APP_SECRET is not configured'), { code: 'encryption_not_configured' });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(secret), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { v: 1, iv: b64u(iv), tag: b64u(c.getAuthTag()), data: b64u(data) };
}

/** Throws when the secret is wrong or the value was tampered with. */
export function decryptValue(blob, secret = config.appSecret) {
  if (!secret) throw new Error('APP_SECRET is not configured');
  if (!blob || blob.v !== 1) throw new Error('unsupported encrypted value');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(secret), Buffer.from(blob.iv, 'base64url'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(blob.data, 'base64url')), d.final()]).toString('utf8');
}

// ---- session tokens ----
export const COOKIE_NAME = 'tb_session';
export const SESSION_TTL_S = 14 * 24 * 3600;
// Without APP_SECRET, sessions are signed with a random per-boot secret (they reset on restart).
const ephemeralSecret = crypto.randomBytes(32).toString('hex');
export const signingSecret = () => config.appSecret || ephemeralSecret;

const mac = (body, secret) => b64u(crypto.createHmac('sha256', secret).update(body).digest());

export function signToken(payload, secret = signingSecret()) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${mac(body, secret)}`;
}

/** Returns the payload of a genuine, unexpired token; otherwise null. */
export function verifyToken(token, secret = signingSecret()) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(mac(body, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    // sid (random per session) is required: tokens without one (pre-revocation cookies) are simply invalid and force a fresh login.
    return p && typeof p.uid === 'string' && typeof p.sid === 'string' && p.sid.length >= 16 && Number.isInteger(p.sv) && Number(p.exp) > Math.floor(Date.now() / 1000) ? p : null;
  } catch {
    return null;
  }
}

/** New session token: {uid, sv (account-wide version), sid (this session, revocable on logout), exp}. */
export const issueToken = (user) =>
  signToken({ uid: user.id, sv: user.session_version || 0, sid: crypto.randomBytes(16).toString('base64url'), exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S });

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Constant-time string compare (via fixed-length digests). */
export function safeEqual(a, b) {
  const d = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(d(a), d(b));
}
