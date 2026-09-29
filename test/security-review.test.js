// Regression tests for the independent security review (H1, M1, M2, L1-L7).
import './setup.js';
import fs from 'fs';
import http from 'http';
import path from 'path';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const { config, applyCredentials } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const { usersRepo } = await import('../server/db/users.js');
const { sessionsRepo } = await import('../server/db/sessions.js');
const AR = await import('../server/routes/auth.js');
const { loginByPair, loginByIp, loginEmailDelay, signupGlobal, passwordBySession, resetAuthLimiters } = AR;
const { AttemptLimiter, DelayTracker } = await import('../server/auth/index.js');
const { normalizeIp, clientKey, warnIfProxyMisconfigured } = await import('../server/middleware.js');
const C = await import('../server/auth/crypto.js');
const { isLoopback } = await import('../server/auth/policy.js');
const { passwordRuleProblem, BLOCKLIST_SIZE } = await import('../public/js/password-rules.js');
const L = await import('../public/js/auth-logic.js');

const realFetch = globalThis.fetch;
const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
after(() => {
  server.close();
  fs.rmSync(path.join(config.dataDir, 'users.json'), { force: true });
  fs.rmSync(path.join(config.dataDir, 'revoked-sessions.json'), { force: true });
});

const PW = 'correct-horse-battery';
const OWNER = 'owner@x.io';

