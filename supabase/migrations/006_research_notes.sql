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
