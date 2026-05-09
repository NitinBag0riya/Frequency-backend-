-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 017 — Super Admin / Plans / RBAC redesign / Workflow recommendations
--
-- Single migration that lands:
--   1. Plans + subscriptions + entitlements + usage counters
--   2. Audit log + announcements + feature flags
--   3. Org-style RBAC: role_definitions (replaces user_roles + role_permissions)
--      + departments + label overrides
--   4. Approval rules + approval requests
--   5. Pending invites (Supabase auth-admin invited users)
--   6. Workflow recommendations cache
--
-- Idempotent — safe to re-run. Existing user_roles rows are NOT dropped here;
-- A6 (separate seeder) auto-maps them into user_role_assignments and shows a
-- review banner.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Plans / subscriptions / entitlements / usage ─────────────────────────

create table if not exists public.plans (
  id              text primary key,                          -- 'free','starter','growth','scale'
  name            text not null,
  monthly_price_inr numeric(12,2) default 0,
  trial_days      int default 14,
  features        text[] not null default '{}',              -- whitelisted feature keys
  limits          jsonb not null default '{}'::jsonb,        -- { messages_per_month, contacts_max, broadcasts_per_day, ai_tokens_per_month, team_size_max, … }
  freemium_caps   jsonb not null default '{}'::jsonb,        -- only meaningful on the 'free' row
  is_active       boolean default true,
  sort_order      int default 0,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table public.plans enable row level security;
create policy "plans_read_all" on public.plans for select using (true);
-- writes are guarded at the API layer (super_admin role check)

create table if not exists public.tenant_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid unique not null references public.tenants(id) on delete cascade,
  plan_id         text not null references public.plans(id),
  status          text not null default 'trial'
                  check (status in ('trial','active','past_due','cancelled','suspended')),
  trial_ends_at   timestamptz,
  current_period_start timestamptz default now(),
  current_period_end   timestamptz,
  razorpay_subscription_id text,
  cancelled_at    timestamptz,
  cancel_reason   text,
  metadata        jsonb default '{}'::jsonb,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table public.tenant_subscriptions enable row level security;
create policy "tenant_subs_own" on public.tenant_subscriptions for select using (
  exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
);

create index if not exists tenant_subs_status on public.tenant_subscriptions(status, current_period_end);

create table if not exists public.tenant_entitlements (
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  feature         text not null,
  is_enabled      boolean default true,
  override_reason text,
  granted_by      uuid references auth.users(id),
  granted_at      timestamptz default now(),
  expires_at      timestamptz,
  primary key (tenant_id, feature)
);

alter table public.tenant_entitlements enable row level security;
create policy "tenant_ent_read" on public.tenant_entitlements for select using (
  exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
);

-- Per-month rolling usage counters (refreshed by a cron worker; checkPermission reads)
create table if not exists public.tenant_usage (
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  metric          text not null,                              -- 'messages_outbound','broadcasts_sent','ai_tokens',…
  period_start    date not null,                              -- first of month
  count           bigint default 0,
  updated_at      timestamptz default now(),
  primary key (tenant_id, metric, period_start)
);

alter table public.tenant_usage enable row level security;
create policy "tenant_usage_read" on public.tenant_usage for select using (
  exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
);

create index if not exists tenant_usage_lookup on public.tenant_usage(tenant_id, metric, period_start);

-- ── 2. Audit / announcements / feature flags ────────────────────────────────

create table if not exists public.super_admin_audit (
  id               uuid primary key default gen_random_uuid(),
  actor_user_id    uuid references auth.users(id),
  actor_role       text,                                      -- 'platform_owner','customer_success',…
  action           text not null,                             -- 'tenant.suspend','user.disable','plan.change','impersonate.start',…
  target_tenant_id uuid references public.tenants(id) on delete set null,
  target_user_id   uuid references auth.users(id),
  payload          jsonb default '{}'::jsonb,                 -- before/after snapshot
  reason           text,                                      -- free-text from super-admin
  ip_address       inet,
  user_agent       text,
  created_at       timestamptz default now()
);

alter table public.super_admin_audit enable row level security;
-- Tenants can read filtered slices via a view (see end of migration)

create index if not exists audit_actor_time on public.super_admin_audit(actor_user_id, created_at desc);
create index if not exists audit_tenant_time on public.super_admin_audit(target_tenant_id, created_at desc);
create index if not exists audit_action_time on public.super_admin_audit(action, created_at desc);

create table if not exists public.platform_announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text,
  severity    text not null default 'info' check (severity in ('info','warning','incident')),
  audience    text default 'all',                             -- 'all','plan:free','plan:growth+',…
  starts_at   timestamptz default now(),
  ends_at     timestamptz,
  created_by  uuid references auth.users(id),
  created_at  timestamptz default now()
);

alter table public.platform_announcements enable row level security;
create policy "announce_read_all" on public.platform_announcements for select using (true);