async function call(method, url, { body, cookie, headers = {}, raw } = {}) {
  const r = await realFetch(`${base}/api${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  const sc = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('tb_session='));
  return { status: r.status, body: json, headers: r.headers, setCookie: sc, cookie: sc ? sc.split(';')[0] : null };
}
const from = (ip) => ({ 'x-forwarded-for': ip });
const signup = (email = OWNER, extra = {}) => call('POST', '/auth/signup', { body: { email, password: PW, ...extra } });
const login = (ip, password, email = OWNER) => call('POST', '/auth/login', { body: { email, password }, headers: from(ip) });

const ENV_KEYS = ['NODE_ENV', 'RENDER', 'REQUIRE_SETUP', 'SIGNUP_CODE', 'ALLOW_SIGNUP'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  usersRepo._reset();
  sessionsRepo._reset();
  resetAuthLimiters();
  Object.assign(loginEmailDelay, { baseMs: 1, maxMs: 5 });
  config.trustProxy = false;
  config.adminToken = '';
  process.env.APP_SECRET = 'test-app-secret-0123456789abcdef';
  applyCredentials({ openrouterKey: '', alpacaKey: '', alpacaSecret: '' });
});
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
});

// ------------------------------------------------------------------ H1
test('H1: 30 wrong logins for the owner from IP A never stop a correct login from IP B; A recovers after the backoff window', async () => {
  await signup();
  config.trustProxy = true;
  let limited = 0;
  for (let i = 0; i < 30; i++) {
    const r = await login('198.51.100.1', `wrong-password-${i}`);
    assert.ok([401, 429].includes(r.status));
    if (r.status === 429) limited++;
  }
  assert.ok(limited > 0, 'the attacker pair itself is throttled');
  assert.ok(loginEmailDelay.delayMs(OWNER) > 0 || loginEmailDelay.map.get(OWNER).n >= 10, 'email-wide pressure is tracked');
  const b = await login('203.0.113.50', PW);
  assert.equal(b.status, 200, 'owner from a fresh IP is not locked out');
  assert.ok(b.cookie);
  // from IP A itself: locked now, fine once the lock has expired (no permanent lockout)
  assert.equal((await login('198.51.100.1', PW)).status, 429);
  const realNow = Date.now;
  Date.now = () => realNow() + 16 * 60_000;
  try {
    assert.equal((await login('198.51.100.1', PW)).status, 200);
  } finally {
    Date.now = realNow;
  }
});

test('H1: throttling is per (email, IP) pair, never per email alone', async () => {
  await signup();
  config.trustProxy = true;
  for (let i = 0; i < 10; i++) await login('198.51.100.2', `nope-nope-nope-${i}`);
  assert.ok(loginByPair.retryAfter(`${OWNER}|198.51.100.2`) > 0);
  assert.equal(loginByPair.retryAfter(OWNER), 0);
  assert.equal(loginByPair.retryAfter(`${OWNER}|198.51.100.3`), 0);
  assert.equal([...loginByPair.map.keys()].some((k) => k === OWNER), false);
});

test('H1: per-IP spray limit is much higher (60) and locks the spraying IP only; per-email pressure only ever delays', async () => {
  await signup();
  config.trustProxy = true;
  for (let i = 0; i < 60; i++) loginByIp.fail('192.0.2.9');
  assert.ok(loginByIp.retryAfter('192.0.2.9') > 0);
  assert.equal((await login('192.0.2.9', PW)).status, 429);
  assert.equal((await login('192.0.2.10', PW)).status, 200);
  // DelayTracker: escalating, capped, never a lock
  const d = new DelayTracker({ free: 3, baseMs: 250, maxMs: 5000 });
  const seen = [];
  for (let i = 0; i < 12; i++) {
    seen.push(d.delayMs('e'));
    d.fail('e');
  }
  assert.deepEqual(seen.slice(0, 4), [0, 0, 0, 0]);
  assert.equal(seen[4], 250);
  assert.equal(seen[5], 500);
  assert.equal(Math.max(...seen), 5000);
  d.success('e');
  assert.equal(d.delayMs('e'), 0);
});

test('H1: an already-valid session changes its password regardless of login limiters; guesses count per session only', async () => {
  const a = (await signup()).cookie;
  const b = (await call('POST', '/auth/login', { body: { email: OWNER, password: PW } })).cookie;
  // saturate every login limiter for this email and IP
  for (let i = 0; i < 60; i++) loginByIp.fail('127.0.0.1');
  for (let i = 0; i < 10; i++) loginByPair.fail(`${OWNER}|127.0.0.1`);
  for (let i = 0; i < 10; i++) loginEmailDelay.fail(OWNER);
  // session A: 10 wrong guesses lock A's /auth/password only
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/auth/password', { cookie: a, body: { current: `bad-current-${i}`, next: 'a-brand-new-passphrase' } })).status, 401);
  assert.equal((await call('POST', '/auth/password', { cookie: a, body: { current: PW, next: 'a-brand-new-passphrase' } })).status, 429);
  const ok = await call('POST', '/auth/password', { cookie: b, body: { current: PW, next: 'a-brand-new-passphrase' } });
  assert.equal(ok.status, 200, 'the other session is unaffected by login noise and by A lock');
  assert.ok(passwordBySession.map.size >= 1);
});

test('H1: limiter maps are bounded (LRU cap) and locks always expire', () => {
  const l = new AttemptLimiter({ max: 1, maxKeys: 5, lockMs: 1000, maxLockMs: 2000 });
  for (let i = 0; i < 50; i++) l.fail(`k${i}`);
  assert.equal(l.map.size, 5);
  assert.ok(l.map.has('k49') && !l.map.has('k0'));
  const t = new DelayTracker({ maxKeys: 5 });
  for (let i = 0; i < 50; i++) t.fail(`k${i}`);
  assert.equal(t.map.size, 5);
  // escalation is capped: many strikes never exceed maxLockMs
  const cap = new AttemptLimiter({ max: 1, lockMs: 1000, maxLockMs: 3000 });
  for (let i = 0; i < 20; i++) {
    cap.map.get('x') && (cap.map.get('x').lockedUntil = 0);
    cap.fail('x');
  }
  assert.ok(cap.retryAfter('x') <= 3);
});

// ------------------------------------------------------------------ M1
test('M1: production with no account and no ADMIN_TOKEN answers 503 setup_required for /api except health and /auth/*', async () => {
  process.env.REQUIRE_SETUP = 'true';
  for (const [m, p] of [['GET', '/status'], ['GET', '/positions'], ['GET', '/logs'], ['GET', '/settings'], ['GET', '/account'], ['POST', '/run'], ['PATCH', '/settings'], ['POST', '/worker/stop'], ['GET', '/nope']]) {
    const r = await call(m, p, { body: m === 'GET' ? undefined : {} });
    assert.equal(r.status, 503, `${m} ${p}`);
    assert.equal(r.body.code, 'setup_required');
    assert.match(r.body.error, /SIGNUP_CODE/); // SIGNUP_CODE unset too: says exactly which env var to set
    assert.match(r.body.error, /Set the SIGNUP_CODE environment variable/);
  }
  assert.equal((await call('GET', '/health')).status, 200);
  const st = await call('GET', '/auth/status');
  assert.equal(st.status, 200);
  assert.equal(st.body.mode, 'setup');
  assert.equal(st.body.required, true);
  assert.equal(st.body.setupRequired, true);
  assert.match(st.body.guidance, /SIGNUP_CODE/);
  // with SIGNUP_CODE the message no longer asks for it
  process.env.SIGNUP_CODE = 'a-long-random-setup-code';
  const withCode = await call('GET', '/status');
  assert.equal(withCode.status, 503);
  assert.doesNotMatch(withCode.body.error, /Set the SIGNUP_CODE/);
  // signup still needs the code, then everything opens normally (401 without a session, 200 with)
  assert.equal((await signup()).body.code, 'invalid_signup_code');
  const ok = await signup(OWNER, { code: 'a-long-random-setup-code' });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/status')).status, 401);
  assert.equal((await call('GET', '/status', { cookie: ok.cookie })).status, 200);
  assert.equal((await call('GET', '/auth/status')).body.mode, 'session');
});

test('M1: NODE_ENV=production and RENDER also fail closed; an ADMIN_TOKEN or a non-production env does not', async () => {
  process.env.NODE_ENV = 'production';
  assert.equal((await call('GET', '/status')).status, 503);
  delete process.env.NODE_ENV;
  process.env.RENDER = 'true';
  assert.equal((await call('GET', '/status')).status, 503);
  config.adminToken = 'tok-admin-1';
  assert.equal((await call('GET', '/status')).status, 401); // token gate, not setup
  assert.equal((await call('GET', '/status', { headers: { authorization: 'Bearer tok-admin-1' } })).status, 200);
  assert.equal((await call('GET', '/auth/status')).body.mode, 'setup');
  config.adminToken = '';
  delete process.env.RENDER;
  assert.equal((await call('GET', '/status')).status, 200); // local dev stays open
  assert.equal((await call('GET', '/auth/status')).body.mode, 'none');
});

test('M1 frontend logic: setup mode forces the create-account screen; server guidance and 503 code are surfaced', () => {
  const st = { mode: 'setup', required: true, setupRequired: true, signupOpen: false, signupNeedsCode: false, user: null };
  assert.equal(L.needsAuthScreen(st), true);
  assert.equal(L.initialAuthView(st), 'signup');
  assert.equal(L.isSetupMode(st), true);
  assert.equal(L.isSetupMode({ mode: 'none' }), false);
  assert.match(L.authErrorMessage({ status: 503, code: 'setup_required', message: 'Set the SIGNUP_CODE environment variable' }), /SIGNUP_CODE/);
  const src = fs.readFileSync(new URL('../public/js/auth.js', import.meta.url), 'utf8');
  assert.match(src, /!== 'session' && !isSetupMode\(state\.auth\)[^\n]*auth-skip/); // no "Continue without an account" in setup mode
  assert.match(src, /onSetupRequired\(/);
});

// ------------------------------------------------------------------ M2
test('M2: cookie is always Secure in production / on Render, even without TRUST_PROXY or x-forwarded-proto', async () => {
  process.env.NODE_ENV = 'production';
  process.env.SIGNUP_CODE = 'c0de-c0de-c0de-1';
  const r = await signup(OWNER, { code: 'c0de-c0de-c0de-1' });
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /; Secure/);
  assert.match((await call('POST', '/auth/logout', { cookie: r.cookie })).setCookie, /Max-Age=0.*; Secure/);
  usersRepo._reset();
  delete process.env.NODE_ENV;
  process.env.RENDER = '1';
  const r2 = await signup(OWNER, { code: 'c0de-c0de-c0de-1' });
  assert.match(r2.setCookie, /; Secure/);
  delete process.env.RENDER;
  usersRepo._reset();
  delete process.env.SIGNUP_CODE;
  assert.doesNotMatch((await signup()).setCookie, /Secure/); // plain-http dev unchanged
});

test('M2: boot warning when RENDER is set without TRUST_PROXY', () => {
  process.env.RENDER = '1';
  const logs = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(warnIfProxyMisconfigured((m) => logs.push(m)), true);
    config.trustProxy = true;
    assert.equal(warnIfProxyMisconfigured(() => assert.fail()), false);
  } finally {
    console.warn = warn;
  }
  assert.match(logs[0], /TRUST_PROXY/);
});

// ------------------------------------------------------------------ L1
test('L1: logout revokes only that session server-side; the cookie is dead even if replayed; another session stays valid', async () => {
  const a = (await signup()).cookie;
  const b = (await call('POST', '/auth/login', { body: { email: OWNER, password: PW } })).cookie;
  assert.notEqual(a, b);
  assert.equal((await call('GET', '/status', { cookie: a })).status, 200);
  const out = await call('POST', '/auth/logout', { cookie: a });
  assert.equal(out.status, 200);
  assert.equal((await call('GET', '/status', { cookie: a })).status, 401); // replayed old cookie
  assert.equal((await call('GET', '/status', { cookie: b })).status, 200);
  // persisted (survives a reload of the store) and pruned by expiry
  const file = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'revoked-sessions.json'), 'utf8'));
  const sid = C.verifyToken(a.slice('tb_session='.length)).sid;
  assert.ok(file[sid] > Date.now() / 1000);
  assert.equal(sessionsRepo.isRevoked(sid), true);
  sessionsRepo.revoke('expired-sid-0123456789', Math.floor(Date.now() / 1000) - 5);
  assert.equal(sessionsRepo.isRevoked('expired-sid-0123456789'), false);
  assert.equal('expired-sid-0123456789' in JSON.parse(fs.readFileSync(path.join(config.dataDir, 'revoked-sessions.json'), 'utf8')), false);
  // an unauthenticated / forged logout cannot revoke anyone
  await call('POST', '/auth/logout', { cookie: 'tb_session=forged.forged' });
  assert.equal((await call('GET', '/status', { cookie: b })).status, 200);
  // tokens without a sid (pre-revocation cookies) are refused
  const user = usersRepo.getByEmail(OWNER);
  const legacy = C.signToken({ uid: user.id, sv: 0, exp: Math.floor(Date.now() / 1000) + 1000 });
  assert.equal((await call('GET', '/status', { cookie: `tb_session=${legacy}` })).status, 401);
});

// ------------------------------------------------------------------ L2
test('L2: common / patterned / email-derived passwords are rejected; a strong passphrase is accepted (server and client agree)', async () => {
  assert.ok(BLOCKLIST_SIZE >= 500);
  const bad = ['Password1!', 'qwertyuiop1', '12345678901', 'abcdabcdab', 'P@ssw0rd2024', 'iloveyou123', 'abcdefghijk', 'asdfghjkl123', 'zzzzzzzzzz', 'ababababab', '9876543210'];
  for (const p of bad) {
    assert.ok(C.passwordProblem(p, OWNER), `server should reject ${p}`);
    assert.equal(L.passwordStrength(p, OWNER).label, 'Too common', `client meter should flag ${p}`);
    assert.ok(L.validatePassword(p), `client validation should reject ${p}`);
    const r = await call('POST', '/auth/signup', { body: { email: OWNER, password: p } });
    assert.equal(r.body.code, 'weak_password', p);
  }
  assert.match(C.passwordProblem('owner-2024-abcd', 'owner@x.io'), /email/);
  assert.match(C.passwordProblem('OWNER@x.io.....', 'owner@x.io'), /email/);
  for (const good of ['correct horse battery staple', 'Tr0ub4dor&3-purple-kettle', 'a-brand-new-passphrase']) {
    assert.equal(C.passwordProblem(good, OWNER), null, good);
    assert.equal(passwordRuleProblem(good, OWNER), null);
    assert.equal(L.validatePassword(good, OWNER), null);
    assert.ok(L.passwordStrength(good, OWNER).score >= 2);
  }
  assert.equal(usersRepo.count(), 0);
  assert.equal((await call('POST', '/auth/signup', { body: { email: OWNER, password: 'correct horse battery staple' } })).status, 200);
  // password change enforces the same rules
  const c = (await call('POST', '/auth/login', { body: { email: OWNER, password: 'correct horse battery staple' } })).cookie;
  assert.equal((await call('POST', '/auth/password', { cookie: c, body: { current: 'correct horse battery staple', next: 'Password1!' } })).body.code, 'weak_password');
});

// ------------------------------------------------------------------ L3
test('L3: unknown / __proto__ / constructor / prototype settings keys are 400 (never a 500) and nothing is polluted', async () => {
  const c = (await signup()).cookie;
  for (const raw of ['{"__proto__":{"polluted":1}}', '{"constructor":{"prototype":{"polluted":1}}}', '{"constructor":1}', '{"prototype":1}', '{"toString":true}', '{"hasOwnProperty":true}', '{"nope":1}']) {
    const r = await call('PATCH', '/settings', { cookie: c, raw });
    assert.equal(r.status, 400, raw);
  }
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal((await call('PATCH', '/settings', { cookie: c, body: { slippageBps: 7 } })).status, 200);
  assert.equal((await call('PATCH', '/settings', { cookie: c, raw: '{"tradingEnabled":true,"mode":"live"}' })).status, 200); // locked keys stay silently ignored
  const { validateSettings } = await import('../server/middleware.js');
  assert.match(validateSettings(JSON.parse('{"__proto__":{"x":1}}')).error, /unknown setting/);
});

test('L3: {"__proto__":...} is rejected on every JSON endpoint', async () => {
  const c = (await signup()).cookie;
  const bodies = ['{"__proto__":{"x":1}}', '{"a":{"b":[{"__proto__":{"x":1}}]}}', '{"\\u005f_proto__":{"x":1}}'];
  const endpoints = [
    ['POST', '/auth/signup'], ['POST', '/auth/login'], ['POST', '/auth/logout'], ['POST', '/auth/logout-all'], ['POST', '/auth/password'],
    ['PUT', '/account/keys'], ['PUT', '/account/models'], ['POST', '/account/test'], ['PATCH', '/settings'], ['POST', '/run'],
    ['POST', '/positions/close-all'], ['POST', '/positions/x/close'], ['POST', '/worker/stop'], ['POST', '/worker/start'], ['POST', '/worker/kill'],
  ];
  for (const [m, p] of endpoints) {
    for (const raw of bodies) {
      const r = await call(m, p, { cookie: c, raw });
      assert.equal(r.status, 400, `${m} ${p} ${raw}`);
    }
  }
  assert.equal(({}).x, undefined);
  assert.equal((await call('GET', '/status', { cookie: c })).status, 200); // session untouched (logout-all never ran)
});

// ------------------------------------------------------------------ L4
test('L4: IPv6 keys collapse to the /64, IPv4-mapped addresses to IPv4', () => {
  assert.equal(normalizeIp('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(normalizeIp('::ffff:cb00:7105'), '203.0.113.5');
  assert.equal(normalizeIp('203.0.113.5'), '203.0.113.5');
  const a = normalizeIp('2001:db8:abcd:12:1:2:3:4');
  assert.equal(a, '2001:db8:abcd:12::/64');
  assert.equal(normalizeIp('2001:0db8:abcd:0012:ffff:ffff:ffff:ffff'), a);
  assert.equal(normalizeIp('2001:db8:abcd:12::9'), a);
  assert.notEqual(normalizeIp('2001:db8:abcd:13::1'), a);
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(normalizeIp('::1'), '0:0:0:0::/64');
  assert.equal(normalizeIp(undefined), 'unknown');
  config.trustProxy = true;
  const req = (xff) => ({ ip: '10.0.0.1', get: (h) => (h === 'x-forwarded-for' ? xff : undefined) });
  assert.equal(clientKey(req('1.1.1.1, 2001:db8::1')), clientKey(req('2001:db8::ffff:1')));
  config.trustProxy = false;
  assert.equal(clientKey({ ip: '::ffff:127.0.0.1', get: () => undefined }), '127.0.0.1');
});

test('L4: rotating addresses inside one /64 share a single login throttle', async () => {
  await signup();
  config.trustProxy = true;
  for (let i = 0; i < 10; i++) await login(`2001:db8:1:2:${i}::${i + 1}`, `wrong-password-${i}`);
  assert.equal((await login('2001:db8:1:2:aaaa::1', PW)).status, 429);
  assert.equal((await login('2001:db8:1:3::1', PW)).status, 200);
});

test('L4: a GLOBAL cap on wrong sign-up codes (every wrong code counts, from any IP)', async () => {
  process.env.SIGNUP_CODE = 'the-real-signup-code-1';
  config.trustProxy = true;
  for (let i = 0; i < 3; i++) assert.equal((await signup(OWNER, { code: `guess-${i}` })).status === 403, true);
  // (each request above came from the same test IP; the global counter saw all of them)
  assert.equal(signupGlobal.map.get('all').n, 3);
  for (let i = 0; i < 27; i++) signupGlobal.fail('all');
  assert.ok(signupGlobal.retryAfter('all') > 0);
  const r = await call('POST', '/auth/signup', { body: { email: OWNER, password: PW, code: 'the-real-signup-code-1' }, headers: from('203.0.113.99') });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal(usersRepo.count(), 0);
});

// ------------------------------------------------------------------ L5
test('L5: /api responses are no-store without ETag; HSTS in production / over https; CSP kept; static pages not forced no-store', async () => {
  const c = (await signup()).cookie;
  for (const [p, cookie] of [['/health'], ['/status', c], ['/status'], ['/auth/status'], ['/nope', c]]) {
    const r = await call('GET', p, { cookie });
    assert.equal(r.headers.get('cache-control'), 'no-store', p);
    assert.equal(r.headers.get('etag'), null, p);
    if (p === '/nope') assert.equal(r.status, 404);
  }
  assert.equal((await call('POST', '/auth/login', { body: { email: 'a@b.co', password: 'nothing-long-enough' } })).headers.get('cache-control'), 'no-store');
  const page = await realFetch(`${base}/`);
  assert.notEqual(page.headers.get('cache-control'), 'no-store');
  assert.ok(page.headers.get('content-security-policy'));
  // HSTS
  assert.equal((await call('GET', '/health')).headers.get('strict-transport-security'), null); // plain http, not production
  process.env.NODE_ENV = 'production';
  assert.equal((await call('GET', '/health')).headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.equal((await realFetch(`${base}/`)).headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  delete process.env.NODE_ENV;
  config.trustProxy = true;
  assert.match((await call('GET', '/health', { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security'), /max-age=31536000; includeSubDomains/);
  config.trustProxy = false;
  assert.equal((await call('GET', '/health', { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security'), null); // header ignored without TRUST_PROXY
});

// ------------------------------------------------------------------ L6
function rawRequest(host, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/auth/signup', method: 'POST', headers: { host, 'content-type': 'application/json' } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t || '{}') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('L6: code-less first-run signup from loopback also needs a localhost Host header (DNS-rebinding defence)', async () => {
  const body = { email: OWNER, password: PW };
  const rebound = await rawRequest(`evil.example:${port}`, body);
  assert.equal(rebound.status, 403);
  assert.equal(rebound.body.code, 'signup_disabled');
  assert.equal(usersRepo.count(), 0);
  const st = await realFetch(`${base}/api/auth/status`, { headers: {} });
  assert.equal((await st.json()).signupOpen, true); // the real Host (127.0.0.1:port) is fine
  assert.equal((await rawRequest(`localhost:${port}`, body)).status, 200);
  usersRepo._reset();
  assert.equal((await rawRequest(`127.0.0.1:${port}`, body)).status, 200);
  usersRepo._reset();
  assert.equal((await rawRequest(`[::1]:${port}`, body)).status, 200);
  const lb = (headers) => ({ socket: { remoteAddress: '127.0.0.1' }, get: (h) => headers[h] });
  assert.equal(isLoopback(lb({})), false);
  assert.equal(isLoopback(lb({ host: 'localhost.evil.example' })), false);
  assert.equal(isLoopback(lb({ host: '127.0.0.1.evil.example:3000' })), false);
  // with a SIGNUP_CODE the Host rule does not apply (the code is the secret)
  usersRepo._reset();
  process.env.SIGNUP_CODE = 'code-for-remote-signup-1';
  assert.equal((await rawRequest('my.site.example', { ...body, code: 'code-for-remote-signup-1' })).status, 200);
});

// ------------------------------------------------------------------ L7
test('L7: legacy admin token lives in sessionStorage (tab-scoped); an old localStorage copy is deleted', async () => {
  const mk = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
  };
  globalThis.localStorage = mk();
  globalThis.sessionStorage = mk();
  try {
    const api = await import('../public/js/api.js');
    localStorage.setItem('tb_admin_token', 'old-token-from-previous-version');
    assert.equal(api.getToken(), '', 'not read from localStorage');
    assert.equal(localStorage.getItem('tb_admin_token'), null, 'legacy copy removed');
    api.setToken('tok-123');
    assert.equal(sessionStorage.getItem('tb_admin_token'), 'tok-123');
    assert.equal(localStorage.getItem('tb_admin_token'), null);
    assert.equal(api.getToken(), 'tok-123');
    api.setToken('');
    assert.equal(api.getToken(), '');
    assert.equal(sessionStorage._m.size, 0);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
  }
});
