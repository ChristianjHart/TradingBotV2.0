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
  source      text,                         -- 'ai' | 'rules'
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