create table if not exists public.feature_flags (
  key                  text primary key,                       -- 'impersonation_ttl_minutes','audit_retention_days',…
  is_enabled           boolean default false,
  rollout_percent      int default 0 check (rollout_percent between 0 and 100),
  enabled_for_tenants  uuid[] default '{}',
  value_json           jsonb default '{}'::jsonb,              -- for non-boolean settings
  description          text,
  updated_by           uuid references auth.users(id),
  updated_at           timestamptz default now()
);

alter table public.feature_flags enable row level security;
create policy "flags_read_all" on public.feature_flags for select using (true);

-- ── 3. RBAC redesign ────────────────────────────────────────────────────────

-- Departments are flat per-tenant org units. Single-membership in v1.
create table if not exists public.departments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  color       text default '#6b7280',
  created_at  timestamptz default now()
);

alter table public.departments enable row level security;
create policy "depts_read_own" on public.departments for select using (
  exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
);
create unique index if not exists depts_tenant_name on public.departments(tenant_id, name);

-- The single source of truth for both tenant + platform roles.
--   scope='tenant'   → roles inside a tenant (Owner, Sales Manager, etc.)
--   scope='platform' → super-admin tier roles (Platform Owner, CS, Billing, …)
-- Built-in roles have tenant_id IS NULL and is_built_in=true; custom roles
-- (Growth+ tenants) have tenant_id set.
create table if not exists public.role_definitions (
  id           uuid primary key default gen_random_uuid(),
  scope        text not null check (scope in ('tenant','platform')),
  key          text not null,                                  -- 'sales_rep','platform_owner',…
  label        text not null,
  description  text,
  is_built_in  boolean default false,
  tenant_id    uuid references public.tenants(id) on delete cascade, -- NULL for built-in
  -- Permission matrix: { 'broadcasts': {view:true,edit:true,delete:false}, … }
  permissions  jsonb not null default '{}'::jsonb,
  -- Apps/connectors this role can use: ['whatsapp','razorpay'] or ['*'] for all
  allowed_apps text[] not null default '{*}',
  -- Data scope: 'own' | 'department' | 'team' | 'all'
  data_scope   text not null default 'own' check (data_scope in ('own','department','team','all')),
  -- Plan gate (for built-in roles): minimum plan required to assign
  plan_min     text references public.plans(id),
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

alter table public.role_definitions enable row level security;
create policy "roles_read_all" on public.role_definitions for select using (true);

-- Built-in roles have a unique key per scope. Custom roles are unique per (tenant_id, key).
create unique index if not exists role_defs_builtin_key on public.role_definitions(scope, key) where is_built_in = true;
create unique index if not exists role_defs_custom_key on public.role_definitions(tenant_id, key) where is_built_in = false and tenant_id is not null;

-- Replaces user_roles. tenant_id NULL = platform-scoped (super admin).
create table if not exists public.user_role_assignments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  tenant_id     uuid references public.tenants(id) on delete cascade,  -- NULL = platform
  role_id       uuid not null references public.role_definitions(id) on delete restrict,
  department_id uuid references public.departments(id) on delete set null,
  -- User-level disable (applies even if role permissions allow):
  disabled_at   timestamptz,
  disabled_by   uuid references auth.users(id),
  disabled_reason text,
  invited_by    uuid references auth.users(id),
  invited_at    timestamptz,
  accepted_at   timestamptz,
  created_at    timestamptz default now()
);

alter table public.user_role_assignments enable row level security;
create policy "ura_read_self_or_tenant" on public.user_role_assignments for select using (
  user_id = auth.uid()
  or exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
);

-- One platform role per user (max). Many tenant roles per user (cross-tenant) but only one per tenant.
create unique index if not exists ura_user_tenant on public.user_role_assignments(user_id, tenant_id) where tenant_id is not null;
create unique index if not exists ura_user_platform on public.user_role_assignments(user_id) where tenant_id is null;
create index if not exists ura_tenant_lookup on public.user_role_assignments(tenant_id, disabled_at);

-- Per-tenant relabeling of built-in roles (e.g. "Sales Rep" → "Field Sales Executive")
create table if not exists public.role_label_overrides (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  role_id       uuid not null references public.role_definitions(id) on delete cascade,
  custom_label  text not null,
  updated_at    timestamptz default now(),
  primary key (tenant_id, role_id)
);

alter table public.role_label_overrides enable row level security;
create policy "rlo_read_own" on public.role_label_overrides for select using (
  exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
);

-- ── 4. Approval rules / requests ────────────────────────────────────────────

