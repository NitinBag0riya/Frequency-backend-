-- ────────────────────────────────────────────────────────────────────────
-- 126_workflow_insights.sql
--
-- AI-generated optimization insights per workflow. The route
-- POST /api/workflows/:id/analyze aggregates execution stats from
-- workflow_sessions / messages / workflow_executions, feeds them to Claude,
-- and persists the result here (one row per workflow, upsert).
--
-- `status` distinguishes three states the FE needs to render differently:
--   - 'ready'              — `insights` is a populated array
--   - 'insufficient_data'  — we couldn't generate yet; `metrics_snapshot`
--                            holds the "needs N more runs / X days" info
--                            and `next_check_at` is when the FE can retry
--   - 'error'              — last AI call failed; `insights` is empty,
--                            metrics_snapshot.error holds the message
--
-- One row per workflow_id (cache). Re-running analyze() upserts.
-- ────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

create table if not exists public.workflow_insights (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  status      text not null check (status in ('ready', 'insufficient_data', 'error')),
  -- Array of { type, severity, title, body, evidence?, suggestion? } objects.
  insights    jsonb not null default '[]'::jsonb,
  -- The stats we fed to AI (or for insufficient_data: { needed: {runs, days},
  -- current: {runs, days, message_count} }).
  metrics_snapshot jsonb not null default '{}'::jsonb,
  generated_at  timestamptz not null default now(),
  -- For 'insufficient_data', when the FE should suggest re-checking. Null
  -- when status='ready' (FE uses generated_at + ttl instead).
  next_check_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One row per workflow — analyze() upserts on this.
create unique index if not exists workflow_insights_workflow_id_uniq
  on public.workflow_insights(workflow_id);

create index if not exists workflow_insights_tenant_generated_at
  on public.workflow_insights(tenant_id, generated_at desc);

-- updated_at trigger — shared helper from earlier migrations.
drop trigger if exists trg_workflow_insights_updated_at on public.workflow_insights;
create trigger trg_workflow_insights_updated_at
  before update on public.workflow_insights
  for each row execute function public.set_updated_at();

-- RLS — tenant isolation matches the rest of the workflow surface.
alter table public.workflow_insights enable row level security;

drop policy if exists "tenant members read own insights" on public.workflow_insights;
create policy "tenant members read own insights" on public.workflow_insights
  for select using (
    tenant_id in (
      select t.id from public.tenants t where t.user_id = auth.uid()
      union
      select ura.tenant_id from public.user_role_assignments ura
        where ura.user_id = auth.uid() and ura.disabled_at is null
    )
  );

-- Writes happen only via service-role (the analyze route runs as service-role
-- after auth + tenant identification at the route layer). No insert/update
-- policies for anon/authenticated — service-role bypasses RLS.
