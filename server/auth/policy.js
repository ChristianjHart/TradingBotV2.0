// Who may sign up, and the auth gate's view of the world.
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
  if (!signupCode()) return 'No owner account exists yet and no sign-up code is configured. Set the SIGNUP_CODE environment variable on the server (a long random secret) and restart, then create the owner account here with that code.';
  return 'No owner account exists yet. Create the owner account with the SIGNUP_CODE configured on the server.';
}

/** Secret that must accompany signup: SIGNUP_CODE, else ADMIN_TOKEN. */
export const signupCode = () => config.signupCode || config.adminToken || '';

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
  const needsCode = Boolean(signupCode());
  return { policyOpen, needsCode, open: policyOpen && (needsCode || !req || isLoopback(req)) };
}

export const codeMatches = (given) => Boolean(signupCode()) && typeof given === 'string' && safeEqual(given, signupCode());