create table if not exists public.approval_rules (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid references public.tenants(id) on delete cascade,  -- NULL = platform default
  action_type     text not null,                                          -- 'broadcast.send','contact.bulk_delete','template.create','integration.connect_paid'
  threshold_metric text,                                                  -- 'recipients','count','spend_inr'
  threshold_value numeric,
  required_role   text not null,                                          -- minimum role key to approve, e.g. 'workspace_admin','owner'
  is_enabled      boolean default true,
  notes           text,
  updated_at      timestamptz default now()
);

alter table public.approval_rules enable row level security;
create policy "appr_rules_read_own" on public.approval_rules for select using (
  tenant_id is null
  or exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
);

create index if not exists appr_rules_lookup on public.approval_rules(tenant_id, action_type, is_enabled);

create table if not exists public.approval_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  requested_by    uuid not null references auth.users(id),
  action_type     text not null,
  target_payload  jsonb not null,
  status          text not null default 'pending' check (status in ('pending','approved','rejected','expired','cancelled')),
  approved_by     uuid references auth.users(id),
  approved_at     timestamptz,
  rejection_reason text,
  expires_at      timestamptz,
  created_at      timestamptz default now()
);

alter table public.approval_requests enable row level security;
create policy "appr_reqs_own" on public.approval_requests for all using (
  exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
);

create index if not exists appr_reqs_pending on public.approval_requests(tenant_id, status, created_at desc);

-- ── 5. Pending invites (Supabase auth-admin invited users) ──────────────────

create table if not exists public.pending_invites (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  email         text not null,
  role_id       uuid not null references public.role_definitions(id),
  department_id uuid references public.departments(id),
  invited_by    uuid not null references auth.users(id),
  invited_at    timestamptz default now(),
  expires_at    timestamptz default (now() + interval '7 days'),
  message       text,
  -- Token used by AcceptInvitePage; generated server-side, opaque to FE
  token         text not null unique,
  status        text not null default 'pending' check (status in ('pending','accepted','expired','cancelled')),
  accepted_at   timestamptz
);

alter table public.pending_invites enable row level security;
create policy "invites_own_tenant" on public.pending_invites for all using (
  exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
);

create unique index if not exists invites_active_unique on public.pending_invites(tenant_id, email) where status = 'pending';
create index if not exists invites_expiry on public.pending_invites(expires_at) where status = 'pending';

-- ── 6. Workflow recommendations cache ───────────────────────────────────────

-- Each row = a recommended workflow blueprint.
-- tenant_id NULL  → system default (AI-generated once, cached forever per app combo)
-- tenant_id SET   → tenant-specific customization (saved when user edits a default)
create table if not exists public.workflow_recommendations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid references public.tenants(id) on delete cascade,
  -- Sorted, comma-joined connector keys: e.g. 'razorpay,whatsapp'
  apps_signature   text not null,
  name             text not null,
  description      text,
  category         text,                                       -- 'lead_capture','payment','reminder','onboarding',…
  blueprint        jsonb not null,                             -- full workflow JSON (nodes, edges, config)
  generated_by_ai  boolean default true,
  use_count        int default 0,
  is_active        boolean default true,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

alter table public.workflow_recommendations enable row level security;
-- Public read for system defaults (tenant_id NULL); tenant-private for custom
create policy "wf_recos_read" on public.workflow_recommendations for select using (
  tenant_id is null
  or exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
);

create index if not exists wf_recos_signature on public.workflow_recommendations(apps_signature, is_active);
create unique index if not exists wf_recos_default_unique on public.workflow_recommendations(apps_signature, name) where tenant_id is null;

-- ── 7. Tenant: org_name + soft delete ───────────────────────────────────────

-- Migration 002 created tenants.business_name (populated from Meta during WABA
-- connect). For non-WhatsApp tenants this stays NULL. We rename to org_name
-- conceptually but keep the legacy column for back-compat. Just enforce via
-- onboarding capture that it's filled.
alter table public.tenants
  add column if not exists status_changed_at timestamptz,
  add column if not exists status_changed_by uuid references auth.users(id),
  add column if not exists status_change_reason text,
  add column if not exists deleted_at timestamptz;          -- soft-delete (status='deleted' + 30d grace)

-- Expand tenants.status enum
alter table public.tenants
  drop constraint if exists tenants_status_check;
alter table public.tenants
  add constraint tenants_status_check
  check (status in ('active','suspended','deleted','pending'));

create index if not exists tenants_status on public.tenants(status, deleted_at);

-- ── 8. Tenant-visible audit slice (filtered view) ───────────────────────────

create or replace view public.tenant_audit_slice as
  select id, action, payload, reason, created_at
  from public.super_admin_audit
  where action in (
    'tenant.suspend','tenant.reactivate','plan.change','subscription.extend_trial',
    'feature.enable','feature.disable'
  );

-- ── 9. Done ─────────────────────────────────────────────────────────────────
-- Seeds (default plans + default roles + default approval rules + default
-- feature flags) live in 018_seed_super_admin_defaults.sql so they can be
-- re-run safely without re-running the schema migration.
