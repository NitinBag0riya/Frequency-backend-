-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 065 — Workflow simulation runs (test/dry-run mode)
--
-- Background: prior to this migration the only way to validate a workflow's
-- behaviour before going live was POST /api/workflows/:id/dry-run, which is a
-- structural validator (missing connections, missing required cfg, dangling
-- node ids). It does NOT actually execute the workflow's logic — it can't
-- tell the user "this branch_variable node will route to 'default' because
-- {{plan}} is empty", or "this template would have been sent to a number
-- that isn't a valid E.164".
--
-- The simulation mode runs the SAME executor code path as a live workflow
-- but every side-effecting op (HTTP, queue enqueue, DB write, payment link
-- creation, AI inference, notification dispatch) is short-circuited:
--   - connector_call / send_template / send_text / send_media / payment /
--     run_ai_responder / update_sheet / create_calendar_event / etc. all
--     return synthetic output derived from the registry's outputSchema sample.
--   - Branching / variable / wait_delay / condition logic runs FOR REAL so
--     the user sees their actual routing decisions on the user's data.
--   - Each step is recorded into this table so the FE can render a trace
--     view "what would have happened, step by step".
--
-- Why a dedicated table (vs reusing workflow_executions):
--   1. workflow_executions is high-volume + indexed for live monitoring;
--      polluting it with dry-runs would confuse the live-traffic dashboards.
--   2. A simulation has a different shape — one row per RUN holds the whole
--      trace (steps jsonb[]), not one row per node. The FE polls one row.
--   3. RLS: simulation runs are scoped to the user who triggered them
--      (started_by). Live executions are scoped to the tenant. Different
--      lens, different table.
--
-- Idempotent — every CREATE uses IF NOT EXISTS so the migration is safe to
-- re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Table ────────────────────────────────────────────────────────────────
-- Columns:
--   tenant_id      — denormalised for RLS + cheap tenant-scoped cleanup
--   workflow_id    — references workflows(id); ON DELETE CASCADE because if a
--                    workflow is deleted, its simulation history is dead weight.
--   started_by     — auth user uuid (the human who hit "Simulate")
--   started_at     — when the run was enqueued
--   finished_at    — when the runner wrote the final status (running→succeeded/failed)
--   status         — 'running' | 'succeeded' | 'failed' (open enum, gate via CHECK)
--   trigger_input  — the { trigger_input: {...} } body from the request; the
--                    runner seeds session.variables with this so the workflow
--                    can interpolate it in step 1.
--   steps          — append-only jsonb[] of per-node trace entries; each entry
--                    has { node_id, node_type, started_at, finished_at, input,
--                    simulated_output, would_have_done, kind, error? }.
--   final_context  — session.variables at end of run (snapshot for debugging)
--   error          — populated when status='failed'; top-level failure text
--
-- The steps column is jsonb (not jsonb[]) because Supabase JSON RPCs flatten
-- arrays awkwardly; storing as a JSON array inside a single jsonb column is
-- the same on disk and reads cleanly via PostgREST.

create table if not exists public.workflow_simulation_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  workflow_id   uuid not null references public.workflows(id) on delete cascade,
  started_by    uuid null,                                 -- auth.users(id); nullable so service-role runs work
  started_at    timestamptz not null default now(),
  finished_at   timestamptz null,
  status        text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  trigger_input jsonb not null default '{}'::jsonb,
  steps         jsonb not null default '[]'::jsonb,        -- array of step entries
  final_context jsonb null,
  error         text null
);

-- ── 2. RLS ──────────────────────────────────────────────────────────────────
-- Tenant-scoped read; only the user who started the run (or another user in
-- the same tenant with whatsapp_automation.view) should see it. Since we
-- already filter by tenant_id in the API handler and service-role bypasses
-- RLS, the policy here is the defence-in-depth layer for direct PostgREST
-- access (which we don't expose today but might in the future).

alter table public.workflow_simulation_runs enable row level security;

drop policy if exists "wsr_tenant_read"  on public.workflow_simulation_runs;
drop policy if exists "wsr_no_direct_write" on public.workflow_simulation_runs;

-- Tenant members can read their own simulation history. We check user_role_assignments
-- for an active (disabled_at IS NULL) assignment. This matches the pattern used
-- in other tenant-scoped tables.
create policy "wsr_tenant_read"
  on public.workflow_simulation_runs
  for select
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments
      where user_id = auth.uid() and disabled_at is null
    )
  );

-- Writes only happen via the service-role client in the API handler; reject
-- everything else.
create policy "wsr_no_direct_write"
  on public.workflow_simulation_runs
  for all
  using (false)
  with check (false);

-- ── 3. Indexes ──────────────────────────────────────────────────────────────
-- The FE polls GET /api/workflow-simulations/:run_id by primary key — that's
-- free. The list-by-workflow lookup ("show me this workflow's recent test
-- runs") needs an index.

create index if not exists wsr_workflow_recent
  on public.workflow_simulation_runs(workflow_id, started_at desc);

-- Tenant-scoped sweep for retention jobs (we may garbage-collect runs older
-- than N days down the line). Partial index keeps it lean — only finished
-- runs are eligible for GC.
create index if not exists wsr_tenant_finished
  on public.workflow_simulation_runs(tenant_id, finished_at desc)
  where finished_at is not null;

-- "Show this user's running simulations" — used by the FE to refuse a second
-- concurrent simulate on the same workflow.
create index if not exists wsr_running_by_user
  on public.workflow_simulation_runs(started_by, started_at desc)
  where status = 'running';

-- ── 4. Comment ──────────────────────────────────────────────────────────────
comment on table public.workflow_simulation_runs is
  'Dry-run / simulation history for workflows. Each row is one end-to-end '
  'simulation: same executor as live, but all side-effecting ops (HTTP, '
  'queue enqueue, DB writes, payment links, AI inference, notifications) '
  'are short-circuited to synthetic outputs. The steps jsonb captures the '
  'per-node trace for the FE inspector.';

comment on column public.workflow_simulation_runs.steps is
  'JSON array of step entries. Each entry: { node_id, node_type, started_at, '
  'finished_at, input (interpolated cfg), simulated_output, would_have_done '
  '(human-readable string), kind (advance/wait_input/wait_delay/end/error), '
  'error? }. Appended atomically by the simulate-runner.';

comment on column public.workflow_simulation_runs.trigger_input is
  'The { trigger_input: {...} } body from the simulate POST. Seeded into '
  'session.variables before step 1 runs so workflow nodes can interpolate '
  'it. Captures the exact input that produced this trace for reproducibility.';
