import './setup.js';
import fs from 'fs';
import path from 'path';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const { config, applyCredentials } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const { usersRepo } = await import('../server/db/users.js');
const { alpaca } = await import('../server/services/alpaca.js');
const { store } = await import('../server/db/store.js');
const { scheduledRunSkipReason } = await import('../server/services/jobs.js');
const { applyOwnerCredentials } = await import('../server/auth/accounts.js');
const AR = await import('../server/routes/auth.js');
const { loginByIp, loginByPair, loginEmailDelay, signupByIp, signupGlobal, passwordBySession, resetAuthLimiters } = AR;
const C = await import('../server/auth/crypto.js');
const { isLoopback, signupState, signupCode } = await import('../server/auth/policy.js');
const { AttemptLimiter } = await import('../server/auth/index.js');

const realFetch = globalThis.fetch;
const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.close();
  globalThis.fetch = realFetch;
  fs.rmSync(path.join(config.dataDir, 'users.json'), { force: true });
});

const PW = 'correct-horse-battery';
const FAKE_OR = 'sk-or-v1-FAKEOPENROUTERSECRET1234';
const FAKE_AK = 'PKFAKEALPACAKEYID9876';
const FAKE_AS = 'FAKEALPACASECRETVALUEabcdef0123456789';

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
  const setCookie = r.headers.getSetCookie?.() || [];
  const raw1 = setCookie.find((c) => c.startsWith('tb_session='));
  return { status: r.status, body: json, text, headers: r.headers, setCookie: raw1, cookie: raw1 ? raw1.split(';')[0] : null };
}

async function signup(email = 'owner@example.com', extra = {}) {
  return call('POST', '/auth/signup', { body: { email, password: PW, ...extra } });
}

beforeEach(() => {
  usersRepo._reset();
  resetAuthLimiters();
  Object.assign(loginEmailDelay, { baseMs: 1, maxMs: 5 }); // keep the escalating delay negligible in tests
  config.trustProxy = false;
  config.adminToken = '';
  process.env.APP_SECRET = 'test-app-secret-0123456789abcdef';
  delete process.env.SIGNUP_CODE;
  delete process.env.ALLOW_SIGNUP;
  process.env.USE_MOCK_DATA = 'true';
  applyCredentials({ openrouterKey: '', alpacaKey: '', alpacaSecret: '', scannerModel: '', traderModel: '' });
  config.openrouter.key = '';
  config.alpaca.key = '';
  config.alpaca.secret = '';
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------- status / open mode
test('no account and no ADMIN_TOKEN: app is open and reports setupRequired', async () => {
  const s = await call('GET', '/auth/status');
  assert.deepEqual(s.body, { required: false, setupRequired: true, signupOpen: true, signupNeedsCode: false, mode: 'none', user: null });
  assert.equal((await call('GET', '/status')).status, 200);
});

// ---------------------------------------------------------------- signup rules
test('first-run signup with no SIGNUP_CODE: remote clients need the one-time boot code; loopback needs nothing', async () => {
  const viaProxy = { 'x-forwarded-for': '203.0.113.9' };
  // remote, no code -> refused, but as a code problem (there IS a one-time code), not "signup disabled"
  const noCode = await call('POST', '/auth/signup', { body: { email: 'a@b.co', password: PW }, headers: viaProxy });
  assert.equal(noCode.status, 403);
  assert.equal(noCode.body.code, 'invalid_signup_code');
  const wrong = await call('POST', '/auth/signup', { body: { email: 'a@b.co', password: PW, code: 'guess' }, headers: viaProxy });
  assert.equal(wrong.body.code, 'invalid_signup_code');
  assert.equal(usersRepo.count(), 0);
  const status = await call('GET', '/auth/status', { headers: viaProxy });
  assert.equal(status.body.signupOpen, true);
  assert.equal(status.body.signupNeedsCode, true);
  // the one-time code (what the server prints at startup) lets a remote client create the owner...
  const bootCode = signupCode();
  assert.ok(bootCode && bootCode.length >= 12);
  const remoteOk = await call('POST', '/auth/signup', { body: { email: 'remote@example.com', password: PW, code: bootCode }, headers: viaProxy });
  assert.equal(remoteOk.status, 200);
  // ...and it stops working the moment an account exists
  assert.equal(signupCode(), '');
  usersRepo._reset();
  const ok = await signup();
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, user: { email: 'owner@example.com' } });
  // cookie flags
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Lax/);
  assert.match(ok.setCookie, /Max-Age=1209600/);
  assert.doesNotMatch(ok.setCookie, /Secure/); // plain http
  const lb = (addr, headers = { host: 'localhost:3000' }) => ({ socket: { remoteAddress: addr }, get: (h) => headers[h] });
  assert.equal(isLoopback(lb('127.0.0.1')), true);
  assert.equal(isLoopback(lb('10.0.0.5')), false);
  assert.equal(isLoopback(lb('::1', { host: '[::1]:3000', 'x-forwarded-for': '1.2.3.4' })), false);
});

