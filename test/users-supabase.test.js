// Supabase env must be set BEFORE the modules load (they read env at import time).
import './setup.js';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-role-key';
process.env.APP_SECRET = 'supabase-test-secret-0123456789';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
const posts = []; // { table, body }
let tableRows = { app_users: [] };
let failUsers = false;
let failSelects = 0; // next N GETs of app_users answer 503
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.startsWith('http://supabase.test/rest/v1/')) {
    const table = u.split('/rest/v1/')[1].split('?')[0];
    if (opts.method === 'POST') {
      posts.push({ table, body: String(opts.body) });
      if (table === 'app_users' && failUsers) return new Response('down', { status: 503 });
      return new Response('', { status: 201 });
    }
    if (table === 'app_users' && failSelects > 0) {
      failSelects--;
      return new Response('down', { status: 503 });
    }
    return Response.json(tableRows[table] || []);
  }
  return new Response('{}', { status: 200 });
};

const { config, applyCredentials } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const { usersRepo } = await import('../server/db/users.js');
const sb = await import('../server/db/supabase.js');
const { hydrateFromSupabase } = await import('../server/db/hydrate.js');
const { applyOwnerCredentials } = await import('../server/auth/accounts.js');

const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.close();
  globalThis.fetch = realFetch;
  usersRepo._reset();
  applyCredentials({ openrouterKey: '', alpacaKey: '', alpacaSecret: '' });
});
const call = (method, url, body, cookie) =>
  realFetch(`${base}/api${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });

test('accounts mirror to Supabase app_users, and no secret/password/cookie ever reaches any Supabase write', async () => {
  usersRepo._reset();
  const PW = 'a-Very-Private-Passphrase-42';
  const KEY = 'sk-or-v1-SUPABASELEAKCHECK99887766';
  const AK = 'PKSUPABASEALPACAKEYID123';
  const AS = 'SUPABASEALPACASECRETVALUE0123456789abc';
  const su = await call('POST', '/auth/signup', { email: 'own@example.com', password: PW });
  assert.equal(su.status, 200);
  const cookie = su.headers.getSetCookie()[0].split(';')[0];
  await call('PUT', '/account/keys', { openrouterKey: KEY, alpacaKey: AK, alpacaSecret: AS }, cookie);
  await call('POST', '/auth/login', { email: 'own@example.com', password: 'wrong-password-value' });
  await call('POST', '/auth/password', { current: PW, next: 'Another-Private-Passphrase-43' }, cookie);
  await call('GET', '/status', undefined, cookie);
  // an LLM call with the stored key writes an ai_logs row: the request must not contain the key
  const chat = (await import('../server/services/openrouter.js')).chatJson;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes('/chat/completions') ? new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }) : orig(url, opts));
  await assert.rejects(chat({ bot: 't', model: 'm/x', system: 's', user: 'u' }), (e) => !e.message.includes(KEY));
  globalThis.fetch = orig;
  await sb.flush();
  const users = posts.filter((p) => p.table === 'app_users');
  assert.ok(users.length >= 3, 'signup, keys, password each mirrored');
  const last = JSON.parse(users.at(-1).body)[0];
  assert.deepEqual(Object.keys(last).sort(), ['created_at', 'email', 'id', 'keys_enc', 'models', 'password_hash', 'session_version', 'updated_at']);
  assert.ok(last.password_hash.startsWith('scrypt$'));
  assert.equal(last.session_version, 1);
  assert.ok(last.keys_enc.openrouterKey.data);
  const nonUser = posts.filter((p) => p.table !== 'app_users').map((p) => p.body).join('\n');
  assert.ok(posts.some((p) => p.table === 'api_logs'));
  assert.ok(posts.some((p) => p.table === 'ai_logs'));
  const everything = posts.map((p) => p.body).join('\n');
  for (const s of [KEY, AK, AS, PW, 'Another-Private', cookie.split('=')[1]]) {
    assert.equal(everything.includes(s), false, `${s.slice(0, 10)}… reached a Supabase write`);
  }
  assert.equal(nonUser.includes('password_hash'), false);
  assert.equal(/"authorization"|tb_session/i.test(nonUser), false);
  // inbound auth rows carry no body at all
  const auth = posts.filter((p) => p.table === 'api_logs').flatMap((p) => JSON.parse(p.body)).filter((r) => /\/api\/(auth|account)/.test(r.url));
  assert.ok(auth.length >= 4);
  assert.ok(auth.every((r) => r.request === '{"redacted":true}' || r.request?.redacted === true));
});

test('a failing Supabase write keeps the local file and queues a retry; restore prefers Supabase rows', async () => {
  usersRepo._reset();
  failUsers = true;
  const warn = console.warn;
  console.warn = () => {};
  const u = await usersRepo.create({ email: 'x@y.zz', passwordHash: 'scrypt$hash' });
  console.warn = warn;
  assert.equal(usersRepo.getByEmail('x@y.zz').id, u.id); // local file/state still authoritative
  failUsers = false;
  await sb.flush(); // retry queue
  assert.ok(posts.filter((p) => p.table === 'app_users').some((p) => p.body.includes('x@y.zz')));
  // boot restore: Supabase has an owner with encrypted keys -> local replaced, credentials applied
  const { encryptValue } = await import('../server/auth/crypto.js');
  tableRows.app_users = [{ id: 'u1', email: 'remote@example.com', password_hash: 'scrypt$h', session_version: 0, keys_enc: { openrouterKey: encryptValue('sk-or-restored-key-1234') }, models: null, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' }];
  await hydrateFromSupabase();
  assert.equal(usersRepo.count(), 1);
  assert.equal(usersRepo.owner().email, 'remote@example.com');
  applyOwnerCredentials();
  assert.equal(config.openrouter.key, 'sk-or-restored-key-1234');
});

test('boot restore retries with backoff before concluding there is no account; a total failure fails closed', async () => {
  const warn = console.warn;
  const err = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    usersRepo._reset();
    tableRows.app_users = [{ id: 'u9', email: 'kept@example.com', password_hash: 'scrypt$h', session_version: 0, keys_enc: null, models: null, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' }];
    failSelects = 2; // two transient failures, third attempt succeeds
    assert.equal(await usersRepo.restoreFromSupabase({ attempts: 4, baseDelayMs: 1 }), true);
    assert.equal(usersRepo.restoreState, 'ok');
    assert.equal(usersRepo.owner().email, 'kept@example.com');

    // every attempt fails and no local account: state 'failed', signup refused with 503 (no second owner next to the unreachable one)
    usersRepo._reset();
    failSelects = 99;
    assert.equal(await usersRepo.restoreFromSupabase({ attempts: 3, baseDelayMs: 1 }), false);
    assert.equal(usersRepo.restoreState, 'failed');
    assert.equal(failSelects, 96); // exactly 3 attempts
    const r = await call('POST', '/auth/signup', { email: 'new@example.com', password: 'a-Perfectly-Fine-Passphrase-7' });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'accounts_unavailable');
    assert.equal(usersRepo.count(), 0);
  } finally {
    failSelects = 0;
    console.warn = warn;
    console.error = err;
    usersRepo._reset();
    tableRows.app_users = [];
  }
});

test('a missing app_users table (migration 003 not applied) does not block first-run signup', async () => {
  const { usersRepo } = await import('../server/db/users.js');
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.app_users' in the schema cache" }), { status: 404, headers: { 'content-type': 'application/json' } });
  try {
    await usersRepo.restoreFromSupabase({ attempts: 1, baseDelayMs: 1 });
    // state is only observable when Supabase is enabled in this process; when it is not, restoreState is already 'ok'
    assert.equal(usersRepo.restoreState, 'ok');
  } finally {
    globalThis.fetch = real;
  }
});
