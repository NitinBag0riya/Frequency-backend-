-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 20260814 — Naruto Platform OS: capability model + audit diff columns
--
-- Part I §1 (Access & permission model). ADDITIVE + idempotent:
--   1. Extend super_admin_audit with capability + before_json/after_json so the
--      platform-audit service can record a proper before→after diff per §1.2.
--      Legacy `action`/`payload` columns are untouched (existing reader + the
--      tenant_audit_slice view keep working).
--   2. Seed the six canonical platform roles from §1.1 into role_definitions.
--      `platform_owner` already exists (migration 018) — re-upserted unchanged.
--      The five new keys become assignable. The pre-existing platform seeds
--      (customer_success/billing_ops/engineering/trust_safety/platform_sales)
--      are LEFT IN PLACE and alias onto these six in code (platform-rbac.ts
--      LEGACY_ROLE_ALIAS) — nothing is deleted.
--
-- Capability sets themselves live in code (platform-rbac.ts), the single source
-- of truth the server enforces. The `permissions` matrix seeded here keeps the
-- legacy requirePlatformPerm(feature, action) guard on not-yet-migrated
-- endpoints sane for these roles.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Audit diff columns ────────────────────────────────────────────────────
alter table public.super_admin_audit
  add column if not exists capability  text,
  add column if not exists before_json jsonb,
  add column if not exists after_json  jsonb;

create index if not exists audit_capability_time
  on public.super_admin_audit(capability, created_at desc);

-- ── 2. Seed the six canonical platform roles ─────────────────────────────────
insert into public.role_definitions (scope, key, label, description, is_built_in, permissions, allowed_apps, data_scope) values
  ('platform', 'platform_owner', 'Platform Owner',
    'Everything, incl. platform team, breach notifications, destructive ops.', true,
    jsonb_build_object(
      'tenants',        jsonb_build_object('view', true, 'edit', true,  'delete', true),
      'users',          jsonb_build_object('view', true, 'edit', true,  'delete', true),
      'plans',          jsonb_build_object('view', true, 'edit', true,  'delete', true),
      'roles',          jsonb_build_object('view', true, 'edit', true,  'delete', true),
      'subscriptions',  jsonb_build_object('view', true, 'edit', true,  'delete', true),
      'audit',          jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'announcements',  jsonb_build_object('view', true, 'edit', true,  'delete', true),
      'feature_flags',  jsonb_build_object('view', true, 'edit', true,  'delete', true),
      'approval_rules', jsonb_build_object('view', true, 'edit', true,  'delete', true),
      'impersonate',    jsonb_build_object('view', true, 'edit', true,  'delete', false),
      'queues',         jsonb_build_object('view', true, 'edit', true,  'delete', false)
    ),
    ARRAY['*']::text[], 'all'),

  ('platform', 'platform_admin', 'Platform Admin',
    'Tenants, entitlements, plans, roles, flags, announcements, approval rules. No platform-team mgmt, no tenant deletion, no payout account changes.', true,
    jsonb_build_object(
      'tenants',        jsonb_build_object('view', true, 'edit', true,  'delete', false),
      'plans',          jsonb_build_object('view', true, 'edit', true,  'delete', false),
      'roles',          jsonb_build_object('view', true, 'edit', true,  'delete', false),
      'subscriptions',  jsonb_build_object('view', true, 'edit', true,  'delete', false),
      'audit',          jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'announcements',  jsonb_build_object('view', true, 'edit', true,  'delete', false),
      'feature_flags',  jsonb_build_object('view', true, 'edit', true,  'delete', false),
      'approval_rules', jsonb_build_object('view', true, 'edit', true,  'delete', false),
      'impersonate',    jsonb_build_object('view', true, 'edit', true,  'delete', false)
    ),
    ARRAY['*']::text[], 'all'),

  ('platform', 'platform_finance', 'Platform Finance',
    'Payments, gateway config, Route accounts, splits, payouts, refunds, plan pricing, revenue. No feature config, no impersonation.', true,
    jsonb_build_object(
      'tenants',        jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'plans',          jsonb_build_object('view', true, 'edit', true,  'delete', false),
      'subscriptions',  jsonb_build_object('view', true, 'edit', true,  'delete', false),
      'audit',          jsonb_build_object('view', true, 'edit', false, 'delete', false)
    ),
    ARRAY[]::text[], 'all'),

  ('platform', 'platform_onboarding', 'Platform Onboarding',
    'Create tenants, run onboarding wizard, imports, go-live checklist, seed data. No plan pricing, no payments config, no deletion.', true,
    jsonb_build_object(
      'tenants',        jsonb_build_object('view', true, 'edit', true,  'delete', false),
      'subscriptions',  jsonb_build_object('view', true, 'edit', true,  'delete', false),
      'audit',          jsonb_build_object('view', true, 'edit', false, 'delete', false)
    ),
    ARRAY['*']::text[], 'all'),

  ('platform', 'platform_support', 'Platform Support',
    'Read tenant config, impersonate (time-boxed, reason-gated), diagnostics, one-click fixes, resend invites. No plan/entitlement/payment writes.', true,
    jsonb_build_object(
      'tenants',        jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'subscriptions',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'audit',          jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'impersonate',    jsonb_build_object('view', true, 'edit', true,  'delete', false)
    ),
    ARRAY['*']::text[], 'all'),

  ('platform', 'platform_readonly', 'Platform Read-only',
    'View all except credentials and raw PII. No writes.', true,
    jsonb_build_object(
      'tenants',        jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'plans',          jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'subscriptions',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'audit',          jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'announcements',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'feature_flags',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'approval_rules', jsonb_build_object('view', true, 'edit', false, 'delete', false)
    ),
    ARRAY[]::text[], 'all')
on conflict (scope, key) where (is_built_in = true) do update set
  label       = EXCLUDED.label,
  description = EXCLUDED.description,
  permissions = EXCLUDED.permissions,
  allowed_apps = EXCLUDED.allowed_apps,
  data_scope  = EXCLUDED.data_scope,
  updated_at  = now();

-- ── 3. Impersonation TTL default → 30 min (spec §1.2) ────────────────────────
-- Was seeded at 60 in migration 018. The code fallback is 30; align the flag so
-- the two agree. Only touches the value, leaves is_enabled/description.
update public.feature_flags
  set value_json = jsonb_build_object('value', 30), updated_at = now()
  where key = 'impersonation_ttl_minutes';
