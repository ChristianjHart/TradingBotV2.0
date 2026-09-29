// Print recent Supabase logs. Usage: npm run logs [-- --limit 30 --full]
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
const limit = Number(args[args.indexOf('--limit') + 1]) || 25;
const full = args.includes('--full');

async function q(table, query) {
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const cut = (s, n) => (full || !s ? s : String(s).length > n ? `${String(s).slice(0, n)}…` : s);
const section = (t) => console.log(`\n=== ${t} ===`);

try {
  section(`app_logs (latest ${limit})`);
  for (const r of await q('app_logs', `select=ts,level,message&order=ts.desc&limit=${limit}`))
    console.log(`${r.ts} [${r.level}] ${r.message}`);

  section('ai_logs (latest 6)');
  for (const r of await q('ai_logs', 'select=ts,bot,model,ok,error,duration_ms,usage,response&order=ts.desc&limit=6'))
    console.log(`${r.ts} ${r.bot} ${r.model} ok=${r.ok} ${r.duration_ms}ms tokens=${JSON.stringify(r.usage)}${r.error ? `\n   ERROR: ${r.error}` : ''}\n   reply: ${cut(r.response, 300)}`);

  section('api_logs — failures (status>=400 or error)');
  for (const r of await q('api_logs', `select=ts,direction,service,method,url,status,duration_ms,error&or=(status.gte.400,error.not.is.null)&order=ts.desc&limit=${limit}`))
    console.log(`${r.ts} ${r.direction} ${r.service} ${r.method} ${r.url} → ${r.status ?? 'n/a'} ${r.error || ''}`);

  section('api_logs — counts by service/status (latest 500)');
  const counts = {};
  for (const r of await q('api_logs', 'select=service,status&order=ts.desc&limit=500')) {
    const k = `${r.service} ${r.status ?? 'err'}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  console.log(counts);

  section('latest watchlist');
  const [w] = await q('watchlists', 'select=created_at,source,model,universe,scanned,picks&order=created_at.desc&limit=1');
  console.log(w ? `${w.created_at} source=${w.source} model=${w.model} universe=${w.universe} scanned=${w.scanned} picks=${w.picks?.length}` : 'none');

  section('positions');
  for (const p of await q('positions', 'select=symbol,side,status,entry,stop_loss,take_profit,allocation,pnl&order=opened_at.desc&limit=15'))
    console.log(`${p.status} ${p.side} ${p.symbol} entry=${p.entry} stop=${p.stop_loss} tp=${p.take_profit} alloc=${p.allocation} pnl=${p.pnl}`);
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
}
