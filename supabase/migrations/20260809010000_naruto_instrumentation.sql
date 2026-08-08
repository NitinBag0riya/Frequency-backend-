-- Naruto control-plane P2 — instrumentation scaffolding.
--
-- Additive tables + columns that turn "current state" into "movement over
-- time": true MRR trend/NRR, unified GMV, activation funnel, last-active. All
-- are write-when-a-worker-exists scaffolds — nothing reads them until wired, so
-- creating them is zero-risk and unblocks the Metrics screens. BETA-only apply.

-- ─── last-active (powers health + "last active", no messages scan) ──────────
alter table tenants add column if not exists last_active_at timestamptz;

-- ─── MRR snapshots — nightly write; unlocks trend/NRR/movement ──────────────
create table if not exists mrr_snapshots (
  id            bigint generated always as identity primary key,
  snapshot_date date not null,
  tenant_id     uuid references tenants(id) on delete cascade,
  plan_id       text,
  mrr_paise     bigint not null default 0,
  movement_type text,                      -- new|expansion|contraction|churn|flat
  created_at    timestamptz not null default now(),
  unique (snapshot_date, tenant_id)
);
create index if not exists mrr_snapshots_date_idx on mrr_snapshots(snapshot_date);
create index if not exists mrr_snapshots_tenant_idx on mrr_snapshots(tenant_id);

-- ─── Unified GMV rollup — one row per tenant/day/source ─────────────────────
create table if not exists platform_gmv_daily (
  id            bigint generated always as identity primary key,
  gmv_date      date not null,
  tenant_id     uuid references tenants(id) on delete cascade,
  business_type text,
  source        text not null,             -- aggregator|storefront|khata|pos
  gmv_paise     bigint not null default 0,
  order_count   int not null default 0,
  created_at    timestamptz not null default now(),
  unique (gmv_date, tenant_id, source)
);
create index if not exists platform_gmv_daily_date_idx on platform_gmv_daily(gmv_date);

-- ─── Activation funnel events — count-per-step, no min() archaeology ─────────
create table if not exists activation_events (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  step        text not null,               -- signup|connect_channel|first_catalog|first_order|first_broadcast
  occurred_at timestamptz not null default now(),
  unique (tenant_id, step)
);
create index if not exists activation_events_step_idx on activation_events(step);

-- Reads are platform-only (service role bypasses RLS); enable RLS with no
-- public policy so tenants can't read cross-tenant instrumentation.
alter table mrr_snapshots enable row level security;
alter table platform_gmv_daily enable row level security;
alter table activation_events enable row level security;
