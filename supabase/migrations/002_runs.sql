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
