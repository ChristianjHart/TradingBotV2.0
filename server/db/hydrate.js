import { store } from './store.js';
import { select, supabaseEnabled } from './supabase.js';
import { usersRepo } from './users.js';
import { sessionsRepo } from './sessions.js';
import { rebuildSpendFromRemote } from '../services/spend.js';

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
  await hydrateProposalsAndSpend();
}

const tableMissing = (err) => /PGRST205|Could not find the table/i.test(String(err?.message));

/**
 * Proposals + AI spend (migration 005). Each is independent and tolerant of the table being missing (PGRST205, like `users`):
 * a setup gap is a warning, never a boot failure. The month-to-date spend is ALWAYS rebuilt/merged (by id) so a redeploy that wiped
 * the disk cannot reset the budget to zero.
 */
export async function hydrateProposalsAndSpend() {
  if (!supabaseEnabled) return;
  try {
    if (!store.getProposals().length) {
      const rows = await select('proposals', 'select=raw&order=created_at.desc&limit=1000');
      if (rows.length) {
        store.setProposals(rows.map((r) => r.raw).filter(Boolean));
        store.addLog({ level: 'info', message: `restored ${rows.length} proposal(s) from Supabase` });
      }
    }
  } catch (err) {
    if (tableMissing(err)) console.warn('[supabase] table public.proposals does not exist — run supabase/setup_all.sql (migration 005). Proposals are kept only on this server\'s disk until then.');
    else console.warn(`[supabase] proposals restore failed: ${err.message}`);
  }
  try {
    if (!store.getResearch().length) {
      const rows = await select('research_notes', 'select=raw&order=at.desc&limit=1000');
      if (rows.length) {
        store.setResearch(rows.map((r) => r.raw).filter(Boolean));
        store.addLog({ level: 'info', message: `restored ${rows.length} research note(s) from Supabase` });
      }
    }
  } catch (err) {
    if (tableMissing(err)) console.warn('[supabase] table public.research_notes does not exist — run supabase/setup_all.sql (migration 006). News research notes are kept only on this server\'s disk until then.');
    else console.warn(`[supabase] research notes restore failed: ${err.message}`);
  }
  try {
    const r = await rebuildSpendFromRemote(select);
    if (r.added) store.addLog({ level: 'info', message: `restored ${r.added} AI spend row(s) for this month from Supabase (${r.source})` });
    if (r.source === 'none' || r.source === 'ai_logs') console.warn('[supabase] table public.ai_spend is missing — run supabase/setup_all.sql (migration 005); the budget is being rebuilt from ai_logs.usage in the meantime.');
  } catch (err) {
    console.warn(`[supabase] AI spend restore failed: ${err.message}`);
  }
}
