-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 067 — public_incidents table for the /status page
--
-- Background:
--   The public /status page surfaces incident history for the last 90
--   days, pulled from `GET /api/public/incidents` (see
--   src/routes/public-status.ts). The endpoint reads from this table.
--
--   The table is super-admin write-only (we never want a tenant to be
--   able to spoof an incident notification on the public site) and
--   anyone-can-read (the whole point is it's public). RLS enforces
--   both halves.
--
-- IMPORTANT — DO NOT APPLY THIS MIGRATION YET.
--   This file is authored as part of the public-marketing-wedge batch
--   so the BE route handler has a schema to read against, but applying
--   it in production is a separate operator decision (super-admin role
--   needs to know how to author entries via the admin UI we haven't
--   built yet). The route handler in src/routes/public-status.ts
--   detects the missing table (Postgres 42P01) and returns an empty
--   incident list, so /status renders cleanly even with this migration
--   un-applied.
--
-- Future migrations to pair with this:
--   - 06X_system_health_ticks: per-minute /health ping log, used by the
--     same status route to compute real uptime % over rolling windows.
--     Today the uptime handler returns conservative static numbers
--     matching the FE fallback.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public_incidents (
  -- Surrogate UUID — incidents are public, so a sequential id would leak
  -- "we've had N incidents total" telemetry to anyone watching the URL.
  id           uuid        primary key default gen_random_uuid(),

  -- Timestamps. started_at is required (you can't have an incident with
  -- no start). resolved_at is null while ongoing — the API surfaces a
  -- distinct "Ongoing" state when resolved_at is null.
  started_at   timestamptz not null,
  resolved_at  timestamptz,

  -- Three-tier severity, mirroring most major status page conventions.
  -- Constrained to a known set so the FE chip palette doesn't need to
  -- handle a stray "extreme" or "yellow" value.
  severity     text        not null check (severity in ('minor', 'major', 'critical')),

  -- Human-readable. Title is the one-liner in the timeline; summary is
  -- a paragraph with what happened + what we did. Keep summary short
  -- (postmortem links elsewhere) — the public timeline is not the place
  -- for a 600-word incident report.
  title        text        not null check (length(title)   between 4 and 200),
  summary      text        not null check (length(summary) between 4 and 2000),

  -- jsonb of strings — which surfaces were affected (e.g.
  -- ["inbox", "WhatsApp send", "Razorpay webhooks"]). FE renders each
  -- as a small chip under the entry.
  affected_services jsonb  not null default '[]'::jsonb,

  -- Audit trail. created_by is the super-admin user id who logged the
  -- incident. Nullable because future automation (PagerDuty webhook,
  -- self-healing post-mortem) may insert rows with no human author.
  created_by   uuid        references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Two indexes:
--   1) Order-by started_at desc for the timeline query (descending so
--      the most recent incident is first; the API also LIMITs to 50).
--   2) Partial index on ongoing incidents — the FE's "live status"
--      banner checks "is there any unresolved incident" which is a
--      hot query on every page load. A partial index keeps it tiny.
create index if not exists idx_public_incidents_started_at
  on public_incidents (started_at desc);

create index if not exists idx_public_incidents_ongoing
  on public_incidents (started_at desc)
  where resolved_at is null;

-- RLS — public read, super-admin write only.
alter table public_incidents enable row level security;

-- SELECT — anyone (including anon role) can read every row. This is the
-- whole point of the table being "public". No row-level filter; the
-- public timeline shows every entry within the last 90 days as
-- determined by the SQL in the API handler.
drop policy if exists public_incidents_read_anyone on public_incidents;
create policy public_incidents_read_anyone
  on public_incidents
  for select
  to anon, authenticated
  using (true);

-- INSERT / UPDATE / DELETE — restricted to platform-scope role assignments
-- (super_admin lives in user_role_assignments with tenant_id IS NULL —
-- see migration 017_super_admin_rbac.sql for the canonical shape). Legacy
-- super_admin in user_roles (tenant_id IS NULL) also honored for backward
-- compat with rows that pre-date the migration auto-mapping. Service-role
-- bypasses RLS, so the server can still write via the public-status route
-- regardless of this policy.
drop policy if exists public_incidents_write_super_admin on public_incidents;
create policy public_incidents_write_super_admin
  on public_incidents
  for all
  to authenticated
  using (
    exists (
      select 1 from user_role_assignments ura
      join role_definitions rd on rd.id = ura.role_id
      where ura.user_id = auth.uid()
        and ura.tenant_id is null
        and rd.scope = 'platform'
    )
    or exists (
      select 1 from user_roles ur
      where ur.user_id = auth.uid()
        and ur.tenant_id is null
        and ur.role     = 'super_admin'
    )
  )
  with check (
    exists (
      select 1 from user_role_assignments ura
      join role_definitions rd on rd.id = ura.role_id
      where ura.user_id = auth.uid()
        and ura.tenant_id is null
        and rd.scope = 'platform'
    )
    or exists (
      select 1 from user_roles ur
      where ur.user_id = auth.uid()
        and ur.tenant_id is null
        and ur.role     = 'super_admin'
    )
  );

-- Keep updated_at fresh on row updates. Boilerplate trigger function
-- already exists in some prior migrations as `set_updated_at()`; we
-- define a local one to avoid coupling this migration to that.
create or replace function set_public_incidents_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_public_incidents_updated_at on public_incidents;
create trigger trg_public_incidents_updated_at
  before update on public_incidents
  for each row
  execute function set_public_incidents_updated_at();

comment on table public_incidents is
  'Incident history surfaced on the public /status page. Super-admin write, public read. See src/routes/public-status.ts for the read API.';
