import { store } from './store.js';
import { select, supabaseEnabled } from './supabase.js';

/** Render's disk is ephemeral: on boot, restore positions / latest picks from Supabase if local files are empty. */
export async function hydrateFromSupabase() {
  if (!supabaseEnabled) return;
  try {
    if (!store.getPositions().length) {
      const rows = await select('positions', 'select=raw&order=opened_at.desc&limit=1000');
      if (rows.length) {
        store.setPositions(rows.map((r) => r.raw));
        store.addLog({ level: 'info', message: `restored ${rows.length} position(s) from Supabase` });
      }
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
