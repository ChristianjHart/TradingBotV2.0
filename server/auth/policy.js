// Who may sign up, and the auth gate's view of the world.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { usersRepo } from '../db/users.js';
import { safeEqual } from './crypto.js';

export const accountExists = () => usersRepo.count() > 0;
export const authRequired = () => accountExists() || Boolean(config.adminToken);

/**
 * Fail-closed setup: in production / on Render (or REQUIRE_SETUP=true) with no account and no ADMIN_TOKEN the API must NOT
 * be open (a wiped ephemeral disk would otherwise hand the whole dashboard to the first visitor). Everything except
 * GET /api/health and /api/auth/* answers 503 setup_required until an account exists.
 */
export const setupRequired = () => config.requireSetup && !accountExists() && !config.adminToken;

/** What the operator must do next while setup is required (names the exact env var). */
export function setupGuidance() {
  if (usersRepo.restoreState === 'pending') return 'The server is still starting (restoring accounts from Supabase). Retry in a few seconds.';
  if (usersRepo.restoreState === 'failed') {
    return 'Accounts could not be restored from Supabase at startup, so the API stays closed. Check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and that Supabase is reachable, then restart the server.';
  }
  if (!configuredCode()) return 'No owner account exists yet. SIGNUP_CODE is not set, so the server printed a one-time setup code in its log at startup: open your host\'s log viewer (Render → Logs), find the line starting "[setup] One-time setup code", and enter that code here. (Or set SIGNUP_CODE and restart.)';
  return 'No owner account exists yet. Create the owner account with the SIGNUP_CODE configured on the server.';
}

/**
 * One-time setup code. Used ONLY while no account exists and neither SIGNUP_CODE nor ADMIN_TOKEN is configured. It is printed
 * to the server's own log (never served over HTTP, never sent to /api/logs or Supabase), so only someone who can read the
 * host's logs — the operator — can claim the owner account.
 *
 * It is PERSISTED in the data dir so a sleep/wake or redeploy-on-the-same-disk keeps the same code (a code that changed on
 * every restart was impossible to use on Render's free tier). It dies the moment an account exists. The alphabet has no
 * look-alike characters (no 0/O, 1/I/L) and is compared case- and dash-insensitively.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const codeFile = () => path.join(config.dataDir, 'setup-code.json');
let bootCodeCache = '';

function makeBootCode() {
  const bytes = crypto.randomBytes(16);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-'); // XXXX-XXXX-XXXX-XXXX (16 chars, ~79 bits)
}

const normalizeCode = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function bootCode() {
  if (bootCodeCache) return bootCodeCache;
  try {
    const saved = JSON.parse(fs.readFileSync(codeFile(), 'utf8'));
    if (typeof saved?.code === 'string' && normalizeCode(saved.code).length >= 16) return (bootCodeCache = saved.code);
  } catch {
    /* none yet */
  }
  bootCodeCache = makeBootCode();
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(codeFile(), JSON.stringify({ code: bootCodeCache, createdAt: new Date().toISOString() }), { mode: 0o600 });
  } catch (err) {
    console.warn(`[setup] could not persist the setup code (${err.message}); it will change on restart`);
  }
  return bootCodeCache;
}

/** Operator-configured secret: SIGNUP_CODE, else ADMIN_TOKEN. */
export const configuredCode = () => config.signupCode || config.adminToken || '';

/** Secret that must accompany signup: the configured one, else (first run only) the one-time boot code. */
export const signupCode = () => configuredCode() || (!accountExists() ? bootCode() : '');

/** Print the one-time code (console only — deliberately NOT via store.addLog, which is served by /api/logs and mirrored to Supabase). */
export function announceSetupCode() {
  if (accountExists() || configuredCode() || usersRepo.restoreState !== 'ok') return false;
  const bar = '='.repeat(64);
  console.log(
    `\n${bar}\n[setup] No owner account exists yet and SIGNUP_CODE is not set.\n[setup] One-time setup code: ${bootCode()}\n` +
      `[setup] Enter it on the site's "Create owner account" screen (case and dashes do not matter).\n` +
      `[setup] It stays the same across restarts until an account is created, then stops working.\n${bar}\n`,
  );
  return true;
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/**
 * Loopback client that did not arrive through a proxy AND addressed the server as localhost / 127.0.0.1 / [::1]
 * (Host header check = DNS-rebinding defence: a hostile page cannot make the browser POST here under its own name).
 */
export function isLoopback(req) {
  const a = req.socket?.remoteAddress || '';
  const addr = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return addr && !req.get?.('x-forwarded-for') && !req.get?.('forwarded') && LOOPBACK_HOST.test(req.get?.('host') || '');
}

/**
 * policyOpen: signup is permitted by policy (first account, or ALLOW_SIGNUP=true).
 * needsCode: a code must be supplied. open: policy allows it AND this client may attempt it
 * (with no code configured only a loopback client may claim the first account).
 */
export function signupState(req) {
  const policyOpen = !accountExists() || config.allowSignup;
  // Loopback clients keep the code-less first-run convenience (developing on your own machine) when nothing is configured.
  const needsCode = Boolean(configuredCode()) || (Boolean(signupCode()) && !(req && isLoopback(req)));
  return { policyOpen, needsCode, open: policyOpen && (needsCode || !req || isLoopback(req)) };
}

export function codeMatches(given) {
  if (typeof given !== 'string') return false;
  const configured = configuredCode();
  if (configured) return safeEqual(given.trim(), configured);
  if (accountExists()) return false;
  // One-time boot code: tolerate case, dashes/spaces, and a pasted prefix ("[setup] One-time setup code: XXXX-...") — the
  // input still has to END with the full code, so this makes typing easier without making guessing any easier.
  const want = normalizeCode(bootCode());
  const got = normalizeCode(given);
  if (got.length < want.length) return false;
  return safeEqual(got.slice(-want.length), want);
}
