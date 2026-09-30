-- TradingBot V2.0 — ALL Supabase migrations in one paste (001 → 006). Safe to re-run.
-- Supabase dashboard → SQL Editor → New query → paste everything → Run.
-- Then restart the Render service (accounts are restored at startup only).

-- ===== supabase/migrations/001_init.sql =====
-- TradingBot V2.0 — Supabase schema. Paste into Supabase → SQL Editor → Run (safe to re-run).
-- The app talks to these tables with the service-role key only (RLS on, no public policies).

create table if not exists public.app_logs (
  id         bigint generated always as identity primary key,
  ts         timestamptz not null default now(),
  level      text not null default 'info',
  message    text not null
);

-- Every HTTP request the app receives ('inbound') or makes ('outbound': Alpaca, OpenRouter).
create table if not exists public.api_logs (
  id           bigint generated always as identity primary key,
  ts           timestamptz not null default now(),
  direction    text not null check (direction in ('inbound', 'outbound')),
  service      text not null,               -- 'app' | 'alpaca' | 'openrouter'
  method       text,
  url          text,
  status       integer,
  duration_ms  integer,
  request      jsonb,                       -- query/body (secrets redacted); inbound only
  error        text
);

-- Every model call: what we sent and what came back.
create table if not exists public.ai_logs (
  id           bigint generated always as identity primary key,
  ts           timestamptz not null default now(),
  bot          text not null,               -- 'scanner' | 'trader'
  model        text not null,
  request      jsonb,                       -- full messages array sent
  response     text,                        -- raw model reply
  usage        jsonb,                       -- token counts from OpenRouter
  duration_ms  integer,
  ok           boolean not null default true,
  error        text
);

-- One row per scanner-bot run (the top-100 list).
create table if not exists public.watchlists (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  source      text,                         -- 'ai' | 'demo'
  model       text,
  universe    integer,
  scanned     integer,
  picks       jsonb not null                -- [{symbol,direction,confidence,reason,price,atrPct}]
);

-- Simulated (paper) positions with their stop-loss / take-profit levels.
create table if not exists public.positions (
  id           text primary key,
  symbol       text not null,
  side         text not null,
  status       text not null,               -- 'open' | 'closed'
  entry        numeric,
  stop_loss    numeric,
  take_profit  numeric,
  allocation   numeric,
  qty          numeric,
  confidence   numeric,
  reason       text,
  source       text,
  model        text,
  opened_at    timestamptz,
  closed_at    timestamptz,
  exit_price   numeric,
  exit_reason  text,
  pnl          numeric,
  pnl_pct      numeric,
  raw          jsonb not null,              -- full position object (used to restore local state)
  updated_at   timestamptz not null default now()
);

create index if not exists app_logs_ts_idx   on public.app_logs (ts desc);
create index if not exists api_logs_ts_idx   on public.api_logs (ts desc);
create index if not exists api_logs_svc_idx  on public.api_logs (service, ts desc);
create index if not exists ai_logs_ts_idx    on public.ai_logs (ts desc);
create index if not exists ai_logs_bot_idx   on public.ai_logs (bot, ts desc);
create index if not exists watchlists_ts_idx on public.watchlists (created_at desc);
create index if not exists positions_status_idx on public.positions (status, opened_at desc);

-- Lock everything down: no policies => only the service-role key (server) can read/write.
alter table public.app_logs   enable row level security;
alter table public.api_logs   enable row level security;
alter table public.ai_logs    enable row level security;
alter table public.watchlists enable row level security;
alter table public.positions  enable row level security;

-- ===== supabase/migrations/002_runs.sql =====
-- TradingBot V2.0 — run history, equity snapshots, scored scanner picks, log retention.
-- Paste into Supabase → SQL Editor → Run (safe to re-run). Run 001_init.sql first.

-- One row per AI run (successful or failed). `raw` is the full summary (trades, rejected, note…).
create table if not exists public.runs (
  id              text primary key,          -- 'run_<epoch ms>'
  at              timestamptz not null,
  ok              boolean not null default true,
  scanner_source  text,
  trader_source   text,
  picks           integer,
  opened          integer,
  duration_ms     integer,
  raw             jsonb not null,
  created_at      timestamptz not null default now()
);

-- Equity curve points (written when equity changes, or every 30 min).
create table if not exists public.equity_snapshots (
  id      bigint generated always as identity primary key,
  t       timestamptz not null,
  equity  numeric not null
);

-- Every scanner pick, scored after its horizon (direction hit/miss) — drives calibration.
create table if not exists public.pick_scores (
  id          text primary key,              -- '<runId>_<symbol>'
  raw         jsonb not null,
  updated_at  timestamptz not null default now()
);

create index if not exists runs_at_idx             on public.runs (at desc);
create index if not exists equity_snapshots_t_idx  on public.equity_snapshots (t desc);
create index if not exists pick_scores_upd_idx     on public.pick_scores (updated_at desc);

alter table public.runs             enable row level security;
alter table public.equity_snapshots enable row level security;
alter table public.pick_scores      enable row level security;

