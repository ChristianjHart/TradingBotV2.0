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
