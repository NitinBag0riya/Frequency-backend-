-- Naruto Platform OS §3 — plans, tiers & limits.
--
-- Extends the EXISTING rails (017 plans/tenant_subscriptions/tenant_entitlements
-- + 20260809 entitlements). Purely additive + idempotent. It never changes the
-- meaning of plans.limits jsonb — that stays the enforced HARD-cap map read by
-- lib/limits.ts + lib/quota.ts. Everything here layers on top.

-- ── Two-axis: an explicit tier so rows=vertical × cols=tier is unambiguous ────
-- plans.vertical already exists ('*' or a specific vertical) = the ROW axis.
-- tier = the COL axis. Backfill the five base rows from their id.
alter table public.plans add column if not exists tier text;
update public.plans set tier = id
 where tier is null and id in ('free','starter','growth','scale','enterprise');

-- ── Limits as first-class: soft (warn) caps live beside the hard caps ─────────
-- Hard caps stay in plans.limits (already enforced). soft_limits is the WARN
-- line only; an absent key = no soft warning for that limit.
alter table public.plans add column if not exists soft_limits jsonb not null default '{}'::jsonb;

-- ── Trials: length already exists (plans.trial_days). Add expiry behaviour. ───
alter table public.plans
  add column if not exists trial_expiry_behavior text not null default 'downgrade';
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'plans_trial_expiry_behavior_chk'
  ) then
    alter table public.plans
      add constraint plans_trial_expiry_behavior_chk
      check (trial_expiry_behavior in ('downgrade','suspend'));
  end if;
end $$;

-- ── Versioned plans: bump on every pricing edit. Tenants pin a version and are
--    grandfathered on it until explicitly migrated. ────────────────────────────
alter table public.plans add column if not exists version int not null default 1;

-- Immutable snapshots of SUPERSEDED plan definitions. The live definition is the
-- plans row (at plans.version); a snapshot row exists for every OLDER version.
create table if not exists public.plan_versions (
  plan_id            text not null references public.plans(id) on delete cascade,
  version            int  not null,
  name               text,
  monthly_price_inr  numeric(12,2),
  features           text[] not null default '{}',
  limits             jsonb  not null default '{}'::jsonb,
  soft_limits        jsonb  not null default '{}'::jsonb,
  trial_days         int,
  snapshot_at        timestamptz not null default now(),
  snapshot_by        uuid references auth.users(id),
  primary key (plan_id, version)
);
alter table public.plan_versions enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='plan_versions' and policyname='plan_versions_read_all') then
    create policy "plan_versions_read_all" on public.plan_versions for select using (true);
  end if;
end $$;

-- Pin each subscription to the plan version it bought. Backfill existing subs to
-- the current version so a later pricing edit can't silently change their caps.
alter table public.tenant_subscriptions add column if not exists plan_version int;
update public.tenant_subscriptions ts
   set plan_version = p.version
  from public.plans p
 where ts.plan_id = p.id and ts.plan_version is null;

-- ── First-class per-tenant limit overrides (soft + hard), reason-audited. ─────
-- Hard caps are ALSO mirrored into tenant_entitlements.quota_override by the API
-- so the existing enforcement path (lib/limits resolveLimit) honours them with
-- no fork of the enforcement code.
create table if not exists public.tenant_limit_overrides (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  limit_key   text not null,
  soft_cap    bigint,      -- null = inherit plan soft
  hard_cap    bigint,      -- null = inherit plan hard; -1 = unlimited
  reason      text,
  set_by      uuid references auth.users(id),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, limit_key)
);
alter table public.tenant_limit_overrides enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='tenant_limit_overrides' and policyname='tlo_read_own') then
    create policy "tlo_read_own" on public.tenant_limit_overrides for select using (
      exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
    );
  end if;
end $$;

-- ── Limit definitions catalogue — one source of truth for labels/units/scope
--    + whether the usage reader meters it live. The FE matrix + tenant panel
--    render from this. ───────────────────────────────────────────────────────
create table if not exists public.plan_limit_defs (
  key          text primary key,
  label        text not null,
  unit         text not null default 'count',
  category     text not null default 'usage',
  verticals    text[] not null default '{*}',
  metered      boolean not null default false,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);
alter table public.plan_limit_defs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='plan_limit_defs' and policyname='pld_read_all') then
    create policy "pld_read_all" on public.plan_limit_defs for select using (true);
  end if;
end $$;

insert into public.plan_limit_defs (key,label,unit,category,verticals,metered,sort_order) values
  ('outlets_max',         'Outlets',        'outlets',   'scale',     '{*}', true,  10),
  ('team_size_max',       'Staff seats',    'seats',     'team',      '{*}', true,  20),
  ('messages_per_month',  'WhatsApp sends', 'msgs/mo',   'messaging', '{*}', true,  30),
  ('sms_per_month',       'SMS sends',      'sms/mo',    'messaging', '{*}', false, 40),
  ('catalog_items_max',   'Catalog items',  'items',     'catalog',   '{*}', false, 50),
  ('campaigns_max',       'Campaigns',      'campaigns', 'marketing', '{*}', true,  60),
  ('storage_mb_max',      'Storage',        'MB',        'storage',   '{*}', false, 70),
  ('api_calls_per_month', 'API calls',      'calls/mo',  'api',       '{*}', false, 80)
on conflict (key) do nothing;
