import './setup.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake, bar, ago, mkPos } from './helpers.js';

const { store } = await import('../server/db/store.js');
const pos = await import('../server/services/positions.js');
const { monitorPositions, closeManually, closeAll, listPositions, openPosition, PositionError } = pos;

const get = (id) => store.getPositions().find((p) => p.id === id);
beforeEach(() => {
  resetFake();
  store.setPositions([]);
  store.setSettings({ ...store.getSettings(), slippageBps: 0, feeBps: 0, breakEven: true, trailR: 0 });
});

test('stop-loss closes at the stop', async () => {
  const id = mkPos(store);
  fake.bars.set('AAA', [bar(3, 100, 101, 96, 97), bar(2, 97, 98, 94, 95)]);
  await monitorPositions();
  assert.equal(get(id).status, 'closed');
  assert.equal(get(id).exitReason, 'stop-loss');
  assert.equal(get(id).exitPrice, 95);
});

test('take-profit fills at the target (limit, no slippage)', async () => {
  store.setSettings({ ...store.getSettings(), slippageBps: 50 });
  const id = mkPos(store);
  fake.bars.set('AAA', [bar(3, 100, 111, 99, 108)]);
  await monitorPositions();
  assert.equal(get(id).exitReason, 'take-profit');
  assert.equal(get(id).exitPrice, 110);
});

test('gap below the stop fills at the (worse) open', async () => {
  const id = mkPos(store);
  fake.bars.set('AAA', [bar(3, 90, 91, 88, 89)]);
  await monitorPositions();
  assert.equal(get(id).exitReason, 'stop-loss');
  assert.equal(get(id).exitPrice, 90);
});

test('break-even ratchet then trailing-stop exit', async () => {
  const id = mkPos(store);
  fake.bars.set('AAA', [bar(3, 100, 106, 99.5, 105)]);
  await monitorPositions();
  assert.equal(get(id).status, 'open');
  assert.equal(get(id).stopLoss, 100);
  assert.equal(get(id).trailing, true);
  assert.equal(get(id).initialStop, 95);
  fake.bars.set('AAA', [bar(3, 100, 106, 99.5, 105), bar(2, 105, 105, 99, 100)]);
  await monitorPositions();
  assert.equal(get(id).exitReason, 'trailing-stop');
  assert.equal(get(id).exitPrice, 100);
});

test('REGRESSION: persisted ratcheted stop does not re-trigger on early bars next cycle', async () => {
  const id = mkPos(store); // long 100, initial stop 95
  const b0 = bar(4, 100, 106, 98.5, 105); // +1R on bar 0, low 98.5 (above the 95 stop, below the new 100 stop)
  fake.bars.set('AAA', [b0]);
  await monitorPositions(); // cycle 1: stop -> 100
  assert.equal(get(id).stopLoss, 100);
  assert.equal(get(id).status, 'open');
  fake.bars.set('AAA', [b0, bar(3, 105, 107, 101, 106)]);
  await monitorPositions(); // cycle 2 replays b0: must NOT exit at 100
  assert.equal(get(id).status, 'open');
  assert.equal(get(id).stopLoss, 100);
  fake.bars.set('AAA', [b0, bar(3, 105, 107, 101, 106), bar(2, 106, 106, 99, 100)]);
  await monitorPositions();
  assert.equal(get(id).exitReason, 'trailing-stop');
});

test('time exit waits for a fresh bar; expired is flagged meanwhile', async () => {
  const id = mkPos(store, { openedAt: ago(30), expiresAt: ago(6) });
  fake.bars.set('AAA', [bar(2, 100, 101, 99, 100.5)]);
  fake.stale.add('AAA'); // market closed
  await monitorPositions();
  assert.equal(get(id).status, 'open');
  assert.equal(get(id).expiredAt, get(id).expiresAt);
  const listed = (await listPositions()).open.find((p) => p.id === id);
  assert.equal(listed.expired, true);
  assert.equal(listed.stale, true);
  fake.stale.clear(); // market reopens
  await monitorPositions();
  assert.equal(get(id).exitReason, 'time-exit');
  assert.equal(get(id).exitPrice, 100.5);
});

test('unexpired positions are not flagged expired', async () => {
  mkPos(store);
  fake.bars.set('AAA', [bar(2, 100, 101, 99, 100)]);
  assert.equal((await listPositions()).open[0].expired, false);
});

test('RACE: openPosition and manual close during a monitor cycle are not lost', async () => {
  const a = mkPos(store, { symbol: 'AAA' });
  const c = mkPos(store, { symbol: 'CCC' });
  fake.bars.set('AAA', [bar(3, 100, 101, 90, 92)]); // stop hit
  fake.delayMs.set('AAA', 60);
  const mon = monitorPositions();
  await new Promise((r) => setTimeout(r, 10));
  openPosition({ symbol: 'BBB', side: 'long', entry: 50, stopLoss: 45, takeProfit: 60, allocation: 500, qty: 10, confidence: 0.6, reason: 'x', source: 'ai' });
  await closeManually(c);
  await mon;
  assert.equal(get(a).status, 'closed');
  assert.equal(get(c).status, 'closed');
  assert.equal(get(c).exitReason, 'manual');
  assert.ok(store.getPositions().some((p) => p.symbol === 'BBB' && p.status === 'open'));
});

test('overlapping monitor calls are coalesced', async () => {
  mkPos(store);
  fake.delayMs.set('AAA', 30);
  const [x, y] = [monitorPositions(), monitorPositions()];
  assert.equal(x, y);
  await x;
});

test('closeManually: 404 unknown, 502 no quote, 409 stale unless forced', async () => {
  await assert.rejects(closeManually('nope'), (e) => e instanceof PositionError && e.status === 404);
  const id = mkPos(store);
  fake.fail.add('AAA');
  await assert.rejects(closeManually(id), (e) => e.status === 502);
  assert.equal(get(id).status, 'open'); // no fake ~0 P&L close
  fake.fail.clear();
  fake.bars.set('AAA', [bar(1, 100, 101, 99, 101)]);
  fake.stale.add('AAA');
  await assert.rejects(closeManually(id), (e) => e.status === 409 && e.code === 'stale_quote');
  assert.equal(get(id).status, 'open');
  const p = await closeManually(id, { force: true });
  assert.equal(p.exitReason, 'manual');
  assert.equal(p.exitPrice, 101);
  assert.equal(p.staleExit, true);
});

test('closeAll closes what it can and reports failures', async () => {
  const ok = mkPos(store, { symbol: 'AAA' });
  const bad = mkPos(store, { symbol: 'BBB' });
  const stale = mkPos(store, { symbol: 'CCC' });
  fake.fail.add('BBB');
  fake.stale.add('CCC');
  const r = await closeAll();
  assert.equal(r.closed, 1);
  assert.deepEqual(r.failed.map((f) => [f.symbol, f.status]).sort(), [['BBB', 502], ['CCC', 409]]);
  assert.equal(get(ok).status, 'closed');
  assert.equal(get(bad).status, 'open');
  assert.equal(get(stale).status, 'open');
  fake.fail.clear();
  const r2 = await closeAll({ force: true });
  assert.equal(r2.closed, 2);
  assert.equal(r2.failed.length, 0);
});
