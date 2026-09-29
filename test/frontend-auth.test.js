import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authErrorMessage, buildKeyPayload, canSignUp, decide401, formatLast4, initialAuthView, isValidEmail, keyStatus,
  needsAuthScreen, passwordStrength, retryAfterSeconds, safeRoute, shortEmail, validateLogin, validateModel,
  validatePassword, validatePasswordChange, validateSignup,
} from '../public/js/auth-logic.js';

test('email validation accepts normal addresses and rejects junk', () => {
  assert.equal(isValidEmail('a.b+c@example.co'), true);
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', '@x.com', 'a@@x.com', null, `${'x'.repeat(250)}@a.com`]) assert.equal(isValidEmail(bad), false, String(bad));
});

test('password minimum length is 10', () => {
  assert.match(validatePassword('123456789'), /at least 10/);
  assert.equal(validatePassword('1234567890a'), null);
  assert.match(validatePassword('x'.repeat(201)), /too long/);
});

test('password strength: short is never above 1, long mixed is strong, common is flagged', () => {
  assert.equal(passwordStrength('').score, 0);
  const short = passwordStrength('Aa1!Aa1!');
  assert.equal(short.score, 1);
  assert.match(short.hint, /2 more characters/);
  assert.equal(passwordStrength('mypassword123').label, 'Too common');
  assert.equal(passwordStrength('aaaaaaaaaaaa').label, 'Too common');
  assert.equal(passwordStrength('correct-Horse-battery-9').score, 4);
  assert.ok(passwordStrength('lowercaseonly').score >= 2);
});

test('signup validation reports each field and requires the code only when asked', () => {
  const ok = { email: 'o@x.io', password: 'a-long-passphrase', confirm: 'a-long-passphrase' };
  assert.deepEqual(validateSignup(ok), {});
  assert.deepEqual(Object.keys(validateSignup({ ...ok, confirm: 'different-one' })), ['confirm']);
  assert.deepEqual(Object.keys(validateSignup({ email: 'x', password: 'short', confirm: '' })).sort(), ['email', 'password']);
  assert.ok(validateSignup(ok, { needsCode: true }).code);
  assert.deepEqual(validateSignup({ ...ok, code: ' abc ' }, { needsCode: true }), {});
});

test('login and password-change validation', () => {
  assert.deepEqual(Object.keys(validateLogin({ email: '', password: '' })).sort(), ['email', 'password']);
  assert.deepEqual(validateLogin({ email: 'a@b.co', password: 'x' }), {});
  assert.ok(validatePasswordChange({ current: 'old', next: 'old', confirm: 'old' }).next);
  assert.ok(validatePasswordChange({ current: '', next: 'a-long-passphrase', confirm: 'a-long-passphrase' }).current);
  assert.ok(validatePasswordChange({ current: 'old', next: 'a-long-passphrase', confirm: 'nope' }).confirm);
  assert.deepEqual(validatePasswordChange({ current: 'old', next: 'a-long-passphrase', confirm: 'a-long-passphrase' }), {});
});

test('formatLast4 only ever exposes four alphanumerics', () => {
  assert.equal(formatLast4('abcd'), '…abcd');
  assert.equal(formatLast4('sk-or-v1-SECRETWXYZ'), '…WXYZ');
  assert.equal(formatLast4('ab-!'), '…ab');
  assert.equal(formatLast4(''), '');
  assert.equal(formatLast4(null), '');
});

test('keyStatus derives label, tone and consequence', () => {
  const acct = keyStatus('openrouter', { set: true, source: 'account', last4: 'abcd' });
  assert.deepEqual([acct.tone, acct.label], ['ok', 'Saved on your account · ends …abcd']);
  const env = keyStatus('alpaca', { set: true, source: 'env', keyLast4: 'wxyz', secretSet: true });
  assert.deepEqual([env.tone, env.label], ['warn', 'Using server env fallback · ends …wxyz']);
  const none = keyStatus('alpaca', { set: false, source: 'none' });
  assert.equal(none.label, 'Not set');
  assert.match(none.consequence, /mock data/);
  assert.match(keyStatus('openrouter', undefined).consequence, /rule-based/);
  assert.equal(keyStatus('alpaca', { set: false, source: 'account', keyLast4: 'abcd', secretSet: false }).tone, 'warn');
});

