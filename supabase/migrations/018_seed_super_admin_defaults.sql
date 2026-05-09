-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 018 — Seed default plans, roles, approval rules, feature flags.
--
-- Idempotent — every insert uses ON CONFLICT DO NOTHING / DO UPDATE so this
-- file can be re-run safely without duplicating data.
-- All numbers (limits, freemium caps, approval thresholds) are stored as data
-- so super admins can edit them via /admin/* pages without code changes.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Plans ───────────────────────────────────────────────────────────────
-- limits keys (used by checkPermission quota gate + UI usage bars):
--   messages_per_month, contacts_max, broadcasts_per_day, ai_tokens_per_month,
--   team_size_max, workflows_max, custom_roles_allowed
-- features list = whitelist of feature keys (e.g. 'broadcasts','workflows','ai_responder',
--   'custom_roles','impersonation_audit_export','meta_ads','telegram','instagram')
-- freemium_caps (only used on 'free' plan): per-feature daily/monthly caps
--   beyond which the feature is gated.

insert into public.plans (id, name, monthly_price_inr, trial_days, features, limits, freemium_caps, sort_order) values
  ('free',     'Free',
    0, 0,
    -- Free features (always available regardless of paid plan)
    ARRAY['inbox','contacts','broadcasts','templates','workflows','whatsapp','ai_responder']::text[],
    jsonb_build_object(
      'messages_per_month', 1000,
      'contacts_max', 500,
      'broadcasts_per_day', 1,
      'ai_tokens_per_month', 50000,
      'team_size_max', 2,
      'workflows_max', 3,
      'custom_roles_allowed', false
    ),
    jsonb_build_object(
      'inbox_replies',          jsonb_build_object('limit', -1,    'period', 'never'),
      'wa_template_send',       jsonb_build_object('limit', 100,   'period', 'day'),
      'broadcasts',             jsonb_build_object('limit', 1,     'period', 'month',  'recipients_max', 50),
      'workflow_runs',          jsonb_build_object('limit', 100,   'period', 'day'),
      'ai_responder',           jsonb_build_object('limit', 50,    'period', 'day'),
      'contacts',               jsonb_build_object('limit', 500,   'period', 'lifetime')
    ),
    1
  ),
  ('starter',  'Starter',
    1499, 14,
    ARRAY['inbox','contacts','broadcasts','templates','workflows','whatsapp','ai_responder','campaigns','razorpay','google_sheets','google_calendar','google_drive']::text[],
    jsonb_build_object(
      'messages_per_month', 10000,
      'contacts_max', 5000,
      'broadcasts_per_day', 5,
      'ai_tokens_per_month', 500000,
      'team_size_max', 5,
      'workflows_max', 10,
      'custom_roles_allowed', false
    ),
    '{}'::jsonb,
    2
  ),
  ('growth',   'Growth',
    3999, 14,
    ARRAY['inbox','contacts','broadcasts','templates','workflows','whatsapp','ai_responder','campaigns','razorpay','google_sheets','google_calendar','google_drive','google_gmail','meta_ads','telegram','instagram','airtable','shopify','custom_roles','approval_workflows']::text[],
    jsonb_build_object(
      'messages_per_month', 50000,
      'contacts_max', 50000,
      'broadcasts_per_day', 25,
      'ai_tokens_per_month', 5000000,
      'team_size_max', 25,
      'workflows_max', 50,
      'custom_roles_allowed', true
    ),
    '{}'::jsonb,
    3
  ),
  ('scale',    'Scale',
    -1, 14,                             -- -1 = custom pricing
    ARRAY['*']::text[],                 -- all features
    jsonb_build_object(
      'messages_per_month', -1,
      'contacts_max', -1,
      'broadcasts_per_day', -1,
      'ai_tokens_per_month', -1,
      'team_size_max', -1,
      'workflows_max', -1,
      'custom_roles_allowed', true
    ),
    '{}'::jsonb,
    4
  )
on conflict (id) do update set
  name              = EXCLUDED.name,
  monthly_price_inr = EXCLUDED.monthly_price_inr,
  trial_days        = EXCLUDED.trial_days,
  features          = EXCLUDED.features,
  limits            = EXCLUDED.limits,
  freemium_caps     = EXCLUDED.freemium_caps,
  sort_order        = EXCLUDED.sort_order,
  updated_at        = now();

-- Add legacy feature keys (whatsapp_automation, leads, integrations,
-- google_sheets, team, settings, tenant, billing) to every plan so the
-- pre-RBAC checkPermission middleware never gates paying users.
update public.plans
set features = (
  select array_agg(distinct f)
  from unnest(
    features || ARRAY['whatsapp_automation','leads','integrations','google_sheets','team','settings','tenant','billing']::text[]
  ) as f
)
where id in ('free','starter','growth','scale');

-- ── 2. Default tenant roles (11) ────────────────────────────────────────────
-- Permission shape: { '<feature>': { view, edit, delete } }
-- data_scope: own | department | team | all
-- allowed_apps: ['*'] = all, or specific connector keys

insert into public.role_definitions (scope, key, label, description, is_built_in, permissions, allowed_apps, data_scope) values
  ('tenant', 'owner', 'Owner', 'Founder / billing payer. Full access including billing and tenant deletion.', true,
    jsonb_build_object(
      'inbox',      jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'contacts',   jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'broadcasts', jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'campaigns',  jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'templates',  jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'workflows',  jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'analytics',  jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'integrations', jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'team',       jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'billing',    jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'settings',   jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'tenant',     jsonb_build_object('view', true, 'edit', true, 'delete', true)
    ),
    ARRAY['*']::text[], 'all'),

  ('tenant', 'workspace_admin', 'Workspace Admin', 'Operations head. Everything except billing and tenant deletion.', true,
    jsonb_build_object(
      'inbox',      jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'contacts',   jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'broadcasts', jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'campaigns',  jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'templates',  jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'workflows',  jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'analytics',  jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'integrations', jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'team',       jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'billing',    jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'settings',   jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'tenant',     jsonb_build_object('view', true, 'edit', false, 'delete', false)
    ),
    ARRAY['*']::text[], 'all'),

  ('tenant', 'sales_manager', 'Sales Manager', 'Sales team lead. All contacts, campaigns, broadcasts. Manages Sales reps.', true,
    jsonb_build_object(
      'inbox',      jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'contacts',   jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'broadcasts', jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'campaigns',  jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'templates',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'workflows',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'analytics',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'team',       jsonb_build_object('view', true, 'edit', false, 'delete', false)
    ),
    ARRAY['whatsapp','telegram','instagram','razorpay','google_sheets','google_calendar']::text[], 'team'),

  ('tenant', 'sales_rep', 'Sales Rep', 'Individual contributor. Own contacts, own broadcasts (scoped). No delete.', true,
    jsonb_build_object(
      'inbox',      jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'contacts',   jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'broadcasts', jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'campaigns',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'templates',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'workflows',  jsonb_build_object('view', true, 'edit', false, 'delete', false)
    ),
    ARRAY['whatsapp','telegram','instagram','razorpay']::text[], 'own'),

  ('tenant', 'marketing_manager', 'Marketing Manager', 'Marketing lead. All broadcasts, campaigns, templates, ad campaigns.', true,
    jsonb_build_object(
      'inbox',      jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'contacts',   jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'broadcasts', jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'campaigns',  jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'templates',  jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'workflows',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'analytics',  jsonb_build_object('view', true, 'edit', true, 'delete', false)
    ),
    ARRAY['whatsapp','telegram','instagram','meta_ads','google_sheets']::text[], 'all'),

  ('tenant', 'marketing_specialist', 'Marketing Specialist', 'Junior marketer. Creates broadcasts/campaigns as drafts (need approval).', true,
    jsonb_build_object(
      'inbox',      jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'contacts',   jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'broadcasts', jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'campaigns',  jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'templates',  jsonb_build_object('view', true, 'edit', true, 'delete', false)
    ),
    ARRAY['whatsapp','telegram','instagram']::text[], 'department'),

  ('tenant', 'support_lead', 'Customer Support Lead', 'Support manager. Full inbox, can reassign, escalations.', true,
    jsonb_build_object(
      'inbox',      jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'contacts',   jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'broadcasts', jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'templates',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'team',       jsonb_build_object('view', true, 'edit', true, 'delete', false)
    ),
    ARRAY['whatsapp','telegram','instagram']::text[], 'team'),

  ('tenant', 'support_agent', 'Customer Support Agent', 'Frontline agent. Assigned conversations only.', true,
    jsonb_build_object(
      'inbox',      jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'contacts',   jsonb_build_object('view', true, 'edit', false, 'delete', false)
    ),
    ARRAY['whatsapp','telegram','instagram']::text[], 'own'),

  ('tenant', 'automation_engineer', 'Automation Engineer', 'Workflow builder. Workflows, integrations, webhooks, API keys.', true,
    jsonb_build_object(
      'workflows',  jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'integrations', jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'templates',  jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'analytics',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'contacts',   jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'inbox',      jsonb_build_object('view', true, 'edit', false, 'delete', false)
    ),
    ARRAY['*']::text[], 'all'),

  ('tenant', 'finance', 'Finance', 'Billing, invoices, subscription, usage reports. No operational access.', true,
    jsonb_build_object(
      'billing',    jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'analytics',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'team',       jsonb_build_object('view', true, 'edit', false, 'delete', false)
    ),
    ARRAY[]::text[], 'all'),

  ('tenant', 'analyst', 'Analyst', 'Read-only across all features. Exports allowed.', true,
    jsonb_build_object(
      'inbox',      jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'contacts',   jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'broadcasts', jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'campaigns',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'templates',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'workflows',  jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'analytics',  jsonb_build_object('view', true, 'edit', false, 'delete', false)
    ),
    ARRAY['*']::text[], 'all')
on conflict (scope, key) where (is_built_in = true) do update set
  label       = EXCLUDED.label,
  description = EXCLUDED.description,
  permissions = EXCLUDED.permissions,
  allowed_apps = EXCLUDED.allowed_apps,
  data_scope  = EXCLUDED.data_scope,
  updated_at  = now();

-- ── 3. Default platform roles (6) ───────────────────────────────────────────

insert into public.role_definitions (scope, key, label, description, is_built_in, permissions, allowed_apps, data_scope) values
  ('platform', 'platform_owner', 'Platform Owner', 'Founder / CEO. God-mode. Everything across all tenants.', true,
    jsonb_build_object(
      'tenants',       jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'users',         jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'plans',         jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'roles',         jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'subscriptions', jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'audit',         jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'announcements', jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'feature_flags', jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'approval_rules',jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'impersonate',   jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'queues',        jsonb_build_object('view', true, 'edit', true, 'delete', false)
    ),
    ARRAY['*']::text[], 'all'),

  ('platform', 'customer_success', 'Customer Success', 'CSMs onboarding tenants. Impersonate, extend trials, change plans, view audit.', true,
    jsonb_build_object(
      'tenants',       jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'users',         jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'subscriptions', jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'audit',         jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'announcements', jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'impersonate',   jsonb_build_object('view', true, 'edit', true, 'delete', false)
    ),
    ARRAY['*']::text[], 'all'),

  ('platform', 'billing_ops', 'Billing Operations', 'Finance team. Subscriptions, refunds, invoices, dunning.', true,
    jsonb_build_object(
      'tenants',       jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'plans',         jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'subscriptions', jsonb_build_object('view', true, 'edit', true, 'delete', true),
      'audit',         jsonb_build_object('view', true, 'edit', false, 'delete', false)
    ),
    ARRAY[]::text[], 'all'),

  ('platform', 'engineering', 'Engineering', 'On-call / DevOps. Bull Board, queue admin, webhook health, error logs.', true,
    jsonb_build_object(
      'tenants',       jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'audit',         jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'feature_flags', jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'queues',        jsonb_build_object('view', true, 'edit', true, 'delete', false)
    ),
    ARRAY['*']::text[], 'all'),

  ('platform', 'trust_safety', 'Trust & Safety', 'Abuse / compliance. Suspend tenants, view content for moderation, audit access.', true,
    jsonb_build_object(
      'tenants',       jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'users',         jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'audit',         jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'announcements', jsonb_build_object('view', true, 'edit', true, 'delete', false),
      'impersonate',   jsonb_build_object('view', true, 'edit', true, 'delete', false)
    ),
    ARRAY['*']::text[], 'all'),

  ('platform', 'platform_sales', 'Sales / AE', 'Sales reps. View tenant list + usage, no destructive actions.', true,
    jsonb_build_object(
      'tenants',       jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'plans',         jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'subscriptions', jsonb_build_object('view', true, 'edit', false, 'delete', false),
      'audit',         jsonb_build_object('view', true, 'edit', false, 'delete', false)
    ),
    ARRAY[]::text[], 'all')
on conflict (scope, key) where (is_built_in = true) do update set
  label       = EXCLUDED.label,
  description = EXCLUDED.description,
  permissions = EXCLUDED.permissions,
  allowed_apps = EXCLUDED.allowed_apps,
  data_scope  = EXCLUDED.data_scope,
  updated_at  = now();

-- ── 4. Default approval rules (platform-level — apply to all tenants) ───────

insert into public.approval_rules (tenant_id, action_type, threshold_metric, threshold_value, required_role, notes) values
  (NULL, 'broadcast.send',         'recipients', 5000, 'workspace_admin', 'Broadcasts to >5,000 recipients require Workspace Admin approval'),
  (NULL, 'contact.bulk_delete',    'count',      100,  'workspace_admin', 'Bulk delete >100 contacts requires Workspace Admin approval'),
  (NULL, 'template.create',         null,        null, 'workspace_admin', 'New WhatsApp template submission to Meta requires admin approval'),
  (NULL, 'integration.connect_paid', 'spend_inr', 0,   'owner',           'Connecting paid integrations (Meta Ads, etc.) requires Owner approval')
on conflict do nothing;

-- ── 5. Default feature flags ─────────────────────────────────────────────────

insert into public.feature_flags (key, is_enabled, value_json, description) values
  ('impersonation_ttl_minutes',  true,  jsonb_build_object('value', 60),    'Auto-expire impersonation sessions after N minutes'),
  ('audit_retention_days',       true,  jsonb_build_object('value', 0),     'Retain audit log for N days. 0 = forever.'),
  ('soft_delete_grace_days',     true,  jsonb_build_object('value', 30),    'Soft-deleted tenants kept for N days before hard cascade'),
  ('suspension_freeze_workers',  true,  jsonb_build_object('value', true),  'When tenant suspended, freeze background workers (broadcasts, campaigns)'),
  ('suspension_freeze_webhooks', false, jsonb_build_object('value', false), 'When tenant suspended, drop incoming webhooks (default: keep receiving)'),
  ('invite_link_ttl_days',       true,  jsonb_build_object('value', 7),     'Pending invite expires after N days'),
  ('approval_request_ttl_hours', true,  jsonb_build_object('value', 48),    'Pending approval request auto-expires after N hours')
on conflict (key) do update set
  is_enabled = EXCLUDED.is_enabled,
  value_json = EXCLUDED.value_json,
  description = EXCLUDED.description,
  updated_at = now();

-- ── 6. Done ─────────────────────────────────────────────────────────────────
