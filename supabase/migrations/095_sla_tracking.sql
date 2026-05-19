-- 095_sla_tracking
--
-- Phase 3 (week 5) of the post-deploy roadmap. Real-time SLA scoring on
-- open conversations + breach event log. Unblocks every team ≥ 3 agents.
--
-- ─── What this migration creates ──────────────────────────────────────────
--
-- 1. sla_configs — per-tenant (optionally per-team) policy:
--      - first_response_seconds: target for the FIRST agent reply after
--        an inbound message
--      - resolution_seconds: target for the conversation to close
--      - channel scope (whatsapp | instagram | telegram | 'any')
--      - working_hours_json: optional {tz, days:{1..7: [{start,end}]}}
--        so after-hours don't count toward breach
--      - paused flag for holidays
--
-- 2. sla_breaches — append-only event log. One row per breach crossing
--    (amber→red or never-met-by-deadline). Includes the resolution
--    timestamp when the agent does eventually respond, so we can
--    compute breach duration for reports.
--
-- The worker (src/workers/sla-monitor.ts) scans messages every 30s,
-- compares last_inbound_at vs last_outbound_at per open conversation,
-- emits sla_breaches rows on threshold crossings. The inbox handler
-- joins on the latest row to surface the green/amber/red dot.

set check_function_bodies = off;

-- ─── 1. sla_configs ────────────────────────────────────────────────────────

create table if not exists public.sla_configs (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  -- NULL team_id = tenant-wide default; a team-specific row overrides.
  team_id                  uuid,
  -- 'any' = applies to all channels; specific value scopes to one.
  channel                  text not null default 'any'
                           check (channel in ('any', 'whatsapp', 'instagram', 'telegram')),
  first_response_seconds   integer not null default 900   -- 15 min
                           check (first_response_seconds >= 60),
  resolution_seconds       integer not null default 86400 -- 24 h
                           check (resolution_seconds >= 60),
  working_hours_json       jsonb not null default '{}'::jsonb,
  paused                   boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- One row per (tenant, team, channel). NULL team_id slot is the default.
create unique index if not exists ux_sla_configs_tenant_team_channel
  on public.sla_configs(tenant_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'), channel);

comment on table public.sla_configs is
  'Per-tenant (optionally per-team) SLA policy: first-response + resolution targets in seconds, channel scope, working-hours masking, pause flag. The sla-monitor worker reads these to score open conversations.';

-- ─── 2. sla_breaches ───────────────────────────────────────────────────────

create table if not exists public.sla_breaches (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  conversation_phone   text not null,        -- inbox is keyed on (channel, phone)
  conversation_channel text not null,
  -- breach kind:
  --   first_response → no agent replied within first_response_seconds of inbound
  --   resolution      → conversation still open past resolution_seconds
  type                 text not null check (type in ('first_response', 'resolution')),
  assigned_agent_id    uuid references auth.users(id) on delete set null,
  target_seconds       integer not null,
  actual_seconds       integer,              -- NULL while still breaching; set when resolved
  breached_at          timestamptz not null default now(),
  resolved_at          timestamptz,
  -- The inbound message that started the SLA clock (for first_response).
  source_message_id    text,
  -- Snapshot of the contact at breach time (for the manager dashboard
  -- without an extra join).
  contact_name         text
);

create index if not exists idx_sla_breaches_tenant_active
  on public.sla_breaches(tenant_id, breached_at desc)
  where resolved_at is null;

create index if not exists idx_sla_breaches_agent_active
  on public.sla_breaches(assigned_agent_id, breached_at desc)
  where resolved_at is null;

-- Idempotency: one OPEN breach row per (tenant, conversation, type) at a time.
-- The worker checks for an existing un-resolved row before inserting.
create unique index if not exists ux_sla_breaches_active_per_conv
  on public.sla_breaches(tenant_id, conversation_phone, conversation_channel, type)
  where resolved_at is null;

comment on table public.sla_breaches is
  'Append-only event log for SLA breach crossings. One open row per (conversation, type); resolved_at stamped when the agent finally responds OR conversation closes. Drives manager dashboard widget + push notifications.';

-- ─── 3. RLS ───────────────────────────────────────────────────────────────

alter table public.sla_configs   enable row level security;
alter table public.sla_breaches  enable row level security;

drop policy if exists "sla_configs_tenant_rw" on public.sla_configs;
create policy "sla_configs_tenant_rw" on public.sla_configs
  for all to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
  );

drop policy if exists "sla_breaches_tenant_read" on public.sla_breaches;
create policy "sla_breaches_tenant_read" on public.sla_breaches
  for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
  );

-- Writes only by service-role (worker computes + emits). Audit-trail-grade
-- append-only: even admin agents can't mutate breach rows from the app
-- to massage their team's metrics.
revoke insert, update, delete on public.sla_breaches from authenticated;
