// Who may sign up, and the auth gate's view of the world.
import { config } from '../config.js';
import { usersRepo } from '../db/users.js';
import { safeEqual } from './crypto.js';

export const accountExists = () => usersRepo.count() > 0;
export const authRequired = () => accountExists() || Boolean(config.adminToken);
/** Secret that must accompany signup: SIGNUP_CODE, else ADMIN_TOKEN. */
export const signupCode = () => config.signupCode || config.adminToken || '';

/** Loopback client that did not arrive through a proxy. */
export function isLoopback(req) {
  const a = req.socket?.remoteAddress || '';
  return (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') && !req.get?.('x-forwarded-for') && !req.get?.('forwarded');
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
