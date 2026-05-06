-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1 / Task 1.5 — Execution Engine tables
--
-- Adds:
--   • workflow_executions  — per-node execution log (status, timing, errors)
--   • scheduled_jobs       — persistent delayed/wait nodes; survives restarts
--   • workflow_sessions    — adds parent_session_id (for chained workflows)
--                            and last_node_executed_at (for stuck-session detection)
--
-- All tables are tenant-scoped + indexed for the worker hot path.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── workflow_executions ──────────────────────────────────────────────────────
create table if not exists public.workflow_executions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references public.tenants(id) on delete cascade not null,
  session_id    uuid references public.workflow_sessions(id) on delete cascade,
  workflow_id   uuid references public.workflows(id) on delete cascade,
  node_id       text not null,
  node_type     text not null,
  status        text not null check (status in ('started','succeeded','failed','skipped','retrying')),
  attempt       int  not null default 1,
  duration_ms   int,
  error         text,
  output        jsonb,            -- whatever the node returned (template msg id, http response status, ...)
  created_at    timestamptz default now()
);

alter table public.workflow_executions enable row level security;

create policy "Users view own tenant executions" on public.workflow_executions
  for all using (
    exists (
      select 1 from public.tenants t
      where t.id = tenant_id and t.user_id = auth.uid()
    )
  );

create index if not exists wfe_session    on public.workflow_executions(session_id, created_at desc);
create index if not exists wfe_tenant     on public.workflow_executions(tenant_id, created_at desc);
create index if not exists wfe_workflow   on public.workflow_executions(workflow_id, created_at desc);
create index if not exists wfe_failed     on public.workflow_executions(tenant_id, status) where status = 'failed';

-- ── scheduled_jobs ───────────────────────────────────────────────────────────
-- Resume points for wait_delay nodes, scheduled broadcasts, drip campaign steps.
-- The schedule-poller worker selects rows where resume_at <= now() and
-- enqueues them onto the appropriate queue, then marks them dispatched.
create table if not exists public.scheduled_jobs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references public.tenants(id) on delete cascade not null,
  kind          text not null check (kind in (
                  'workflow_resume',
                  'broadcast_send',
                  'campaign_step',
                  'template_status_sync'
                )),
  payload       jsonb not null,                -- { sessionId, nodeId, ... } / { broadcastId } / etc.
  resume_at     timestamptz not null,
  status        text not null default 'pending'
                check (status in ('pending','dispatched','failed','cancelled')),
  attempts      int  not null default 0,
  last_error    text,
  dispatched_at timestamptz,
  created_at    timestamptz default now()
);

alter table public.scheduled_jobs enable row level security;

create policy "Users view own tenant jobs" on public.scheduled_jobs
  for all using (
    exists (
      select 1 from public.tenants t
      where t.id = tenant_id and t.user_id = auth.uid()
    )
  );

-- Hot-path index used every 30s by the poller.
create index if not exists sj_due
  on public.scheduled_jobs(resume_at)
  where status = 'pending';

create index if not exists sj_tenant
  on public.scheduled_jobs(tenant_id, created_at desc);

-- ── workflow_sessions hardening ──────────────────────────────────────────────
alter table public.workflow_sessions
  add column if not exists parent_session_id uuid references public.workflow_sessions(id) on delete set null;

alter table public.workflow_sessions
  add column if not exists last_node_executed_at timestamptz;

create index if not exists ws_parent on public.workflow_sessions(parent_session_id);
create index if not exists ws_status_updated on public.workflow_sessions(tenant_id, status, updated_at desc);

-- ── messages: backfill missing index used by inbox hot-path ──────────────────
-- (No-op if already present from 002_tenants.sql; safe.)
create index if not exists messages_session on public.messages(session_id) where session_id is not null;

-- ── contacts: add (tenant_id, phone) unique so we can upsert by tenant ──────
-- The legacy unique was (user_id, phone). The webhook handler now upserts by
-- tenant scope; without this constraint, two tenants of the same owner would
-- have collided on phone numbers.
create unique index if not exists contacts_tenant_phone_uq
  on public.contacts(tenant_id, phone)
  where tenant_id is not null;
