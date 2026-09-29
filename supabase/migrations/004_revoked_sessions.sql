-- TradingBot V2.0 — revoked (logged-out) session ids, so a logout still holds after a restart on Render's ephemeral disk.
-- Paste into Supabase → SQL Editor → Run (safe to re-run). Optional: without it logout still works, but revocations are
-- only kept in the local data/revoked-sessions.json file (lost if the disk is wiped; a stolen cookie then lives until it expires).
-- Only the server (service-role key) touches this table: RLS is enabled with NO policies. Contains random session ids only.

create table if not exists public.revoked_sessions (
  id          text primary key,             -- the `sid` claim of the session cookie
  user_id     uuid,
  expires_at  timestamptz not null,         -- the cookie's own expiry; rows past it are meaningless and may be deleted
  created_at  timestamptz not null default now()
);

create index if not exists revoked_sessions_expires_idx on public.revoked_sessions (expires_at);

alter table public.revoked_sessions enable row level security;
