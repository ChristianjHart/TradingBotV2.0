// Minimal Supabase (PostgREST) client — no SDK dependency. Server-side only (service-role key).
// Writes are queued and flushed in batches; failures never break the app.
import { envAny } from '../config.js';

const URL_ = envAny('SUPABASE_URL').replace(/\/+$/, '');
const KEY = envAny('SUPABASE_SERVICE_ROLE_KEY');

export const supabaseEnabled = Boolean(URL_ && KEY);

const MAX_QUEUE = 5000;
export const MAX_FAILS = 3; // a batch group that fails this many consecutive times is dropped (poisoned)
let queue = [];
let flushing = false;

function headers(extra = {}) {
  return { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...extra };
}

// PostgREST bulk inserts require every object to have the same keys.
export function normalize(rows) {
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  return rows.map((r) => Object.fromEntries([...keys].map((k) => [k, r[k] === undefined ? null : r[k]])));
}

const lastWarn = new Map();
function warnOnce(key, msg) {
  const now = Date.now();
  if (now - (lastWarn.get(key) || 0) < 60_000) return;
  lastWarn.set(key, now);
  console.warn(`[supabase] ${msg}`);
}

async function post(table, rows, upsert) {
  rows = normalize(rows);
  const q = upsert ? '?on_conflict=id' : '';
  const res = await fetch(`${URL_}/rest/v1/${table}${q}`, {
    method: 'POST',
    headers: headers({
      Prefer: upsert ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
    }),
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Supabase ${table} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export function insert(table, row) {
  if (!supabaseEnabled) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({ table, row, upsert: false });
}

export function upsert(table, row) {
  if (!supabaseEnabled) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({ table, row, upsert: true });
}

/** Awaited upsert (throws on failure) for rows that must not be silently lost, e.g. accounts. No-op when disabled. */
export async function upsertNow(table, row) {
  if (!supabaseEnabled) return false;
  await post(table, [row], true);
  return true;
}

export async function flush() {
  if (!supabaseEnabled || flushing || !queue.length) return;
  flushing = true;
  try {
    const batch = queue;
    queue = [];
    const groups = new Map();
    for (const item of batch) {
      const k = `${item.table}|${item.upsert}|${item.fails || 0}`; // retried rows batch apart from fresh ones
      if (!groups.has(k)) groups.set(k, { table: item.table, upsert: item.upsert, items: [] });
      groups.get(k).items.push(item);
    }
    for (const g of groups.values()) {
      try {
        await post(g.table, g.items.map((i) => i.row), g.upsert);
      } catch (err) {
        warnOnce(g.table, err.message);
        const fails = Math.max(...g.items.map((i) => i.fails || 0)) + 1;
        if (fails >= MAX_FAILS) {
          // Poisoned batch (e.g. schema mismatch / bad row): retrying forever would block the queue. Drop it.
          console.warn(`[supabase] dropping ${g.items.length} ${g.table} row(s) after ${fails} consecutive failures: ${err.message}`);
          continue;
        }
        // keep rows for another retry cycle unless the queue is already big
        if (queue.length < MAX_QUEUE / 2) queue.push(...g.items.map((i) => ({ ...i, fails })));
      }
    }
  } finally {
    flushing = false;
  }
}

/** Test hook. */
export const _queueLength = () => queue.length;

export async function select(table, query = '') {
  if (!supabaseEnabled) return [];
  const res = await fetch(`${URL_}/rest/v1/${table}?${query}`, {
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Supabase select ${table} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

if (supabaseEnabled) {
  setInterval(() => flush(), 2000).unref();
}
