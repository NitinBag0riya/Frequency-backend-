-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 3 / Tasks 3.1-3.2 — Drip campaign engine + enrollment
--
-- Adds:
--   • campaign_steps        — ordered list of actions per campaign (send_template,
--                             send_text, wait_delay, condition, end). Sequential by
--                             `position`; the next step is loaded by index.
--   • campaign_enrollments  — one row per (campaign_id, contact_id). Tracks current
--                             step + status. Re-enrollment is idempotent on
--                             (campaign_id, contact_id) — see unique index.
--   • campaigns trigger metadata — `trigger` column ('tag_added', 'manual', 'webhook')
--                             and `trigger_config` (e.g. { tag: 'lead' })
-- ─────────────────────────────────────────────────────────────────────────────

-- ── campaigns: trigger metadata ──────────────────────────────────────────────
alter table public.campaigns
  add column if not exists trigger        text check (trigger in ('manual','tag_added','webhook','schedule')),
  add column if not exists trigger_config jsonb default '{}'::jsonb;

-- ── campaign_steps ───────────────────────────────────────────────────────────
create table if not exists public.campaign_steps (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid references public.campaigns(id) on delete cascade not null,
  tenant_id     uuid references public.tenants(id) on delete cascade not null,
  position      int  not null,                          -- 0-indexed; ordered
  -- Step kinds mirror a useful subset of workflow node types:
  --   wait_delay     → schedule resume; cfg = { delay_minutes }
  --   send_template  → enqueue message.send (template); cfg = { template_name, language, variable_map }
  --   send_text      → enqueue message.send (text); cfg = { text }       (24h window only)
  --   add_tag        → mutate contact tags; cfg = { tag }
  --   end            → mark enrollment 'completed'
  kind          text not null check (kind in ('wait_delay','send_template','send_text','add_tag','end')),
  config        jsonb not null default '{}'::jsonb,
  created_at    timestamptz default now()
);

alter table public.campaign_steps enable row level security;

create policy "Users manage own campaign steps" on public.campaign_steps
  for all using (
    exists (
      select 1 from public.tenants t
      where t.id = tenant_id and t.user_id = auth.uid()
    )
  );

create unique index if not exists campaign_steps_position_uq
  on public.campaign_steps(campaign_id, position);
create index if not exists campaign_steps_tenant on public.campaign_steps(tenant_id);

-- ── campaign_enrollments ─────────────────────────────────────────────────────
create table if not exists public.campaign_enrollments (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid references public.campaigns(id) on delete cascade not null,
  tenant_id       uuid references public.tenants(id) on delete cascade not null,
  contact_id      uuid references public.contacts(id) on delete cascade,
  contact_phone   text not null,
  current_step    int  not null default 0,            -- index into campaign_steps.position
  status          text not null default 'active'
                  check (status in ('active','completed','failed','exited')),
  variables       jsonb default '{}'::jsonb,
  enrolled_at     timestamptz default now(),
  last_step_at    timestamptz,
  completed_at    timestamptz,
  exit_reason     text                                  -- 'opted_out' | 'condition_failed' | 'duplicate' | ...
);

alter table public.campaign_enrollments enable row level security;

create policy "Users manage own enrollments" on public.campaign_enrollments
  for all using (
    exists (
      select 1 from public.tenants t
      where t.id = tenant_id and t.user_id = auth.uid()
    )
  );

-- One active enrollment per (campaign, contact); re-enrollment dedupes.
create unique index if not exists enrollments_campaign_contact_uq
  on public.campaign_enrollments(campaign_id, contact_id)
  where status = 'active';

create index if not exists enrollments_tenant_status
  on public.campaign_enrollments(tenant_id, status, last_step_at desc);
create index if not exists enrollments_phone
  on public.campaign_enrollments(tenant_id, contact_phone);
