// Supabase env must be set BEFORE the module loads (it reads env at import time).
import './setup.js';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
import test from 'node:test';
import assert from 'node:assert/strict';

const sb = await import('../server/db/supabase.js');
const realFetch = globalThis.fetch;
const posted = [];
globalThis.fetch = async (url, opts) => {
  const table = String(url).split('/rest/v1/')[1].split('?')[0];
  posted.push(table);
  return table === 'bad' ? new Response('schema mismatch', { status: 400 }) : new Response('', { status: 201 });
};

test('a poisoned batch is dropped after MAX_FAILS consecutive failures, healthy rows still flush', async () => {
  assert.equal(sb.supabaseEnabled, true);
  const warn = console.warn;
  const warns = [];
  console.warn = (m) => warns.push(String(m));
  try {
    sb.insert('bad', { a: 1 });
    sb.insert('good', { a: 1 });
    for (let i = 0; i < sb.MAX_FAILS; i++) await sb.flush();
    assert.equal(sb._queueLength(), 0, 'poisoned rows must not be re-queued forever');
    assert.equal(posted.filter((t) => t === 'bad').length, sb.MAX_FAILS);
    assert.equal(posted.filter((t) => t === 'good').length, 1);
    assert.ok(warns.some((w) => /dropping 1 bad row/.test(w)));
    await sb.flush();
    assert.equal(posted.filter((t) => t === 'bad').length, sb.MAX_FAILS); // not retried again
  } finally {
    console.warn = warn;
  }
});

test('fresh rows are not dropped together with retried poison rows', async () => {
  const warn = console.warn;
  console.warn = () => {};
  sb.insert('bad', { a: 2 });
  await sb.flush(); // fails once (fails=1)
  sb.insert('good', { a: 2 });
  await sb.flush();
  assert.equal(posted.filter((t) => t === 'good').length, 2);
  console.warn = warn;
  globalThis.fetch = realFetch;
});
