// Delete old rows from the Supabase log tables. Usage: npm run prune [-- --days 14]
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment (or .env).
import 'dotenv/config';
import { envAny } from '../server/config.js';

const url = envAny('SUPABASE_URL').replace(/\/+$/, '');
const key = envAny('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}
const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 14;
const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

let failed = false;
for (const table of ['api_logs', 'ai_logs', 'app_logs']) {
  const res = await fetch(`${url}/rest/v1/${table}?ts=lt.${encodeURIComponent(cutoff)}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=headers-only,count=exact' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    failed = true;
    console.error(`${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    continue;
  }
  console.log(`${table}: pruned rows older than ${days}d (${res.headers.get('content-range') || 'ok'})`);
}
process.exit(failed ? 1 : 0);
