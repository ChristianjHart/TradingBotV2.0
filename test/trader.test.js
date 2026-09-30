import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { store } = await import('../server/db/store.js');
const { runTraderBot } = await import('../server/services/traderBot.js');
const { getAccount, monitorPositions, closeAll } = await import('../server/services/positions.js');
const { normalize } = await import('../server/db/supabase.js');
const { validateSettings, SETTING_RULES } = await import('../server/middleware.js');
const { config } = await import('../server/config.js');
const { alpaca } = await import('../server/services/alpaca.js');
const { approveAll } = await import('../server/services/proposals.js');
const { stubOpenRouter } = await import('./helpers.js');

const pick = (symbol, direction, price = 100) => ({ symbol, direction, confidence: 0.8, price, atrPct: 2, reason: 'test' });

test('trader only PROPOSES: never shorts crypto, stops on the correct side; approve-all then opens them', async () => {
  stubOpenRouter();
  const px = async (s) => (await alpaca.getQuote(s)).price; // use mock prices so the monitor sees consistent data
  const res = await runTraderBot([pick('BTC/USD', 'short', await px('BTC/USD')), pick('AAPL', 'long', await px('AAPL')), pick('XOM', 'short', await px('XOM'))]);
  assert.equal(res.source, 'ai');
  assert.equal(store.getPositions().length, 0, 'nothing opened without approval');
  assert.ok(!res.proposals.some((p) => p.symbol === 'BTC/USD'));
  assert.equal(res.proposals.length, 2);
  for (const p of res.proposals) {
    assert.equal(p.status, 'pending');
    assert.ok(p.side === 'long' ? p.stopLoss < p.entryFill && p.takeProfit > p.entryFill : p.stopLoss > p.entryFill && p.takeProfit < p.entryFill);
    assert.ok(p.allocationUsd <= 100_000 * 0.2 + 1e-6);
  }
  const ap = await approveAll();
  assert.equal(ap.approved.length, 2, JSON.stringify(ap.failed));
  for (const p of store.getPositions()) assert.ok(p.fees > 0);
  const stored = store.getPositions();
  assert.ok(stored.every((p) => p.expiresAt && p.initialStop === p.stopLoss));
});

test('account math and closing everything realises fees', async () => {
  await monitorPositions();
  const before = getAccount();
  assert.equal(before.openCount, 2);
  assert.equal((await closeAll()).closed, 2);
  const after = getAccount();
  assert.equal(after.openCount, 0);
  assert.ok(after.realizedPnl < 0); // slippage + fees on flat prices
  assert.ok(store.getPositions().every((p) => p.exitReason === 'manual'));
});

test('store logs are debounced but flushable', () => {
  store.addLog({ message: 'hello' });
  assert.equal(store.getLogs()[0].message, 'hello');
  store.flush();
});

test('supabase normalize fills missing keys with null', () => {
  assert.deepEqual(normalize([{ a: 1 }, { b: 2 }]), [{ a: 1, b: null }, { a: null, b: 2 }]);
});

test('settings validation whitelists and range-checks', () => {
  assert.ok(validateSettings({ horizonHours: 12 }).value);
  assert.match(validateSettings({ horizonHours: 9999 }).error, /invalid/);
  assert.match(validateSettings({ evil: true }).error, /unknown/);
  assert.deepEqual(validateSettings({ tradingEnabled: true }).value, {});
  assert.ok(Object.keys(SETTING_RULES).length > 5);
});

test('auth gate is open without an account/token and strict (401 login_required) with an ADMIN_TOKEN', async () => {
  const { authGate, resolveAuth } = await import('../server/auth/index.js');
  const run = (header) => {
    const req = { headers: {}, get: (h) => (h.toLowerCase() === 'authorization' ? header : undefined) };
    let status = 200;
    let body;
    let nexted = false;
    resolveAuth(req, {}, () => {});
    authGate(req, { status(s) { status = s; return { json(b) { body = b; } }; } }, () => (nexted = true));
    return { status, body, nexted };
  };
  assert.equal(run(undefined).nexted, true);
  config.adminToken = 's3cret';
  assert.equal(run(undefined).status, 401);
  assert.equal(run(undefined).body.code, 'login_required');
  assert.equal(run('Bearer wrong').status, 401);
  assert.equal(run('Bearer s3cret').nexted, true);
  config.adminToken = '';
});
