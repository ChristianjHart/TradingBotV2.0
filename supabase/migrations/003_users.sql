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