-- Log retention: delete old rows from the high-volume log tables.
-- Manual:    select public.prune_logs(14);
-- Scheduled: enable the pg_cron extension, then
--   select cron.schedule('prune-logs', '17 3 * * *', $$select public.prune_logs(14)$$);
-- (or run `npm run prune` from anywhere with the service-role key).
create or replace function public.prune_logs(keep_days integer default 14)
returns table (tbl text, deleted bigint)
language plpgsql
as $$
declare n bigint;
begin
  delete from public.api_logs where ts < now() - make_interval(days => keep_days);
  get diagnostics n = row_count; tbl := 'api_logs'; deleted := n; return next;
  delete from public.ai_logs  where ts < now() - make_interval(days => keep_days);
  get diagnostics n = row_count; tbl := 'ai_logs'; deleted := n; return next;
  delete from public.app_logs where ts < now() - make_interval(days => keep_days);
  get diagnostics n = row_count; tbl := 'app_logs'; deleted := n; return next;
end;
$$;

-- ===== supabase/migrations/003_users.sql =====
-- TradingBot V2.0 — accounts (single-owner login) and account-attached, encrypted API keys.
-- Paste into Supabase → SQL Editor → Run (safe to re-run). Run 001_init.sql and 002_runs.sql first.
-- Only the server (service-role key) reads/writes this table: RLS is enabled with NO policies, so the anon/public
-- API can never see it. API keys are AES-256-GCM encrypted by the app (key derived from APP_SECRET) before they get here.

create table if not exists public.app_users (
  id               uuid primary key default gen_random_uuid(),
  email            text not null unique,      -- lowercase, validated by the app
  password_hash    text not null,             -- scrypt$N$r$p$salt$hash (never the password)
  session_version  integer not null default 0, -- bump = every existing session cookie becomes invalid
  keys_enc         jsonb,                     -- {openrouterKey|alpacaKey|alpacaSecret: {v,iv,tag,data}}
  models           jsonb,                     -- {scannerModel, traderModel} overrides
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.app_users enable row level security;

-- ===== supabase/migrations/004_revoked_sessions.sql =====
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

-- ===== supabase/migrations/005_proposals_spend.sql =====
-- TradingBot V2.0 — trade proposals (approval queue) and the AI spend ledger (monthly budget).
-- Paste into Supabase → SQL Editor → Run (safe to re-run). Optional but recommended on Render: without `proposals` the approval queue lives
-- only in data/proposals.json; without `ai_spend` the month-to-date AI spend is rebuilt from ai_logs.usage after a redeploy (it still
-- survives, just less precisely). Only the server (service-role key) touches these tables: RLS is enabled with NO policies.

-- One row per trade proposal. `raw` holds the full proposal (levels, models used, riskCheck snapshot, shadow counterfactual score...).
create table if not exists public.proposals (
  id          text primary key,             -- prop_<runId>_<SYMBOL>
  run_id      text,
  symbol      text not null,
  side        text not null,                -- 'long' | 'short'
  status      text not null,                -- pending | approved | rejected | expired | superseded
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  decided_at  timestamptz,
  raw         jsonb,
  updated_at  timestamptz not null default now()
);

-- One row per model call (scanner | trader | news | other). cost_usd is the provider-reported cost, or an estimate from tokens x catalog price.
create table if not exists public.ai_spend (
  id                 text primary key,      -- spend_<epoch>_<rand>; text so the server can upsert (retries never double count)
  ts                 timestamptz not null default now(),
  bot                text not null,
  model              text not null,
  prompt_tokens      integer not null default 0,
  completion_tokens  integer not null default 0,
  cost_usd           numeric(12, 6) not null default 0,
  cost_source        text not null default 'estimated',   -- 'reported' | 'estimated'
  run_id             text,
  ok                 boolean not null default true
);

create index if not exists proposals_status_idx  on public.proposals (status, created_at desc);
create index if not exists proposals_symbol_idx  on public.proposals (symbol, created_at desc);
create index if not exists proposals_run_idx     on public.proposals (run_id);
create index if not exists ai_spend_ts_idx       on public.ai_spend (ts desc);
create index if not exists ai_spend_bot_idx      on public.ai_spend (bot, ts desc);

alter table public.proposals enable row level security;
alter table public.ai_spend  enable row level security;

-- Make the API (PostgREST) notice the new tables immediately.
notify pgrst, 'reload schema';

-- ===== supabase/migrations/006_research_notes.sql =====
-- TradingBot V2.0 — news & earnings research notes (the news bot's structured output, one row per symbol per run).
-- Paste into Supabase → SQL Editor → Run (safe to re-run). Optional but recommended on Render: without it the notes live only in
-- data/research-notes.json and are lost on a redeploy (the dashboard simply shows none until the next run). Only the server
-- (service-role key) touches this table: RLS is enabled with NO policies.

create table if not exists public.research_notes (
  id          text primary key,             -- note_<runId>_<SYMBOL>
  run_id      text,
  symbol      text not null,
  at          timestamptz not null default now(),
  raw         jsonb,                        -- the full validated note: sentiment, catalyst, earningsInDays, riskFlags, summary, sources, model
  updated_at  timestamptz not null default now()
);

create index if not exists research_notes_symbol_idx on public.research_notes (symbol, at desc);
create index if not exists research_notes_run_idx    on public.research_notes (run_id);
create index if not exists research_notes_at_idx     on public.research_notes (at desc);

alter table public.research_notes enable row level security;

-- Make the API (PostgREST) notice the new table immediately.
notify pgrst, 'reload schema';
