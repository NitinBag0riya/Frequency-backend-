-- Naruto control-plane P0 — entitlements foundation.
--
-- Adds the three-layer entitlements model on top of the existing `plans` +
-- `tenant_entitlements` rails (see 017_super_admin_rbac.sql):
--   1. features           — canonical registry of every gateable capability,
--                            its vertical applicability (HARD gate) + default.
--   2. plan_features       — plan -> feature grant matrix (replaces the loosely
--                            typed plans.features text[]; array kept readable).
--   3. tenant_entitlements — already exists; extended with quota_override jsonb
--                            so a per-tenant cap can beat plan.limits.
--   + plans.vertical       — vertical-scoped plans (HoReCa Growth != Salon Growth)
--   + tenants.business_type — the linchpin gating column, finally migrated.
--
-- All DDL is idempotent (IF NOT EXISTS / ON CONFLICT). BETA-only apply.

-- ─── tenants.business_type (was an ad-hoc prod column, no migration) ─────────
alter table tenants add column if not exists business_type text;

-- Backfill from tenant_branding.business_type where that column exists (some
-- envs mirror it there). Guarded so it is a no-op where the column is absent.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'tenant_branding' and column_name = 'business_type'
  ) then
    execute $backfill$
      update tenants t
         set business_type = b.business_type
        from tenant_branding b
       where b.tenant_id = t.id
         and t.business_type is null
         and b.business_type is not null
    $backfill$;
  end if;
end$$;

-- ─── Vertical-scoped plans ──────────────────────────────────────────────────
alter table plans add column if not exists vertical text not null default '*';

-- ─── 1. features registry ───────────────────────────────────────────────────
create table if not exists features (
  key             text primary key,
  name            text not null,
  description     text,
  category        text not null default 'platform',   -- commerce|engagement|ops|billing|platform
  verticals       text[] not null default '{*}',       -- '{*}'=all; else HARD gate to these business groups
  default_enabled boolean not null default false,
  gate_style      text not null default 'hidden',      -- hidden | locked_teaser | disabled
  is_action       boolean not null default false,
  config_schema   jsonb,                                -- P1: per-feature options (platform->plan->tenant)
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ─── 2. plan -> feature grant matrix ────────────────────────────────────────
create table if not exists plan_features (
  plan_id     text not null references plans(id) on delete cascade,
  feature_key text not null references features(key) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (plan_id, feature_key)
);
create index if not exists plan_features_feature_idx on plan_features(feature_key);

-- ─── 3. per-tenant quota override (extend existing tenant_entitlements) ──────
alter table tenant_entitlements add column if not exists quota_override jsonb;

-- ─── RLS: readable by anyone (mirrors role_definitions roles_read_all),
--          writes stay server-side via service role. ──────────────────────────
alter table features enable row level security;
alter table plan_features enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='features' and policyname='features_read_all') then
    create policy features_read_all on features for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='plan_features' and policyname='plan_features_read_all') then
    create policy plan_features_read_all on plan_features for select using (true);
  end if;
end$$;

