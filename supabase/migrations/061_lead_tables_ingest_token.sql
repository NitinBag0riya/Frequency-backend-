-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 061 — re-add lead_tables.ingest_token (re-apply 022's intent)
--
-- Background: migration 022 (tables_webhook_ingest) added this column +
-- unique index back in the omnichannel rollout. The migration tracker has
-- 022 marked as applied, but the DDL never actually ran against this
-- project — most likely a `supabase migration repair --status applied`
-- run that orphan-marked it during an earlier deploy without applying.
-- Confirmed live: information_schema.columns shows 12 columns on
-- lead_tables; ingest_token is absent.
--
-- Impact of the gap:
--   • GET /api/lead-tables/:id/ingest-token → 404 (.single() returns null
--     when the SELECT errors on missing column)
--   • Source tab in the FE can't reveal the webhook URL
--   • POST /api/ingest/:token has no table to look up
--   • Webhook ingest is dark → assignment rules never fire on webhook
--     payloads (defeats the new notification wiring in migration 060)
--
-- This migration re-runs the DDL idempotently. Matches the original
-- intent (uuid not text — the rest of the codebase reads ingest_token
-- as the result of a Supabase .select() and the four read sites at
-- src/leads.ts:373, 385, 999, 1297, 1300 treat it as an opaque string
-- which works fine for uuid).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add the column. IF NOT EXISTS keeps this safe to re-run.
alter table public.lead_tables
  add column if not exists ingest_token uuid default gen_random_uuid();

-- 2. Backfill any existing rows that pre-dated the column. Even though
--    no rows actually pre-date it on this project (tracker pretended 022
--    ran), the safe pattern is to UPDATE any NULLs to fresh uuids before
--    the NOT NULL constraint goes on.
update public.lead_tables
  set ingest_token = gen_random_uuid()
  where ingest_token is null;

-- 3. NOT NULL — every table must have a webhook URL.
alter table public.lead_tables
  alter column ingest_token set not null;

-- 4. Hot-path unique index for POST /api/ingest/:token lookups. The handler
--    does `.eq('ingest_token', token).maybeSingle()` — without this index
--    every webhook hit would full-scan lead_tables.
create unique index if not exists lead_tables_ingest_token
  on public.lead_tables(ingest_token);

-- 5. Defence-in-depth: replay 023 + 025's column-level GRANT revokes so
--    a hypothetical custom role can't SELECT ingest_token. Service-role
--    (the server's client) bypasses GRANTs and RLS so the route gate
--    `requireAuth + leads:edit` remains the actual access control.
--    Idempotent — revoke is a no-op if the grant isn't there.
revoke select (ingest_token) on public.lead_tables from public;
revoke select (ingest_token) on public.lead_tables from authenticated;
revoke select (ingest_token) on public.lead_tables from anon;

-- 6. Refresh PostgREST schema cache so the new column is visible to API
--    calls immediately instead of waiting for the next NOTIFY tick.
notify pgrst, 'reload schema';

comment on column public.lead_tables.ingest_token is
  'Per-table webhook ingest secret. Used by POST /api/ingest/:token. '
  'Rotate via /api/lead-tables/:id/rotate-ingest-token if leaked. '
  'Column-level SELECT revoked from public/authenticated/anon; only '
  'service_role (server) reads this.';
