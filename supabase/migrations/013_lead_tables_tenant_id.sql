-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 013 — Add tenant_id to all lead_* tables
--
-- Background: scripts/009_lead_intake.sql created the lead intake module with
-- only user_id columns. Migration 008 added tenant_id to other tables but
-- skipped the lead_* tables. The src/leads.ts router queries `.eq('tenant_id',
-- tenantId)` everywhere, so every lead-tables endpoint currently returns
-- "column lead_tables.tenant_id does not exist".
--
-- This migration:
--   1. Adds tenant_id to each of the 5 lead_* tables
--   2. Back-fills from user_id → that user's first active tenant
--   3. Adds (tenant_id) indexes for the hot-path queries
--   4. Updates RLS policies to allow access via tenant ownership
--   5. Leaves user_id columns intact (legacy compatibility)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Add tenant_id columns ─────────────────────────────────────────────────
alter table public.lead_tables
  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.lead_columns
  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.lead_rows
  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.lead_field_mappings
  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.lead_assignment_rules
  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;

-- ── 2. Back-fill from user_id ────────────────────────────────────────────────
-- For every lead_* row, find the user's oldest active tenant and link to it.
update public.lead_tables t
set tenant_id = (
  select tn.id from public.tenants tn
  where tn.user_id = t.user_id and tn.status = 'active'
  order by tn.created_at limit 1
)
where t.tenant_id is null and t.user_id is not null;

update public.lead_columns t
set tenant_id = (
  select tn.id from public.tenants tn
  where tn.user_id = t.user_id and tn.status = 'active'
  order by tn.created_at limit 1
)
where t.tenant_id is null and t.user_id is not null;

update public.lead_rows t
set tenant_id = (
  select tn.id from public.tenants tn
  where tn.user_id = t.user_id and tn.status = 'active'
  order by tn.created_at limit 1
)
where t.tenant_id is null and t.user_id is not null;

update public.lead_field_mappings t
set tenant_id = (
  select tn.id from public.tenants tn
  where tn.user_id = t.user_id and tn.status = 'active'
  order by tn.created_at limit 1
)
where t.tenant_id is null and t.user_id is not null;

update public.lead_assignment_rules t
set tenant_id = (
  select tn.id from public.tenants tn
  where tn.user_id = t.user_id and tn.status = 'active'
  order by tn.created_at limit 1
)
where t.tenant_id is null and t.user_id is not null;

-- ── 3. Indexes for the hot-path tenant filter ────────────────────────────────
create index if not exists lead_tables_tenant            on public.lead_tables(tenant_id);
create index if not exists lead_columns_tenant           on public.lead_columns(tenant_id);
create index if not exists lead_rows_tenant              on public.lead_rows(tenant_id);
create index if not exists lead_field_mappings_tenant    on public.lead_field_mappings(tenant_id);
create index if not exists lead_assignment_rules_tenant  on public.lead_assignment_rules(tenant_id);

-- Composite for the most common list-by-table query (table_id is already in 009)
create index if not exists lead_rows_tenant_table on public.lead_rows(tenant_id, table_id, created_at desc);

-- ── 4. RLS — replace user_id-only policies with tenant-aware ones ────────────
-- The server uses service_role (which bypasses RLS), but FE direct reads via
-- supabase-js need RLS to allow tenant-scoped access too.
do $$ begin
  -- lead_tables
  drop policy if exists "lead_tables_own"    on public.lead_tables;
  drop policy if exists "lead_tables_tenant" on public.lead_tables;
  create policy "lead_tables_tenant" on public.lead_tables for all using (
    auth.uid() = user_id
    or exists (select 1 from public.tenants tn where tn.id = lead_tables.tenant_id and tn.user_id = auth.uid())
    or exists (select 1 from public.user_roles r where r.tenant_id = lead_tables.tenant_id and r.user_id = auth.uid())
  );

  drop policy if exists "lead_columns_own"    on public.lead_columns;
  drop policy if exists "lead_columns_tenant" on public.lead_columns;
  create policy "lead_columns_tenant" on public.lead_columns for all using (
    auth.uid() = user_id
    or exists (select 1 from public.tenants tn where tn.id = lead_columns.tenant_id and tn.user_id = auth.uid())
    or exists (select 1 from public.user_roles r where r.tenant_id = lead_columns.tenant_id and r.user_id = auth.uid())
  );

  drop policy if exists "lead_rows_own"    on public.lead_rows;
  drop policy if exists "lead_rows_tenant" on public.lead_rows;
  create policy "lead_rows_tenant" on public.lead_rows for all using (
    auth.uid() = user_id
    or exists (select 1 from public.tenants tn where tn.id = lead_rows.tenant_id and tn.user_id = auth.uid())
    or exists (select 1 from public.user_roles r where r.tenant_id = lead_rows.tenant_id and r.user_id = auth.uid())
  );

  drop policy if exists "lead_mappings_own"          on public.lead_field_mappings;
  drop policy if exists "lead_field_mappings_tenant" on public.lead_field_mappings;
  create policy "lead_field_mappings_tenant" on public.lead_field_mappings for all using (
    auth.uid() = user_id
    or exists (select 1 from public.tenants tn where tn.id = lead_field_mappings.tenant_id and tn.user_id = auth.uid())
    or exists (select 1 from public.user_roles r where r.tenant_id = lead_field_mappings.tenant_id and r.user_id = auth.uid())
  );

  drop policy if exists "lead_rules_own"               on public.lead_assignment_rules;
  drop policy if exists "lead_assignment_rules_tenant" on public.lead_assignment_rules;
  create policy "lead_assignment_rules_tenant" on public.lead_assignment_rules for all using (
    auth.uid() = user_id
    or exists (select 1 from public.tenants tn where tn.id = lead_assignment_rules.tenant_id and tn.user_id = auth.uid())
    or exists (select 1 from public.user_roles r where r.tenant_id = lead_assignment_rules.tenant_id and r.user_id = auth.uid())
  );
end $$;