test('buildKeyPayload trims, validates and never sends blanks', () => {
  assert.deepEqual(buildKeyPayload('openrouter', { openrouterKey: '  sk-or-v1-abcdef  ' }).payload, { openrouterKey: 'sk-or-v1-abcdef' });
  assert.ok(buildKeyPayload('openrouter', { openrouterKey: '' }).errors.openrouterKey);
  assert.ok(buildKeyPayload('openrouter', { openrouterKey: 'has space inside' }).errors.openrouterKey);
  const half = buildKeyPayload('alpaca', { alpacaKey: 'PKABCDEFGH', alpacaSecret: '' });
  assert.deepEqual(half.payload, {});
  assert.ok(half.errors.alpacaSecret);
  assert.deepEqual(buildKeyPayload('alpaca', { alpacaKey: 'PKABCDEFGH', alpacaSecret: 'sssssssss' }).payload, { alpacaKey: 'PKABCDEFGH', alpacaSecret: 'sssssssss' });
});

test('model id validation', () => {
  assert.equal(validateModel('anthropic/claude-3.5-sonnet'), null);
  assert.equal(validateModel('meta-llama/llama-3.1-70b-instruct:free'), null);
  for (const bad of ['', 'gpt4', 'a/', '/b', 'has space/x', 'x'.repeat(101)]) assert.ok(validateModel(bad), bad);
});

test('error codes map to specific messages', () => {
  assert.equal(authErrorMessage({ status: 401, code: 'invalid_credentials' }, 'login'), 'Incorrect email or password.');
  assert.match(authErrorMessage({ status: 401, code: 'invalid_credentials' }, 'password'), /Current password/);
  assert.match(authErrorMessage({ status: 403, code: 'signup_disabled' }), /SIGNUP_CODE/);
  assert.match(authErrorMessage({ status: 403, code: 'csrf' }), /cross-site/);
  assert.equal(authErrorMessage({ status: 409, code: 'encryption_not_configured' }), 'Server needs APP_SECRET before keys can be saved.');
  assert.match(authErrorMessage({ status: 0, network: true }), /Cannot reach/);
  assert.match(authErrorMessage({ status: 404 }), /not support accounts/);
  assert.equal(authErrorMessage({ status: 400, message: 'Password too short' }), 'Password too short');
  assert.match(authErrorMessage({ status: 500 }), /server had a problem/);
});

test('429 shows a retry countdown, clamped and sanitised', () => {
  assert.equal(authErrorMessage({ status: 429, retryAfter: '30' }), 'Too many attempts — try again in 30 s.');
  assert.match(authErrorMessage({ status: 429, retryAfter: null }), /wait a moment/);
  assert.equal(retryAfterSeconds('2.2'), 3);
  assert.equal(retryAfterSeconds('99999'), 3600);
  assert.equal(retryAfterSeconds('-5'), null);
  assert.equal(retryAfterSeconds('abc'), null);
});

test('401 handling decision', () => {
  assert.equal(decide401({ code: 'login_required', mode: 'session' }), 'login');
  assert.equal(decide401({ code: 'login_required', mode: null }), 'login');
  assert.equal(decide401({ code: 'invalid_credentials', mode: 'session' }), 'error');
  assert.equal(decide401({ code: 'login_required', mode: 'session', skipRedirect: true }), 'error');
  assert.equal(decide401({ mode: 'token' }), 'token');
  assert.equal(decide401({ mode: 'none' }), 'error');
  assert.equal(decide401({ error: 'unauthorized' }), 'token'); // legacy server, unknown mode
});

test('auth screen gating from /api/auth/status', () => {
  assert.equal(needsAuthScreen({ mode: 'session', user: null }), true);
  assert.equal(needsAuthScreen({ mode: 'session', user: { email: 'a@b.co' } }), false);
  assert.equal(needsAuthScreen({ mode: 'token', required: true, user: null }), false);
  assert.equal(needsAuthScreen(null), false);
  assert.equal(initialAuthView({ setupRequired: true }), 'signup');
  assert.equal(initialAuthView({ setupRequired: false, signupOpen: true }), 'signin');
  assert.equal(canSignUp({ signupOpen: true }), true);
  assert.equal(canSignUp({ signupOpen: false, setupRequired: false }), false);
});

test('safeRoute only restores known pages; shortEmail keeps the domain', () => {
  const pages = ['dashboard', 'settings'];
  assert.equal(safeRoute('#settings', pages), 'settings');
  assert.equal(safeRoute('#//evil.com', pages), 'dashboard');
  assert.equal(safeRoute('', pages), 'dashboard');
  assert.equal(shortEmail('me@x.io'), 'me@x.io');
  const s = shortEmail('averyveryverylongaddress.name@example.com', 24);
  assert.ok(s.length <= 24 && s.endsWith('@example.com') && s.includes('…'));
});
