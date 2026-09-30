// Who may sign up, and the auth gate's view of the world.
import crypto from 'node:crypto';
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
 * One-time setup code, random per process start. Used ONLY while no account exists and neither SIGNUP_CODE nor ADMIN_TOKEN
 * is configured: it is printed to the server's own log (never stored, never served over HTTP), so only someone who can read
 * the host's logs — the operator — can claim the owner account. It changes on every restart and dies once an account exists.
 */
const bootSetupCode = crypto.randomBytes(12).toString('base64url');

/** Operator-configured secret: SIGNUP_CODE, else ADMIN_TOKEN. */
export const configuredCode = () => config.signupCode || config.adminToken || '';

/** Secret that must accompany signup: the configured one, else (first run only) the one-time boot code. */
export const signupCode = () => configuredCode() || (!accountExists() ? bootSetupCode : '');

/** Print the one-time code (console only — deliberately NOT via store.addLog, which is served by /api/logs and mirrored to Supabase). */
export function announceSetupCode() {
  if (accountExists() || configuredCode() || usersRepo.restoreState !== 'ok') return false;
  const bar = '='.repeat(64);
  console.log(`\n${bar}\n[setup] No owner account exists yet and SIGNUP_CODE is not set.\n[setup] One-time setup code: ${bootSetupCode}\n[setup] Enter it on the site's "Create owner account" screen. It changes on every restart and stops working once an account exists.\n${bar}\n`);
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

export const codeMatches = (given) => Boolean(signupCode()) && typeof given === 'string' && safeEqual(given, signupCode());
