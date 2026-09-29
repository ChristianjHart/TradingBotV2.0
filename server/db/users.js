// Accounts repository. Local atomic JSON file (data/users.json) is always written; when Supabase is configured the
// same rows are mirrored to `app_users` (awaited; on failure the row is queued for retry) and restored on boot.
// Rows use the table's column names: id, email, password_hash, session_version, keys_enc, models, created_at, updated_at.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';
import { select, supabaseEnabled, upsert, upsertNow } from './supabase.js';

const file = path.join(config.dataDir, 'users.json');

function readFile() {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeFile(rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let users = readFile();
let restoreState = supabaseEnabled ? 'pending' : 'ok';
const clone = (u) => (u ? structuredClone(u) : null);

async function mirror(row) {
  if (!supabaseEnabled) return;
  try {
    await upsertNow('app_users', row);
  } catch (err) {
    console.warn(`[users] Supabase write failed, will retry: ${err.message}`);
    upsert('app_users', row); // queued retry; the local file stays authoritative meanwhile
  }
}

export const usersRepo = {
  count: () => users.length,
  list: () => users.map(clone),
  getById: (id) => clone(users.find((u) => u.id === id)),
  getByEmail: (email) => clone(users.find((u) => u.email === email)),
  /** The owner is the oldest account; the workspace's API keys/models live on it. */
  owner: () => clone([...users].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0]),

  /** Adds the row in memory synchronously (so concurrent signups cannot both pass an emptiness check), then persists. */
  async create({ email, passwordHash }) {
    if (users.some((u) => u.email === email)) throw Object.assign(new Error('email already registered'), { code: 'email_taken' });
    const now = new Date().toISOString();
    const row = { id: crypto.randomUUID(), email, password_hash: passwordHash, session_version: 0, keys_enc: null, models: null, created_at: now, updated_at: now };
    users.push(row);
    writeFile(users);
    await mirror(row);
    return clone(row);
  },

  async update(id, patch) {
    const row = users.find((u) => u.id === id);
    if (!row) throw new Error('user not found');
    Object.assign(row, patch, { updated_at: new Date().toISOString() });
    writeFile(users);
    await mirror(row);
    return clone(row);
  },

  /**
   * 'ok' | 'pending' (Supabase restore still running at boot) | 'failed' (every attempt failed). While not 'ok' and no
   * local account exists, signup is refused so a transient Supabase outage can never let someone claim a fresh owner
   * account next to the real one that is merely unreachable.
   */
  get restoreState() {
    return restoreState;
  },

  /**
   * Boot: Supabase is the source of truth when it has rows (Render's disk is ephemeral); otherwise push local rows up.
   * Retries with exponential backoff (a transient Supabase blip must not be mistaken for "no account").
   */
  async restoreFromSupabase({ attempts = 4, baseDelayMs = 500 } = {}) {
    if (!supabaseEnabled) return false;
    for (let i = 1; i <= attempts; i++) {
      try {
        const rows = await select('app_users', 'select=*&order=created_at.asc');
        restoreState = 'ok';
        if (rows.length) {
          users = rows;
          writeFile(users);
          console.log(`[users] restored ${rows.length} account(s) from Supabase`);
          return true;
        }
        for (const u of users) await mirror(u);
        console.log(`[users] Supabase has no accounts yet (${users.length} local account(s) pushed up)`);
        return false;
      } catch (err) {
        console.warn(`[users] restore from Supabase failed (attempt ${i}/${attempts}): ${err.message}`);
        if (i < attempts) await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (i - 1)));
      }
    }
    restoreState = 'failed';
    console.error(
      `[users] ERROR: could not restore accounts from Supabase after ${attempts} attempts. Using the local file (${users.length} account(s)). ` +
        (users.length ? '' : 'No account is known: sign-up is refused and the API stays closed until the server is restarted with Supabase reachable.'),
    );
    return false;
  },

  /** Test hook: forget everything (memory + file). */
  _reset() {
    users = [];
    restoreState = 'ok';
    writeFile(users);
  },
};