test('signup with SIGNUP_CODE: code required (constant-time compare), wrong code 403, ADMIN_TOKEN is the fallback code', async () => {
  process.env.SIGNUP_CODE = 'let-me-in-123';
  const viaProxy = { 'x-forwarded-for': '203.0.113.9' };
  const no = await call('POST', '/auth/signup', { body: { email: 'a@b.co', password: PW }, headers: viaProxy });
  assert.equal(no.status, 403);
  assert.equal(no.body.code, 'invalid_signup_code');
  const bad = await call('POST', '/auth/signup', { body: { email: 'a@b.co', password: PW, code: 'nope' }, headers: viaProxy });
  assert.equal(bad.status, 403);
  const ok = await call('POST', '/auth/signup', { body: { email: 'A@B.co ', password: PW, code: 'let-me-in-123' }, headers: viaProxy });
  assert.equal(ok.status, 200);
  assert.equal(usersRepo.getByEmail('a@b.co').email, 'a@b.co'); // normalised
  delete process.env.SIGNUP_CODE;
  usersRepo._reset();
  config.adminToken = 'tok-admin-1';
  assert.equal((await call('POST', '/auth/signup', { body: { email: 'a@b.co', password: PW, code: 'wrong' } , headers: { authorization: 'Bearer tok-admin-1' } })).status, 403);
  assert.equal((await call('POST', '/auth/signup', { body: { email: 'a@b.co', password: PW, code: 'tok-admin-1' } })).status, 200);
});

test('after the owner exists signup is disabled unless ALLOW_SIGNUP=true (and still needs the code)', async () => {
  assert.equal((await signup()).status, 200);
  const closed = await signup('second@example.com');
  assert.equal(closed.status, 403);
  assert.equal(closed.body.code, 'signup_disabled');
  process.env.ALLOW_SIGNUP = 'true';
  process.env.SIGNUP_CODE = 'code-xyz-789';
  assert.equal((await signup('second@example.com')).body.code, 'invalid_signup_code');
  assert.equal((await signup('second@example.com', { code: 'code-xyz-789' })).status, 200);
  assert.equal((await signup('second@example.com', { code: 'code-xyz-789' })).status, 409); // duplicate
  assert.equal(usersRepo.count(), 2);
});

test('signup validates email and password (min 10, no common passwords)', async () => {
  for (const email of ['', 'nope', 'a@b', 'a b@c.com', undefined, 5]) assert.equal((await call('POST', '/auth/signup', { body: { email, password: PW } })).body?.code, 'invalid_email', String(email));
  for (const password of ['short', '123456789', 'password123', '1234567890', 'aaaaaaaaaaaa', 'abababababab'.slice(0, 3) + 'ab', undefined, 'x'.repeat(201)]) {
    const r = await call('POST', '/auth/signup', { body: { email: 'a@b.co', password } });
    assert.equal(r.status, 400, String(password));
    assert.equal(r.body.code, 'weak_password');
  }
  assert.equal(C.passwordProblem('a@b.co-a@b.co', 'a@b.co'), null);
  assert.ok(C.passwordProblem('A@B.CO', 'a@b.co'));
  assert.equal(usersRepo.count(), 0);
});

