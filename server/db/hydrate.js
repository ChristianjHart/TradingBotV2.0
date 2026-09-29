import { store } from './store.js';
import { select, supabaseEnabled } from './supabase.js';
import { usersRepo } from './users.js';
import { sessionsRepo } from './sessions.js';

/** Render's disk is ephemeral: on boot, restore positions, runs, equity, picks from Supabase if local files are empty. */
export async function hydrateFromSupabase() {
  if (!supabaseEnabled) return;
  await usersRepo.restoreFromSupabase(); // accounts first: their keys become the active credentials (retries with backoff)
  if (usersRepo.restoreState === 'failed') {
    store.addLog({ level: 'error', message: 'accounts could not be restored from Supabase after several attempts; sign-up stays closed and (in production) the API stays closed until a restart with Supabase reachable' });
  }
  await sessionsRepo.restoreFromSupabase(); // logged-out session ids
  try {
    if (!store.getPositions().length) {
      const rows = await select('positions', 'select=raw&order=opened_at.desc&limit=1000');
      if (rows.length) {
        store.setPositions(rows.map((r) => r.raw));
        store.addLog({ level: 'info', message: `restored ${rows.length} position(s) from Supabase` });
      }
    }
    if (!store.getRuns().length) {
      const rows = await select('runs', 'select=raw&order=at.desc&limit=200');
      if (rows.length) {
        store.setRuns(rows.map((r) => r.raw));
        if (!store.getRunSummary()) store.setRunSummary(rows.map((r) => r.raw).find((r) => !r.error) || null);
        store.addLog({ level: 'info', message: `restored ${rows.length} run(s) from Supabase` });
      }
    }
    if (!store.getEquity().length) {
      const rows = await select('equity_snapshots', 'select=t,equity&order=t.desc&limit=3000');
      if (rows.length) store.setEquity(rows.reverse().map((r) => ({ t: r.t, equity: Number(r.equity) })));
    }
    if (!store.getPickScores().length) {
      const rows = await select('pick_scores', 'select=raw&order=updated_at.desc&limit=5000');
      if (rows.length) store.setPickScores(rows.map((r) => r.raw));
    }
    if (!store.getAiPicks().picks?.length) {
      const [row] = await select('watchlists', 'select=*&order=created_at.desc&limit=1');
      if (row) {
        store.setAiPicks({
          picks: row.picks,
          updatedAt: row.created_at,
          source: row.source,
          model: row.model,
          universe: row.universe,
          scanned: row.scanned,
        });
      }
    }
  } catch (err) {
    console.warn(`[supabase] hydrate failed: ${err.message}`);
  }
}