-- ─── Seed the feature registry (idempotent upsert) ──────────────────────────
-- verticals use canonical business groups: horeca|salon|real_estate|d2c|other; '*' = all.
insert into features (key, name, description, category, verticals, default_enabled, gate_style, sort_order) values
  -- Cross-vertical platform baseline / upsell
  ('messaging',        'WhatsApp messaging',   'Send + receive on WhatsApp Business',      'engagement', '{*}',  true,  'hidden',        10),
  ('inbox',            'Unified Inbox',        'Single thread per contact across channels','engagement', '{*}',  true,  'hidden',        11),
  ('whatsapp',         'WhatsApp Cloud API',   'WhatsApp Business platform',               'engagement', '{*}',  true,  'hidden',        12),
  ('instagram',        'Instagram DMs',        'Direct messages + comment moderation',     'engagement', '{*}',  false, 'locked_teaser', 13),
  ('telegram',         'Telegram',             'Bot API, channels, mini-apps',             'engagement', '{*}',  false, 'locked_teaser', 14),
  ('templates',        'Message templates',    'Approved WhatsApp/IG templates',           'engagement', '{*}',  true,  'hidden',        15),
  ('broadcasts',       'Broadcasts',           'One-time blast campaigns',                 'engagement', '{*}',  false, 'locked_teaser', 16),
  ('broadcast',        'Broadcasts',           'Broadcast campaigns (alias)',              'engagement', '{*}',  false, 'locked_teaser', 17),
  ('campaigns',        'Campaigns',            'Drip sequences, triggered flows',          'engagement', '{*}',  false, 'locked_teaser', 18),
  ('workflows',        'Workflow Builder',     'Multi-step no-code automations',           'ops',        '{*}',  true,  'hidden',        19),
  ('whatsapp_automation','Workflows & Broadcasts','Umbrella workflow + broadcast access',  'ops',        '{*}',  true,  'hidden',        20),
  ('ai_responder',     'AI Auto-Replies',      'Frequency AI grounded on your docs',       'ops',        '{*}',  false, 'locked_teaser', 21),
  ('approval_workflows','Approval Workflows',  'Gate big-blast actions behind approval',   'ops',        '{*}',  false, 'locked_teaser', 22),
  ('contacts',         'Contacts',             'Address book with tags + attributes',      'engagement', '{*}',  true,  'hidden',        23),
  ('leads',            'Tables',               'General-purpose tables + assignment',      'ops',        '{*}',  true,  'hidden',        24),
  ('tables',           'Database tables',      'Lead/DB tables (multi-source)',            'ops',        '{*}',  false, 'locked_teaser', 25),
  ('analytics',        'Analytics',            'Funnel + engagement analytics',            'ops',        '{*}',  true,  'hidden',        26),
  ('web_push',         'Web Push',             'Browser push notifications',               'engagement', '{*}',  false, 'locked_teaser', 27),
  ('assets',           'Asset library',        'Tenant asset library',                     'ops',        '{*}',  true,  'hidden',        28),
  ('copilot',          'Copilot',              'In-app AI copilot',                        'ops',        '{*}',  false, 'locked_teaser', 29),
  ('api',              'API access',           'Programmatic API access',                  'platform',   '{*}',  false, 'locked_teaser', 30),
  ('custom_roles',     'Custom roles',         'Define roles beyond the built-ins',        'platform',   '{*}',  false, 'locked_teaser', 31),
  ('custom_rbac',      'Custom RBAC',          'Fine-grained role permissions',            'platform',   '{*}',  false, 'locked_teaser', 32),
  ('sso_saml',         'SSO / SAML',           'Enterprise single sign-on',                'platform',   '{*}',  false, 'locked_teaser', 33),
  ('remove_branding',  'Remove Frequency branding','White-label the storefront',           'platform',   '{*}',  false, 'locked_teaser', 34),
  ('integrations',     'Integrations panel',   'Connect / disconnect external apps',       'platform',   '{*}',  true,  'hidden',        35),
  ('team',             'Team & roles',         'Invite users, assign roles',               'platform',   '{*}',  true,  'hidden',        36),
  ('billing',          'Billing',              'Invoices, plan changes, receipts',         'billing',    '{*}',  true,  'hidden',        37),
  ('settings',         'Settings',             'Account + notification preferences',        'platform',   '{*}',  true,  'hidden',        38),
  ('tenant',           'Workspace',            'Workspace shell + nav',                     'platform',   '{*}',  true,  'hidden',        39),
  ('coupons',          'Coupons / offers',     'Discount codes + first-order offers',      'commerce',   '{horeca,salon,d2c,other}', false, 'locked_teaser', 40),
  ('loyalty',          'Loyalty',              'Points, tiers, rewards',                    'engagement', '{horeca,salon,d2c}', false, 'locked_teaser', 41),
  ('khata',            'Khata (ledger)',       'Customer ledger / dues',                    'commerce',   '{horeca,salon,d2c,other}', false, 'locked_teaser', 42),
  ('payments',         'Online payments',      'Payment gateway (1% platform)',            'commerce',   '{horeca,salon,d2c}', false, 'locked_teaser', 43),
  ('multi_outlet',     'Multi-outlet',         'Per-outlet data isolation',                 'ops',        '{horeca,salon}', false, 'locked_teaser', 44),
  -- HoReCa
  ('menu',             'Menu / catalog',       'HoReCa menu catalogue',                     'commerce',   '{horeca}', true,  'hidden',        50),
  ('pos',              'POS billing',          'Counter point-of-sale',                     'commerce',   '{horeca}', true,  'hidden',        51),
  ('kot',              'KOT',                  'Kitchen order ticket',                      'ops',        '{horeca}', true,  'hidden',        52),
  ('kds',              'KDS',                  'Kitchen display screen',                    'ops',        '{horeca}', false, 'locked_teaser', 53),
  ('scan_qr',          'Table QR / scan',      'Scan-to-order (on-premise)',                'commerce',   '{horeca}', false, 'locked_teaser', 54),
  ('aggregators',      'Aggregator orders',    'Swiggy / Zomato inbound',                   'commerce',   '{horeca}', false, 'locked_teaser', 55),
  ('agg_write',        'Aggregator write',     'Accept/toggle/menu push (NDA-gated)',       'commerce',   '{horeca}', false, 'disabled',      56),
  ('inventory',        'Inventory / stock',    'Stock tracking',                            'ops',        '{horeca}', false, 'locked_teaser', 57),
  ('order_sla',        'Order SLA alerts',     'Order-late worker + alerts',                'ops',        '{horeca}', false, 'locked_teaser', 58),
  ('staff_roles',      'Captain / kitchen roles','On-premise staff roles',                  'ops',        '{horeca}', false, 'locked_teaser', 59),
  ('tax',             'GST invoice / tax',     'India tax config',                          'billing',    '{horeca,d2c}', true, 'hidden',       60),
  -- Salon
  ('services',         'Services catalog',     'Bookable services',                         'commerce',   '{salon}', true,  'hidden',        70),
  ('appointments',     'Appointments',         'Calendar / bookings',                       'ops',        '{salon}', true,  'hidden',        71),
  ('packs',            'Packages / memberships','Per-category packages',                     'commerce',   '{salon}', false, 'locked_teaser', 72),
  ('booking_store',    'Online booking',       'Customer-facing booking mini-app',          'commerce',   '{salon}', false, 'locked_teaser', 73),
  ('roster',           'Staff roster',         'Stylist roster + commissions',              'ops',        '{salon}', false, 'locked_teaser', 74),
  ('reminders',        'Appointment reminders','WhatsApp/SMS appointment reminders',        'engagement', '{salon}', false, 'locked_teaser', 75),
  -- Real estate
  ('listings',         'Listings',             'Property listings / inventory',             'commerce',   '{real_estate}', true, 'hidden',    80),
  ('site_visits',      'Site visits',          'Site-visit scheduling',                     'ops',        '{real_estate}', false,'locked_teaser',81),
  ('lead_sources',     'Lead-source connectors','99acres / MagicBricks / Meta',             'ops',        '{real_estate}', false,'locked_teaser',82),
  ('agent_roles',      'Broker / agent roles', 'Agent assignment + roles',                  'ops',        '{real_estate}', false,'locked_teaser',83),
  ('nurture',          'Nurture workflows',    'WhatsApp drip / nurture',                   'engagement', '{real_estate}', false,'locked_teaser',84),
  -- D2C / commerce
  ('storefront',       'Storefront',           'Themed mini-app storefront',                'commerce',   '{d2c,horeca,salon,other}', true, 'hidden', 90),
  ('catalog',          'Product catalog',      'Products + variants + add-ons',             'commerce',   '{d2c,other}', true, 'hidden',      91),
  ('catalog_sources',  'Catalog sources',      'Sheets / Shopify / LeadTables',             'ops',        '{d2c,other}', false,'locked_teaser',92),
  ('shipping',         'Shipping / delivery',  'Shipping + delivery config',                'commerce',   '{d2c}', false, 'locked_teaser',   93),
  ('custom_domain',    'Custom domain',        'Vercel-backed custom domain',               'platform',   '{d2c,horeca,salon}', false,'locked_teaser',94),
  ('home_builder',     'Home layout builder',  'XStore-style home sections',                'commerce',   '{d2c}', false, 'locked_teaser',   95)
on conflict (key) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  verticals = excluded.verticals,
  default_enabled = excluded.default_enabled,
  gate_style = excluded.gate_style,
  sort_order = excluded.sort_order,
  updated_at = now();

-- ─── Backfill plan_features from the existing plans.features text[] ──────────
-- '*' in plans.features grants every registered feature. Keeps the array
-- readable for one release (nothing is dropped).
insert into plan_features (plan_id, feature_key)
select p.id, f.key
  from plans p
  join features f
    on (p.features @> array['*']::text[] or f.key = any(p.features))
 where p.scope = 'tenant'
on conflict (plan_id, feature_key) do nothing;