// ---------------------------------------------------------------- passwords
test('scrypt hashes are salted, verifiable and constant-time compared', async () => {
  const h1 = await C.hashPassword(PW);
  const h2 = await C.hashPassword(PW);
  assert.notEqual(h1, h2);
  assert.ok(h1.startsWith('scrypt$'));
  assert.equal(await C.verifyPassword(PW, h1), true);
  assert.equal(await C.verifyPassword(`${PW}x`, h1), false);
  assert.equal(await C.verifyPassword(PW, 'garbage'), false);
  assert.equal(await C.dummyVerify(PW), false);
  assert.doesNotMatch(h1, new RegExp(PW));
});

// ---------------------------------------------------------------- login / lockout
test('login: success sets a cookie, failures are generic for unknown email and wrong password', async () => {
  await signup();
  const ok = await call('POST', '/auth/login', { body: { email: ' OWNER@example.com', password: PW } });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie.startsWith('tb_session='));
  const wrong = await call('POST', '/auth/login', { body: { email: 'owner@example.com', password: 'wrong-password-1' } });
  const unknown = await call('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'wrong-password-1' } });
  for (const r of [wrong, unknown]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'invalid email or password', code: 'invalid_credentials' });
    assert.equal(r.cookie, null);
  }
  assert.equal((await call('POST', '/auth/login', { body: { email: 'owner@example.com' } })).status, 401);
  assert.equal((await call('POST', '/auth/login', { body: {} })).status, 401);
});

test('login lockout: 10 failures then 429 with Retry-After, even for the right password', async () => {
  await signup();
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/auth/login', { body: { email: 'owner@example.com', password: `wrong-password-${i}` } })).status, 401);
  const locked = await call('POST', '/auth/login', { body: { email: 'owner@example.com', password: PW } });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal(locked.body.code, 'rate_limited');
  // ...but the lock is per (email, IP) pair: another address is not affected
  config.trustProxy = true;
  assert.equal((await call('POST', '/auth/login', { body: { email: 'owner@example.com', password: PW }, headers: { 'x-forwarded-for': '203.0.113.7' } })).status, 200);
});

test('AttemptLimiter: lockout doubles and success clears', () => {
  const l = new AttemptLimiter({ max: 2, lockMs: 1000, windowMs: 60_000 });
  l.fail('k');
  assert.equal(l.retryAfter('k'), 0);
  l.fail('k');
  assert.ok(l.retryAfter('k') >= 1 && l.retryAfter('k') <= 1);
  l.success('k');
  assert.equal(l.retryAfter('k'), 0);
});

// ---------------------------------------------------------------- sessions
test('session token: tamper, expiry, wrong secret and session_version invalidation', async () => {
  const r = await signup();
  const user = usersRepo.getByEmail('owner@example.com');
  const good = r.cookie;
  assert.equal((await call('GET', '/account', { cookie: good })).status, 200);
  // tampered payload / signature
  const [body, sig] = good.slice('tb_session='.length).split('.');
  const forged = Buffer.from(JSON.stringify({ uid: user.id, sv: 0, exp: 9999999999 })).toString('base64url');
  for (const t of [`${forged}.${sig}`, `${body}.${sig.slice(0, -2)}xx`, `${body}`, 'a.b.c', '']) assert.equal((await call('GET', '/status', { cookie: `tb_session=${t}` })).status, 401);
  // expired (correctly signed)
  const expired = C.signToken({ uid: user.id, sv: 0, exp: Math.floor(Date.now() / 1000) - 10 });
  assert.equal((await call('GET', '/status', { cookie: `tb_session=${expired}` })).status, 401);
  assert.equal(C.verifyToken(expired), null);
  // signed with another secret
  assert.equal((await call('GET', '/status', { cookie: `tb_session=${C.signToken({ uid: user.id, sv: 0, exp: 9999999999 }, 'other-secret')}` })).status, 401);
  // session_version bump invalidates (logout-all)
  const out = await call('POST', '/auth/logout-all', { cookie: good });
  assert.equal(out.status, 200);
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await call('GET', '/status', { cookie: good })).status, 401);
  // unknown uid
  assert.equal((await call('GET', '/status', { cookie: `tb_session=${C.signToken({ uid: 'nope', sv: 0, exp: 9999999999 })}` })).status, 401);
});

