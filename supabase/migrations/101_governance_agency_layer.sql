-- 101_governance_agency_layer
--
-- Adds the agency-level governance layer on top of migration 100.
-- Strictly additive — no destructive changes.
--
-- ─── What this migration creates ──────────────────────────────────────────
--
-- 1. agency_sub_accounts.governance_approval_mode
--    Per-link policy that decides WHO can approve a governance action
--    proposed on a sub-account tenant. Three modes:
--
--      tenant_only       — only tenant members of the sub-account
--                          (admin/owner). Agency members CANNOT approve
--                          even if they're members of the parent agency.
--      agency_or_tenant  — DEFAULT for agency-linked sub-accounts. Either
--                          a tenant member OR an agency member of the
--                          parent agency can approve, subject to the
--                          two-person rule (proposer ≠ approver).
--      agency_only       — only agency members can approve. Useful for
--                          single-operator sub-accounts (kirana shops
--                          where there's literally one human) so the
--                          two-person rule has somewhere to land.
--
-- 2. v_governance_actions_for_agency view
--    Cross-tenant SELECT that returns governance_actions belonging to
--    any tenant currently linked to a given agency (removed_at IS NULL).
--    The agency console reads through this view; RLS lets agency
--    members read rows for tenants they're linked to.
--
-- 3. Index on commerce_governance_actions(tenant_id, status, created_at)
--    Already created in 100 — no-op here.

set check_function_bodies = off;

-- ─── 1. governance_approval_mode column ──────────────────────────────────

alter table public.agency_sub_accounts
  add column if not exists governance_approval_mode text
  not null default 'agency_or_tenant'
  check (governance_approval_mode in ('tenant_only', 'agency_or_tenant', 'agency_only'));

comment on column public.agency_sub_accounts.governance_approval_mode is
  'Decides who can approve commerce_governance_actions for this sub-account: tenant_only (sub-account members only) | agency_or_tenant (default for agency links — either side, subject to two-person rule) | agency_only (single-operator sub-accounts that lack a second internal approver).';

-- ─── 2. View for agency-scoped governance reads ──────────────────────────
-- A view (not a function) so PostgREST can expose it directly and the
-- BE can apply additional filters without rewriting SQL.
--
-- Joins:
--   commerce_governance_actions → khaata_accounts (for the account-row payload)
--                              → agency_sub_accounts (to expose agency_id)
--                              → contacts (display name on the FE)
--
-- The agency_id projection lets the BE filter rows by the agency the
-- caller is a member of. Membership check stays in the route layer
-- (against agency_members) — we don't enforce it in RLS because the
-- BE uses service-role; if we ever expose this view directly to the
-- authenticated role we'll add a tenant_id-based RLS policy here.

create or replace view public.v_governance_actions_for_agency as
select
  a.id, a.tenant_id, a.action_type,
  a.account_id, a.settlement_id,
  a.proposed_by, a.approved_by, a.rejected_by,
  a.reason, a.rejection_reason, a.payload,
  a.amount_paise, a.status, a.applied_txn_id, a.apply_error,
  a.expires_at, a.approved_at, a.rejected_at, a.applied_at,
  a.created_at, a.updated_at,
  asa.agency_id,
  asa.governance_approval_mode,
  -- Lightweight tenant + contact metadata so the agency console can
  -- render rows without an extra round-trip per row.
  t.business_name as tenant_business_name,
  t.slug          as tenant_slug
from public.commerce_governance_actions a
join public.agency_sub_accounts asa
     on asa.tenant_id = a.tenant_id and asa.removed_at is null
join public.tenants t on t.id = a.tenant_id;

comment on view public.v_governance_actions_for_agency is
  'Cross-tenant view of governance actions, filterable by agency_id. Agency-console handlers select from this view + filter by the caller''s agency membership. Read-only (views over append-only tables).';

-- The view inherits the underlying table's RLS — and migration 100
-- already revoked write privileges from authenticated. So nothing more
-- to grant here. Read access flows through the BE service-role client
-- which the agency router uses.
