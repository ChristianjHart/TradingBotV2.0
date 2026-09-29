// Minimal Supabase (PostgREST) client — no SDK dependency. Server-side only (service-role key).
// Writes are queued and flushed in batches; failures never break the app.
import { envAny } from '../config.js';

const URL_ = envAny('SUPABASE_URL').replace(/\/+$/, '');
const KEY = envAny('SUPABASE_SERVICE_ROLE_KEY');

export const supabaseEnabled = Boolean(URL_ && KEY);

const MAX_QUEUE = 5000;
let queue = [];
let flushing = false;

function headers(extra = {}) {
  return { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...extra };
}

// PostgREST bulk inserts require every object to have the same keys.
function normalize(rows) {
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

export async function flush() {
  if (!supabaseEnabled || flushing || !queue.length) return;
  flushing = true;
  const batch = queue;
  queue = [];
  const groups = new Map();
  for (const item of batch) {
    const k = `${item.table}|${item.upsert}`;
    if (!groups.has(k)) groups.set(k, { table: item.table, upsert: item.upsert, rows: [] });
    groups.get(k).rows.push(item.row);
  }
  for (const g of groups.values()) {
    try {
      await post(g.table, g.rows, g.upsert);
    } catch (err) {
      warnOnce(g.table, err.message);
      // keep rows for one retry cycle unless the queue is already big
      if (queue.length < MAX_QUEUE / 2) queue.push(...g.rows.map((row) => ({ table: g.table, row, upsert: g.upsert })));
    }
  }
  flushing = false;
}

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
  process.on('SIGTERM', () => flush().finally(() => process.exit(0)));
}