test('Secure flag when https is terminated by a trusted proxy', async () => {
  const saved = config.trustProxy;
  config.trustProxy = true;
  const r = await call('POST', '/auth/signup', { body: { email: 'a@b.co', password: PW }, headers: {} });
  config.trustProxy = saved;
  assert.equal(r.status, 200);
  // (x-forwarded-proto is only honoured with TRUST_PROXY)
  usersRepo._reset();
  config.trustProxy = true;
  const s = await call('POST', '/auth/signup', { body: { email: 'a@b.co', password: PW }, headers: { 'x-forwarded-proto': 'https' } });
  config.trustProxy = saved;
  assert.match(s.setCookie, /; Secure/);
});

test('logout clears the cookie; password change bumps session_version and reissues the cookie', async () => {
  const a = (await signup()).cookie;
  const b = (await call('POST', '/auth/login', { body: { email: 'owner@example.com', password: PW } })).cookie;
  assert.match((await call('POST', '/auth/logout', { cookie: a })).setCookie, /tb_session=;.*Max-Age=0/);
  const bad = await call('POST', '/auth/password', { cookie: b, body: { current: 'not-the-password', next: 'a-brand-new-passphrase' } });
  assert.equal(bad.status, 401);
  assert.equal((await call('POST', '/auth/password', { cookie: b, body: { current: PW, next: 'short' } })).status, 400);
  const ok = await call('POST', '/auth/password', { cookie: b, body: { current: PW, next: 'a-brand-new-passphrase' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie && ok.cookie !== b);
  assert.equal((await call('GET', '/status', { cookie: a })).status, 401); // old sessions dead
  assert.equal((await call('GET', '/status', { cookie: b })).status, 401);
  assert.equal((await call('GET', '/status', { cookie: ok.cookie })).status, 200);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'owner@example.com', password: PW } })).status, 401);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'owner@example.com', password: 'a-brand-new-passphrase' } })).status, 200);
  assert.equal((await call('POST', '/auth/password', { body: { current: PW, next: 'whatever-long-enough' } })).status, 401); // needs a session
});

// ---------------------------------------------------------------- gate
test('gate: with an account every /api route except health and /auth/* needs a session (GET and POST)', async () => {
  const c = (await signup()).cookie;
  for (const [m, p] of [['GET', '/status'], ['GET', '/positions'], ['GET', '/logs'], ['GET', '/settings'], ['GET', '/account'], ['POST', '/run'], ['PATCH', '/settings'], ['POST', '/worker/stop'], ['GET', '/nope']]) {
    const r = await call(m, p, { body: m === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.deepEqual(r.body, { error: 'unauthorized', code: 'login_required' });
  }
  assert.equal((await call('GET', '/health')).status, 200);
  const st = await call('GET', '/auth/status');
  assert.deepEqual(st.body, { required: true, setupRequired: false, signupOpen: false, signupNeedsCode: false, mode: 'session', user: null });
  const me = await call('GET', '/auth/status', { cookie: c });
  assert.deepEqual(me.body.user, { email: 'owner@example.com' });
  assert.equal((await call('GET', '/status', { cookie: c })).status, 200);
  assert.equal((await call('POST', '/run', { cookie: c, body: {} })).status === 401, false);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'x@y.zz', password: 'nothing-long-enough' } })).status, 401); // /auth/* stays reachable
});

