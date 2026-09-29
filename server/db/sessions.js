// Revoked session ids (logout). Session cookies are stateless signed tokens carrying a random `sid`; logout adds the sid
// here until the token's own expiry, after which the entry is pruned (the token is dead by then anyway).
// Persisted to data/revoked-sessions.json (atomic write) and, when Supabase is configured, mirrored best-effort to the
// `revoked_sessions` table (migration 004) and restored on boot, because Render's disk is ephemeral.
// A missing table only costs cross-restart persistence on a wiped disk; it never breaks logout.
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { select, supabaseEnabled, upsert } from './supabase.js';

const file = path.join(config.dataDir, 'revoked-sessions.json');
const MAX_ENTRIES = 20_000;
const nowS = () => Math.floor(Date.now() / 1000);

function load() {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map(Object.entries(obj).filter(([, exp]) => Number.isFinite(exp)));
  } catch {
    return new Map();
  }
}

let revoked = load();

function persist() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(revoked)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[sessions] could not persist revoked sessions: ${err.message}`);
  }
}

function prune() {
  const t = nowS();
  for (const [sid, exp] of revoked) if (exp <= t) revoked.delete(sid);
  while (revoked.size > MAX_ENTRIES) revoked.delete(revoked.keys().next().value); // oldest revoked first
}

export const sessionsRepo = {
  isRevoked: (sid) => revoked.has(sid) && revoked.get(sid) > nowS(),
  /** Invalidate one session until `exp` (unix seconds, the token's expiry). */
  revoke(sid, exp, userId = null) {
    if (typeof sid !== 'string' || !Number.isFinite(exp)) return;
    revoked.set(sid, exp);
    prune();
    persist();
    if (supabaseEnabled) upsert('revoked_sessions', { id: sid, user_id: userId, expires_at: new Date(exp * 1000).toISOString() });
  },
  size: () => revoked.size,

  /** Boot: merge revocations mirrored in Supabase into memory. Failure is logged and ignored. */
  async restoreFromSupabase() {
    if (!supabaseEnabled) return false;
    try {
      const rows = await select('revoked_sessions', `select=id,expires_at&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`);
      for (const r of rows) revoked.set(r.id, Math.floor(new Date(r.expires_at).getTime() / 1000));
      prune();
      persist();
      return true;
    } catch (err) {
      console.warn(`[sessions] restore of revoked sessions from Supabase failed (run migration 004?): ${err.message}`);
      return false;
    }
  },

  /** Test hook. */
  _reset() {
    revoked = new Map();
    persist();
  },
};
