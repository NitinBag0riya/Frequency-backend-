-- ────────────────────────────────────────────────────────────────────────
-- 114_sites_plan_quotas.sql
--
-- Adds Sites + Pages-per-site columns to plan_quotas, leaves them null on
-- every tier (= unlimited). MVP ships without enforcement — these columns
-- exist so a future BE patch can wire `if quota.max_sites_per_tenant
-- and existing >= quota.max_sites_per_tenant then 402` without another
-- schema migration.
--
-- Same shape as the existing forms-quota columns. The forms-helpers
-- /api/forms-helpers/plan endpoint already surfaces every column on
-- plan_quotas to the FE so the SitesListPage will see these fields
-- automatically once they're populated.
-- ────────────────────────────────────────────────────────────────────────

alter table public.plan_quotas
  add column if not exists max_sites_per_tenant integer,
  add column if not exists max_pages_per_site   integer;

-- All tiers null = unlimited. Wire enforcement when product wants the
-- pressure point — likely once free-tier squatting becomes a problem.
-- (No UPDATE statement on purpose: pre-existing rows already have null
--  for the new columns.)

comment on column public.plan_quotas.max_sites_per_tenant is
  'Hard cap on sites a tenant can own. null = unlimited. Enforcement deferred from MVP — column reserved for future POST /api/sites gate.';
comment on column public.plan_quotas.max_pages_per_site is
  'Hard cap on pages within one Site. null = unlimited. Enforcement deferred from MVP — column reserved for future POST /api/sites/:id/pages gate.';