test('gate: Bearer ADMIN_TOKEN works for scripts (with and without an account); wrong token 401', async () => {
  config.adminToken = 'tok-admin-1';
  assert.equal((await call('GET', '/status')).status, 401);
  assert.equal((await call('GET', '/status', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await call('GET', '/status', { headers: { authorization: 'Bearer tok-admin-1' } })).status, 200);
  // Bearer requests need no JSON content-type (curl -X POST)
  const r = await realFetch(`${base}/api/worker/start`, { method: 'POST', headers: { authorization: 'Bearer tok-admin-1' } });
  assert.equal(r.status, 200);
  const st = await call('GET', '/auth/status');
  assert.equal(st.body.required, true);
  assert.equal(st.body.mode, 'setup');
  assert.equal(st.body.setupRequired, true);
  assert.equal(st.body.signupNeedsCode, true);
  await signup('owner@example.com', { code: 'tok-admin-1' });
  assert.equal((await call('GET', '/status', { headers: { authorization: 'Bearer tok-admin-1' } })).status, 200);
  assert.equal((await call('GET', '/status')).status, 401);
  assert.equal((await call('GET', '/account', { headers: { authorization: 'Bearer tok-admin-1' } })).status, 200);
  config.adminToken = '';
});

// ---------------------------------------------------------------- CSRF
test('CSRF: state-changing requests need JSON (or X-Requested-With) and a matching Origin', async () => {
  const c = (await signup()).cookie;
  const form = await call('POST', '/worker/start', { cookie: c, raw: 'a=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 403);
  assert.equal(form.body.code, 'csrf');
  const plain = await call('POST', '/worker/start', { cookie: c, raw: '{}', headers: { 'content-type': 'text/plain' } });
  assert.equal(plain.body.code, 'csrf');
  assert.equal((await call('POST', '/worker/start', { cookie: c, raw: '', headers: { 'content-type': 'text/plain', 'x-requested-with': 'fetch' } })).status, 200);
  const evil = await call('POST', '/worker/start', { cookie: c, body: {}, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.code, 'csrf');
  assert.equal((await call('POST', '/worker/start', { cookie: c, body: {}, headers: { origin: base } })).status, 200);
  assert.equal((await call('POST', '/worker/start', { cookie: c, body: {}, headers: { origin: 'null' } })).status, 403);
  // login and signup are covered too
  assert.equal((await call('POST', '/auth/login', { body: { email: 'owner@example.com', password: PW }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('POST', '/auth/login', { raw: 'email=a', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).body.code, 'csrf');
  // GET is never blocked by the origin rule
  assert.equal((await call('GET', '/status', { cookie: c, headers: { origin: 'https://evil.example' } })).status, 200);
  const saved = config.corsOrigin;
  config.corsOrigin = 'https://app.example';
  assert.equal((await call('POST', '/worker/start', { cookie: c, body: {}, headers: { origin: 'https://app.example' } })).status, 200);
  config.corsOrigin = saved;
});

// ---------------------------------------------------------------- key encryption
test('AES-256-GCM round trip, random IV, wrong secret / tampering cannot decrypt', () => {
  const S = 'secret-one-abcdefghijklmnop';
  const a = C.encryptValue(FAKE_OR, S);
  const b = C.encryptValue(FAKE_OR, S);
  assert.equal(a.v, 1);
  assert.deepEqual(Object.keys(a).sort(), ['data', 'iv', 'tag', 'v']);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
  assert.equal(JSON.stringify(a).includes(FAKE_OR), false);
  assert.equal(C.decryptValue(a, S), FAKE_OR);
  assert.throws(() => C.decryptValue(a, 'secret-two-abcdefghijklmnop'));
  assert.throws(() => C.decryptValue({ ...a, data: b.data }, S));
  assert.throws(() => C.decryptValue({ ...a, tag: b.tag }, S));
  assert.throws(() => C.encryptValue('x', ''), (e) => e.code === 'encryption_not_configured');
});

test('account keys: saved encrypted, applied immediately, never returned by any endpoint or log; wrong APP_SECRET makes them unreadable', async () => {
  const c = (await signup()).cookie;
  const put = await call('PUT', '/account/keys', { cookie: c, body: { openrouterKey: ` ${FAKE_OR} `, alpacaKey: FAKE_AK, alpacaSecret: FAKE_AS } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.keys, {
    openrouter: { set: true, source: 'account', last4: FAKE_OR.slice(-4) },
    alpaca: { set: true, source: 'account', keyLast4: FAKE_AK.slice(-4), secretSet: true },
  });
  assert.equal(put.body.encryptionReady, true);
  assert.equal(config.openrouter.key, FAKE_OR); // trimmed + active immediately
  assert.equal(config.alpaca.key, FAKE_AK);
  // never in any response
  const secrets = [FAKE_OR, FAKE_AK, FAKE_AS, PW];
  const seen = [put.text];
  for (const p of ['/account', '/status', '/health', '/logs?limit=500', '/dashboard', '/settings', '/runs', '/auth/status']) seen.push((await call('GET', p, { cookie: c })).text);
  seen.push(JSON.stringify(store.getLogs()));
  const onDisk = fs.readFileSync(path.join(config.dataDir, 'users.json'), 'utf8');
  seen.push(onDisk);
  for (const s of secrets) for (const t of seen) assert.equal(t.includes(s), false, `${s.slice(0, 8)}… leaked`);
  const stored = usersRepo.owner().keys_enc;
  assert.equal(C.decryptValue(stored.openrouterKey), FAKE_OR);
  // survives a "restart": clear runtime creds, reload from the users repo
  applyCredentials({ openrouterKey: '', alpacaKey: '', alpacaSecret: '' });
  assert.equal(config.openrouter.key, '');
  applyOwnerCredentials();
  assert.equal(config.openrouter.key, FAKE_OR);
  // changing APP_SECRET: keys cannot be read any more
  process.env.APP_SECRET = 'a-completely-different-secret-123456';
  assert.equal(applyOwnerCredentials().unreadable, true);
  assert.equal(config.openrouter.key, '');
  process.env.APP_SECRET = 'test-app-secret-0123456789abcdef';
  applyOwnerCredentials();
  assert.equal(config.openrouter.key, FAKE_OR);
  // clear
  const cleared = await call('PUT', '/account/keys', { cookie: c, body: { clear: ['openrouter', 'alpaca'] } });
  assert.equal(cleared.body.keys.openrouter.set, false);
  assert.equal(cleared.body.keys.openrouter.source, 'none');
  assert.equal(cleared.body.keys.openrouter.last4, null);
  assert.equal(usersRepo.owner().keys_enc, null);
  assert.equal(config.openrouter.key, '');
});

test('PUT /account/keys validation and encryption_not_configured', async () => {
  const c = (await signup()).cookie;
  const put = (body) => call('PUT', '/account/keys', { cookie: c, body });
  for (const body of [{ openrouterKey: 'short' }, { openrouterKey: 'has space in key 123' }, { openrouterKey: 'ctrl\u0007char-key-123456' }, { openrouterKey: 'k'.repeat(300) }, { openrouterKey: 12345678 }, { alpacaKey: FAKE_AK }, { alpacaSecret: FAKE_AS }, { clear: ['bogus'] }, {}, []]) {
    assert.equal((await put(body)).status, 400, JSON.stringify(body));
  }
  // no APP_SECRET: sessions still work (ephemeral per-boot secret) but keys cannot be stored
  process.env.APP_SECRET = '';
  const c2 = (await call('POST', '/auth/login', { body: { email: 'owner@example.com', password: PW } })).cookie;
  assert.equal((await call('GET', '/status', { cookie: c })).status, 401); // cookie signed with the old secret is void
  const put2 = (body) => call('PUT', '/account/keys', { cookie: c2, body });
  const r = await put2({ openrouterKey: FAKE_OR });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'encryption_not_configured');
  assert.equal(config.openrouter.key, '');
  assert.equal((await call('GET', '/account', { cookie: c2 })).body.encryptionReady, false);
  // no account -> cannot save keys either
  usersRepo._reset();
  process.env.APP_SECRET = 'test-app-secret-0123456789abcdef';
  const open = await call('PUT', '/account/keys', { body: { openrouterKey: FAKE_OR } });
  assert.equal(open.status, 409);
  assert.equal(open.body.code, 'no_account');
});

test('PUT /account/models validates and updates the active models; empty resets to default', async () => {
  const c = (await signup()).cookie;
  const before = (await call('GET', '/account', { cookie: c })).body.models;
  assert.equal(before.scanner, before.defaults.scanner);
  for (const b of [{ scannerModel: 'bad model' }, { traderModel: 'x'.repeat(101) }, { scannerModel: 5 }, { scannerModel: 'a;b' }, []]) assert.equal((await call('PUT', '/account/models', { cookie: c, body: b })).status, 400);
  const ok = await call('PUT', '/account/models', { cookie: c, body: { scannerModel: 'openai/gpt-4o-mini', traderModel: 'anthropic/claude-3.5-sonnet:beta' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.models.scanner, 'openai/gpt-4o-mini');
  assert.equal(config.openrouter.traderModel, 'anthropic/claude-3.5-sonnet:beta');
  applyCredentials({ scannerModel: '', traderModel: '' });
  applyOwnerCredentials();
  assert.equal(config.openrouter.scannerModel, 'openai/gpt-4o-mini');
  const reset = await call('PUT', '/account/models', { cookie: c, body: { scannerModel: '', traderModel: '' } });
  assert.equal(reset.body.models.scanner, before.defaults.scanner);
});

// ---------------------------------------------------------------- dynamic credentials
test('credentials are dynamic: account keys switch mock <-> live immediately, env stays the fallback', () => {
  assert.equal(alpaca.usingMock(), true);
  assert.equal(config.useMockData, true);
  applyCredentials({ alpacaKey: FAKE_AK, alpacaSecret: FAKE_AS });
  assert.equal(config.alpaca.key, FAKE_AK);
  assert.equal(alpaca.usingMock(), false); // account keys override USE_MOCK_DATA=true
  applyCredentials({ alpacaKey: '', alpacaSecret: '' });
  assert.equal(alpaca.usingMock(), true);
  // only one half of the pair is not a credential
  applyCredentials({ alpacaKey: FAKE_AK });
  assert.equal(alpaca.usingMock(), true);
  applyCredentials({ alpacaKey: '' });
  // env fallback (USE_MOCK_DATA=false read at call time)
  config.alpaca.key = 'envk';
  config.alpaca.secret = 'envs';
  process.env.USE_MOCK_DATA = 'false';
  config.useMockData = false;
  assert.equal(alpaca.usingMock(), false);
  applyCredentials({ alpacaKey: FAKE_AK, alpacaSecret: FAKE_AS });
  assert.equal(config.alpaca.secret, FAKE_AS); // account wins
  applyCredentials({ alpacaKey: '', alpacaSecret: '' });
  assert.equal(config.alpaca.secret, 'envs');
  config.alpaca.key = '';
  config.alpaca.secret = '';
  assert.equal(alpaca.usingMock(), true); // no credentials at all -> mock
  // OpenRouter key + models
  applyCredentials({ openrouterKey: FAKE_OR, scannerModel: 'x/y' });
  assert.equal(config.openrouter.key, FAKE_OR);
  assert.equal(config.openrouter.scannerModel, 'x/y');
});

test('changing credentials resets the alpaca caches', async () => {
  alpaca._sizes();
  applyCredentials({ alpacaKey: FAKE_AK, alpacaSecret: FAKE_AS });
  assert.deepEqual(alpaca._sizes(), { cache: 0, stale: 0, fallbacks: 0 });
  applyCredentials({ alpacaKey: '', alpacaSecret: '' });
});

test('status endpoints report the active credential source', async () => {
  const c = (await signup()).cookie;
  assert.equal((await call('GET', '/status', { cookie: c })).body.openrouterConfigured, false);
  await call('PUT', '/account/keys', { cookie: c, body: { openrouterKey: FAKE_OR } });
  assert.equal((await call('GET', '/status', { cookie: c })).body.openrouterConfigured, true);
  const acct = (await call('GET', '/account', { cookie: c })).body;
  assert.equal(acct.email, 'owner@example.com');
  assert.ok(acct.createdAt);
  assert.equal(acct.signupOpen, false);
  config.openrouter.key = 'env-openrouter-key-000';
  await call('PUT', '/account/keys', { cookie: c, body: { clear: ['openrouter'] } });
  const envSrc = (await call('GET', '/account', { cookie: c })).body.keys.openrouter;
  assert.deepEqual(envSrc, { set: true, source: 'env', last4: '-000'.slice(-4) });
});

// ---------------------------------------------------------------- account test endpoint
test('POST /account/test makes a real minimal call with the ACTIVE key and never echoes it', async () => {
  const c = (await signup()).cookie;
  const t = (service) => call('POST', '/account/test', { cookie: c, body: { service } });
  assert.deepEqual((await t('openrouter')).body, { ok: false, message: 'no key configured' });
  assert.deepEqual((await t('alpaca')).body, { ok: false, message: 'no key configured' });
  assert.equal((await t('bogus')).status, 400);
  await call('PUT', '/account/keys', { cookie: c, body: { openrouterKey: FAKE_OR, alpacaKey: FAKE_AK, alpacaSecret: FAKE_AS } });
  const calls = [];
  let mode = 'ok';
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
    calls.push({ url: String(url), headers: opts.headers });
    if (mode === 'throw') throw new Error(`connect ECONNREFUSED while sending ${FAKE_OR}`);
    return mode === 'ok' ? Response.json({ data: {} }) : new Response('nope', { status: 401 });
  };
  const ok = await t('openrouter');
  assert.equal(ok.body.ok, true);
  assert.equal(calls[0].url, `${config.openrouter.baseUrl}/auth/key`);
  assert.equal(calls[0].headers.Authorization, `Bearer ${FAKE_OR}`);
  const okA = await t('alpaca');
  assert.equal(okA.body.ok, true);
  assert.equal(calls[1].url, `${config.alpaca.baseUrl}/v2/account`);
  assert.equal(calls[1].headers['APCA-API-KEY-ID'], FAKE_AK);
  assert.equal(calls[1].headers['APCA-API-SECRET-KEY'], FAKE_AS);
  mode = 'reject';
  const rej = await t('openrouter');
  assert.equal(rej.body.ok, false);
  assert.match(rej.body.message, /rejected.*401/);
  mode = 'throw';
  const thrown = await t('openrouter');
  assert.equal(thrown.body.ok, false);
  for (const r of [ok, okA, rej, thrown]) for (const s of [FAKE_OR, FAKE_AK, FAKE_AS]) assert.equal(r.text.includes(s), false);
  // unauthenticated -> 401
  assert.equal((await call('POST', '/account/test', { body: { service: 'alpaca' } })).status, 401);
});

// ---------------------------------------------------------------- logging + cron
test('request logger never stores auth/account bodies; redact covers passwords, codes, cookies', async () => {
  const { redact } = await import('../server/services/http.js');
  const r = redact({ password: 'x', current: 'y', next: 'z', code: 'c', cookie: 'k', Authorization: 'Bearer q', openrouterKey: 'o', symbol: 'AAPL' });
  assert.deepEqual(Object.values(r).filter((v) => v !== '[redacted]'), ['AAPL']);
});

test('scheduled runs skip with a logged reason when no credentials exist', () => {
  const logs = [];
  assert.match(scheduledRunSkipReason({ now: 1e12, log: (m) => logs.push(m) }), /no OpenRouter or Alpaca credentials/);
  scheduledRunSkipReason({ now: 1e12 + 1000, log: (m) => logs.push(m) });
  assert.equal(logs.length, 1); // throttled
  applyCredentials({ openrouterKey: FAKE_OR });
  assert.equal(scheduledRunSkipReason({ now: 2e12 }), null);
});

test('signupState policy helper', () => {
  const req = (addr) => ({ socket: { remoteAddress: addr }, get: (h) => (h === 'host' ? 'localhost:3000' : undefined) });
  // nothing configured: remote clients must present the one-time boot code, loopback needs none
  assert.equal(signupState(req('8.8.8.8')).open, true);
  assert.equal(signupState(req('8.8.8.8')).needsCode, true);
  assert.equal(signupState(req('127.0.0.1')).open, true);
  assert.equal(signupState(req('127.0.0.1')).needsCode, false);
  process.env.SIGNUP_CODE = 'abc';
  assert.equal(signupState(req('8.8.8.8')).open, true);
  assert.equal(signupState(req('8.8.8.8')).needsCode, true);
});

test('first run with ADMIN_TOKEN set shows the create-account screen (mode setup), never a token-only dead end', async () => {
  // Regression: the SPA only showed a token prompt (and a "Sign out" that just forgot the token) when ADMIN_TOKEN was
  // set and no account existed, so the owner could never reach the create-account screen.
  const { needsAuthScreen } = await import('../public/js/auth-logic.js');
  const status = { mode: 'setup', required: true, setupRequired: true, signupNeedsCode: true, user: null };
  assert.equal(needsAuthScreen(status), true);
});

test('security env vars tolerate case and stray whitespace (dashboard paste mistakes)', async () => {
  const { config } = await import('../server/config.js');
  const before = { ...process.env };
  try {
    delete process.env.SIGNUP_CODE;
    process.env.Signup_Code = '  my-setup-code \n';
    assert.equal(config.signupCode, 'my-setup-code');
    delete process.env.Signup_Code;
    process.env.SIGNUP_CODE = ' abc ';
    assert.equal(config.signupCode, 'abc');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    if (before.SIGNUP_CODE === undefined) delete process.env.SIGNUP_CODE;
    else process.env.SIGNUP_CODE = before.SIGNUP_CODE;
  }
});
