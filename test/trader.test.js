import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { store } = await import('../server/db/store.js');
const { runTraderBot } = await import('../server/services/traderBot.js');
const { getAccount, monitorPositions, closeAll } = await import('../server/services/positions.js');
const { normalize } = await import('../server/db/supabase.js');
const { validateSettings, requireAdmin, SETTING_RULES } = await import('../server/middleware.js');
const { config } = await import('../server/config.js');
const { alpaca } = await import('../server/services/alpaca.js');

const pick = (symbol, direction, price = 100) => ({ symbol, direction, confidence: 0.8, price, atrPct: 2, reason: 'test' });

test('trader (rules) never shorts crypto and places stops on the correct side', async () => {
  const px = async (s) => (await alpaca.getQuote(s)).price; // use mock prices so the monitor sees consistent data
  const res = await runTraderBot([pick('BTC/USD', 'short', await px('BTC/USD')), pick('AAPL', 'long', await px('AAPL')), pick('XOM', 'short', await px('XOM'))]);
  assert.equal(res.source, 'rules');
  assert.ok(!res.opened.some((p) => p.symbol === 'BTC/USD'));
  for (const p of res.opened) {
    assert.ok(p.side === 'long' ? p.stopLoss < p.entry && p.takeProfit > p.entry : p.stopLoss > p.entry && p.takeProfit < p.entry);
    assert.ok(p.allocation <= 100_000 * 0.2 + 1e-6);
    assert.ok(p.fees > 0);
  }
  assert.equal(res.opened.length, 2);
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

test('requireAdmin is open without a token and strict with one', () => {
  const run = (header) => {
    let status = 200;
    let nexted = false;
    requireAdmin({ get: () => header }, { status(s) { status = s; return { json() {} }; } }, () => (nexted = true));
    return { status, nexted };
  };
  assert.equal(run(undefined).nexted, true);
  config.adminToken = 's3cret';
  assert.equal(run(undefined).status, 401);
  assert.equal(run('Bearer wrong').status, 401);
  assert.equal(run('Bearer s3cret').nexted, true);
  config.adminToken = '';
});
