-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 024 — lead_rows.ingest_source for audit clarity
--
-- Webhook-ingested rows are stamped with `user_id = table.user_id` (the
-- table owner), because the public ingest endpoint has no auth user. That
-- means audit logs / "who created this row" answer with the wrong human.
-- This column tells the truth.
--
-- Values:
--   'manual'  — created via UI / authed POST /lead-tables/:id/rows
--   'csv'     — created via /import (CSV upload)
--   'webhook' — created via public POST /api/ingest/:token
--   'sync'    — created by data-source-sync worker (Google Sheets, etc.)
--
-- Default 'manual' so existing rows don't break.
--
-- ─── DEPLOY NOTE ─────────────────────────────────────────────────────────
-- This migration runs `ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT … CHECK
-- (…)` on a potentially hot table (lead_rows is the busiest write target
-- in the system). On Postgres 11+ the ADD COLUMN with a constant DEFAULT
-- is fast-path metadata-only — no rewrite — but it still acquires
-- ACCESS EXCLUSIVE lock on the table for the duration. With a long-running
-- query holding even a shared lock, this migration will WAIT and queue
-- subsequent inserts.
--
-- Practical impact: under steady-state load (~50 req/s of lead_rows
-- inserts) the lock window is sub-second. Under heavy load with a slow
-- query in flight, it can be many seconds — long enough to time out
-- webhook ingest calls.
--
-- Before deploying:
--   1. Check pg_stat_activity for any long-running queries on lead_rows.
--   2. Schedule deploy outside peak ingest hours if possible.
--   3. Consider running this migration with `SET lock_timeout = '5s'`
--      so it fails fast instead of blocking inserts indefinitely.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.lead_rows
  add column if not exists ingest_source text not null default 'manual'
    check (ingest_source in ('manual','csv','webhook','sync'));

create index if not exists lead_rows_ingest_source
  on public.lead_rows(tenant_id, ingest_source)
  where ingest_source != 'manual';

comment on column public.lead_rows.ingest_source is
  'How this row entered the system. Audit-only — does not affect access control.';
