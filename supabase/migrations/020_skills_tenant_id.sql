-- Migration 020 — workflow_skills: tenant-scoped from the start.
--
-- Note: 004_skills.sql was never applied in production, so we create the
-- table fresh here with tenant_id baked in (no backfill needed). The
-- table holds reusable workflow blueprints that the AI workflow parser
-- matches user intent against.
--
-- Scoping model:
--   * Global skills:  tenant_id IS NULL, is_global = TRUE  (platform-curated)
--   * Tenant skills:  tenant_id NOT NULL                   (workspace-private)
--
-- A user (single auth.uid) may belong to multiple workspaces; without
-- tenant_id their custom skills would surface across workspaces and leak
-- workflow IP across organisations. Hence tenant_id is the source of truth.

create table if not exists public.workflow_skills (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references public.tenants(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,
  name          text not null,
  description   text not null,
  tags          text[] default '{}',
  workflow_json jsonb not null,
  usage_count   integer default 0,
  is_global     boolean default false,
  created_at    timestamptz default now(),
  -- Either the row is global, or it must belong to a tenant.
  constraint workflow_skills_scope_check
    check (is_global = true or tenant_id is not null)
);

-- Idempotent column add for re-runs against partially-applied schemas.
alter table public.workflow_skills
  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;

create index if not exists workflow_skills_tenant_id_idx
  on public.workflow_skills(tenant_id) where tenant_id is not null;
create index if not exists workflow_skills_global_idx
  on public.workflow_skills(is_global) where is_global = true;

alter table public.workflow_skills enable row level security;

-- Drop legacy policies if they exist (from the never-applied 004 migration).
drop policy if exists "Users see own and global skills" on public.workflow_skills;
drop policy if exists "Users manage own skills" on public.workflow_skills;
drop policy if exists "Tenant members see workspace + global skills" on public.workflow_skills;
drop policy if exists "Tenant members mutate workspace skills" on public.workflow_skills;

-- A row is visible if it's global OR the requester is a member of the
-- tenant (via user_role_assignments) or the literal tenant owner.
create policy "Tenant members see workspace + global skills"
  on public.workflow_skills for select
  using (
    is_global = true
    or exists (
      select 1 from public.user_role_assignments a
      where a.user_id = auth.uid() and a.tenant_id = workflow_skills.tenant_id
    )
    or exists (
      select 1 from public.tenants t
      where t.id = workflow_skills.tenant_id and t.user_id = auth.uid()
    )
  );

-- Mutations are restricted to the tenant's members; global skills are
-- platform-managed and not editable through this RLS path.
create policy "Tenant members mutate workspace skills"
  on public.workflow_skills for all
  using (
    tenant_id is not null and (
      exists (
        select 1 from public.user_role_assignments a
        where a.user_id = auth.uid() and a.tenant_id = workflow_skills.tenant_id
      )
      or exists (
        select 1 from public.tenants t
        where t.id = workflow_skills.tenant_id and t.user_id = auth.uid()
      )
    )
  );
