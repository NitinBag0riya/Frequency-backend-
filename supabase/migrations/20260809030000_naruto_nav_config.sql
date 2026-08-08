-- Naruto control-plane round-2 — data-driven nav + per-feature config.
--
-- Additive only (IF NOT EXISTS / ON CONFLICT). BETA-only apply. Adds:
--   1. nav_overrides  — per-tenant sidebar customization (hide/rename/reorder/pin)
--   2. tenant_config  — per-tenant feature option overrides (layer 3)
--   3. plan_config    — per-plan feature option overrides (layer 2)
--   + seeds features.config_schema for POS + Appointments (the option pattern)
--
-- The three-layer config resolver reads:
--   getConfig(tenant, 'pos.tax_mode') =
--       tenant_config(tenant, key)      -- 3. per-tenant override   (highest)
--    ?? plan_config(plan, key)          -- 2. per-plan override
--    ?? features.config_schema default  -- 1. platform default      (lowest)

-- ─── 1. nav_overrides — per-tenant sidebar customization ────────────────────
create table if not exists nav_overrides (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  item_key    text not null,               -- stable nav item key (e.g. 'pos', 'khata')
  hidden      boolean not null default false,
  sort_order  int,                          -- null = keep registry order
  label       text,                         -- null = keep registry label
  pinned      boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, item_key)
);
create index if not exists nav_overrides_tenant_idx on nav_overrides(tenant_id);

-- ─── 2. tenant_config — per-tenant feature option overrides ─────────────────
create table if not exists tenant_config (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  config_key  text not null,               -- namespaced 'feature.option' e.g. 'pos.tax_mode'
  value       jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (tenant_id, config_key)
);
create index if not exists tenant_config_tenant_idx on tenant_config(tenant_id);

-- ─── 3. plan_config — per-plan feature option overrides ─────────────────────
create table if not exists plan_config (
  plan_id     text not null references plans(id) on delete cascade,
  config_key  text not null,
  value       jsonb,
  updated_at  timestamptz not null default now(),
  primary key (plan_id, config_key)
);

-- ─── RLS: writes stay server-side (service role bypasses). No public policy
--          → direct client reads are denied; the FE goes through the API. ─────
alter table nav_overrides enable row level security;
alter table tenant_config enable row level security;
alter table plan_config   enable row level security;

-- ─── Seed features.config_schema for the two pattern features ───────────────
-- Shape: { "options": [ { key, label, type, default, options? } ] }
update features set config_schema = '{
  "options": [
    { "key": "tax_mode", "label": "Tax mode", "type": "enum", "options": ["exclusive","inclusive"], "default": "exclusive",
      "help": "Exclusive charges GST on top of the listed price; inclusive treats price as tax-inclusive." },
    { "key": "service_charge_pct", "label": "Service charge (%)", "type": "number", "default": 0,
      "help": "Optional service charge added to the bill." },
    { "key": "round_off", "label": "Round off totals", "type": "boolean", "default": true }
  ]
}'::jsonb
where key = 'pos';

update features set config_schema = '{
  "options": [
    { "key": "lead_time_minutes", "label": "Minimum booking lead time (minutes)", "type": "number", "default": 60,
      "help": "Customers cannot book a slot sooner than this many minutes from now." },
    { "key": "cancellation_window_hours", "label": "Cancellation window (hours)", "type": "number", "default": 24,
      "help": "How long before an appointment a customer may cancel without penalty." },
    { "key": "allow_double_booking", "label": "Allow double booking per stylist", "type": "boolean", "default": false }
  ]
}'::jsonb
where key = 'appointments';
