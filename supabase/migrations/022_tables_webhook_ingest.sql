-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 022 — webhook ingest token for tables
--
-- Adds a per-table token so any external system (Zapier, n8n, Pipedream, a
-- raw form on the user's website, a backend service, …) can POST rows in
-- without needing a Supabase JWT or our auth flow. The token is the only
-- credential — rotate it from the Source tab if it leaks.
--
-- Why a column on lead_tables (not a separate "webhooks" table):
--   - One canonical inbound URL per table → easy to teach: "POST your data
--     to this URL, you're done."
--   - Tokens rotate cleanly via UPDATE; no orphan webhook rows.
--   - Trivial RLS: same as the parent table.
--
-- The actual ingest endpoint is `POST /api/ingest/:token` (public, no auth)
-- in src/leads.ts. It re-uses the same row-insert path as the authed POST,
-- so the assignment-rule auto-apply added in 022's accompanying server
-- changes fires for webhook-ingested rows too.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.lead_tables
  add column if not exists ingest_token uuid default gen_random_uuid();

-- Backfill rows that existed before this migration so every table has a
-- token (default would only apply to new inserts otherwise).
update public.lead_tables
  set ingest_token = gen_random_uuid()
  where ingest_token is null;

alter table public.lead_tables
  alter column ingest_token set not null;

-- Hot-path lookup for the public ingest endpoint — direct hit by token.
create unique index if not exists lead_tables_ingest_token
  on public.lead_tables(ingest_token);
