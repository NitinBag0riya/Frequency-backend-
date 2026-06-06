-- ─────────────────────────────────────────────────────────────────────────────
-- Operator Agent — autonomous "SellerClaw-style" operator on top of the
-- existing connector tool layer.
--
-- Two tables, both tenant-scoped + RLS:
--   • operator_runs   — one row per agent run (goal → result). Stores the
--                       Anthropic conversation `messages` so an approval
--                       pause can be resumed without re-reasoning.
--   • operator_steps  — the visible trace: reasoning / tool_call / tool_result
--                       / approval / final / error. The FE renders these as
--                       the 3-column Reasoning · Tool calls · Output trace.
--
-- Additive only. No existing table is altered. Filename is timestamped to
-- avoid colliding with numeric migrations on parallel branches.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── operator_runs ────────────────────────────────────────────────────────────
create table if not exists public.operator_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  created_by    uuid references auth.users(id) on delete set null,
  goal          text not null,
  -- 'suggest' = plan only, never execute writes;
  -- 'approve' = execute reads freely, queue risky writes for approval;
  -- 'auto'    = execute everything within the tool catalog (still logged).
  autonomy      text not null default 'approve'
                check (autonomy in ('suggest','approve','auto')),
  status        text not null default 'running'
                check (status in ('running','awaiting_approval','completed','failed','cancelled')),
  model         text,
  -- Anthropic message history (for resume after an approval pause). Never
  -- contains secrets — only goal text, tool names, args, and tool results.
  messages      jsonb not null default '[]'::jsonb,
  result        text,          -- final natural-language summary from the agent
  error         text,
  max_steps     int  not null default 12,
  step_count    int  not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists operator_runs_tenant  on public.operator_runs(tenant_id, created_at desc);
create index if not exists operator_runs_status  on public.operator_runs(tenant_id, status);

alter table public.operator_runs enable row level security;

create policy "operator_runs_tenant_rw" on public.operator_runs
  for all to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
    )
  )
  with check (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
    )
  );

-- ── operator_steps ───────────────────────────────────────────────────────────
create table if not exists public.operator_steps (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references public.operator_runs(id) on delete cascade,
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  idx                 int  not null,         -- ordering within the run
  kind                text not null
                      check (kind in ('reasoning','tool_call','tool_result','approval','final','error')),
  title               text,                  -- short label for the trace row
  thought             text,                  -- reasoning text (kind='reasoning'/'final')
  tool_op             text,                  -- connector op id (kind='tool_call'/'tool_result')
  tool_args           jsonb,
  tool_output         jsonb,
  risk_tier           text check (risk_tier in ('read','reversible','irreversible')),
  approval_request_id uuid,                  -- FK-soft link to approval_requests when gated
  status              text not null default 'ok'
                      check (status in ('ok','awaiting_approval','approved','rejected','error')),
  created_at          timestamptz not null default now()
);

create index if not exists operator_steps_run on public.operator_steps(run_id, idx);
create index if not exists operator_steps_pending
  on public.operator_steps(tenant_id, status) where status = 'awaiting_approval';

alter table public.operator_steps enable row level security;

create policy "operator_steps_tenant_rw" on public.operator_steps
  for all to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
    )
  )
  with check (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
    )
  );

-- keep updated_at fresh on operator_runs
create or replace function public.touch_operator_runs_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_operator_runs_touch on public.operator_runs;
create trigger trg_operator_runs_touch
  before update on public.operator_runs
  for each row execute function public.touch_operator_runs_updated_at();
