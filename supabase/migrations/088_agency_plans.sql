-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 088 — Agency-tier pricing (P1 #12 correction)
--
-- BACKGROUND
-- 079 shipped the agency white-label dashboard (agencies, agency_members,
-- agency_sub_accounts, revshare ledger, payouts). It left the agency itself
-- WITHOUT a paid plan model — agencies inherited their sub-accounts' tenant
-- plans, which is wrong: an agency sits ABOVE tenants and contains many of
-- them. Agencies need a platform-access tier distinct from any tenant tier.
--
-- This migration:
--   1. Extends `plans` with a scope discriminator. Existing rows
--      (free/starter/growth/scale/enterprise) keep scope='tenant'. Three new
--      rows seeded below have scope='agency' + max_sub_accounts + an
--      agency_features jsonb that gates white-label, priority support, CSM.
--   2. Adds plan_id / current_subscription_id / trial_ends_at to `agencies`.
--      Mirrors how tenants link to a plan.
--   3. Creates `agency_subscriptions` — direct parallel to tenant_subscriptions,
--      single source of truth for the agency's Razorpay subscription. Includes
--      the 14-day refund window mirror fields from migration 070.
--
-- PRICING REASONING
-- Tenant tier and agency tier are independent. Frequency's 0% messaging-markup
-- ethos holds — agency plans cover platform / multi-tenant operations costs
-- at scale. Per-sub-account amortised cost drops from ~Rs 700 (starter, 5
-- sub-accounts) to ~Rs 400 (growth, 25) to ~Rs 250 (scale, fair-use 100). This
-- competes head-on with Wati multi-number addons and AiSensy reseller paths
-- on the India SMB lane.
--
-- Sub-account messaging continues at pure Meta pass-through, billed either to
-- the agency (agency_paid_by_default) or to the sub-account tenant with the
-- agency earning 30 percent revshare. Two billing flows coexist; the agency
-- plan is the agency's platform fee on top.
--
-- NON-NEGOTIABLES
-- - Idempotent. ADD COLUMN IF NOT EXISTS, ON CONFLICT DO NOTHING on seeds.
-- - No `||` inside COMMENT ON literals (PG rejects string concat there).
-- - RLS enabled on agency_subscriptions; authenticated read-only; service-role
--   writes via the existing webhook + checkout routes.
-- - Stable text ids for the seeded plan rows (agency_starter / agency_growth /
--   agency_scale) so server code can reference them by slug, matching the
--   text-pk pattern of the existing plans table.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. plans — scope + max_sub_accounts + agency_features ───────────────────
alter table public.plans
  add column if not exists scope text not null default 'tenant'
    check (scope in ('tenant','agency'));

alter table public.plans
  add column if not exists max_sub_accounts integer;

alter table public.plans
  add column if not exists agency_features jsonb not null default '{}'::jsonb;

create index if not exists idx_plans_scope on public.plans(scope);

comment on column public.plans.scope is
  'Discriminator: tenant = subscribed by individual tenants for the standard product; agency = subscribed by agencies for the white-label / multi-tenant management surface. Both share the plans table but checkout routes are split.';
comment on column public.plans.max_sub_accounts is
  'Agency-only. NULL = unlimited (fair-use cap enforced in app code, default 100). For tenant rows this is NULL.';
comment on column public.plans.agency_features is
  'Agency-only feature flags. Keys: white_label_branding, revshare_default_pct, priority_support, dedicated_csm. Empty {} for tenant rows.';

-- ─── 2. agencies — link to plan + trial + cached active subscription ─────────
alter table public.agencies
  add column if not exists plan_id text references public.plans(id) on delete set null;

alter table public.agencies
  add column if not exists current_subscription_id uuid;

alter table public.agencies
  add column if not exists trial_ends_at timestamptz;

comment on column public.agencies.plan_id is
  'The agency plan slug (agency_starter / agency_growth / agency_scale). NULL while on trial or pre-billing. References plans.id; CHECK constraint is not enforced for scope=agency at the DB layer (kept loose for migration safety), the BE checkout route validates scope.';
comment on column public.agencies.trial_ends_at is
  'When the free trial ends. NULL after the agency moves to paid.';

-- ─── 3. agency_subscriptions — single source of truth ───────────────────────
create table if not exists public.agency_subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  agency_id                uuid not null references public.agencies(id) on delete cascade,
  plan_id                  text not null references public.plans(id) on delete restrict,
  razorpay_subscription_id text,
  razorpay_customer_id     text,
  status                   text not null default 'pending'
                            check (status in ('pending','active','paused','cancelled','expired','past_due')),
  billing_period           text not null default 'monthly'
                            check (billing_period in ('monthly','quarterly','annual')),
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  amount_inr_paise         bigint not null default 0,
  gst_inr_paise            bigint not null default 0,
  -- Refund window mirror of tenant_subscriptions (migration 070). 14 days
  -- from created_at; server-enforced in /api/agencies/:id/billing/refund.
  refund_initiated_at      timestamptz,
  refund_completed_at      timestamptz,
  refund_amount_inr_paise  bigint,
  refund_razorpay_id       text,
  cancelled_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_agency_subs_agency  on public.agency_subscriptions(agency_id, created_at desc);
create index if not exists idx_agency_subs_active  on public.agency_subscriptions(agency_id) where status = 'active';
create index if not exists idx_agency_subs_rzp     on public.agency_subscriptions(razorpay_subscription_id) where razorpay_subscription_id is not null;
create index if not exists idx_agency_subs_refund  on public.agency_subscriptions(refund_razorpay_id) where refund_razorpay_id is not null;

comment on table public.agency_subscriptions is
  'One row per Razorpay subscription for an agency. New rows on plan change; never UPDATE period_start/period_end on an existing row to keep history. authenticated has SELECT for agency members only; writes go through service role via /api/agencies/:id/billing/checkout and the invoice.paid webhook.';

alter table public.agency_subscriptions enable row level security;

drop policy if exists "agency_subs_member_read" on public.agency_subscriptions;
create policy "agency_subs_member_read" on public.agency_subscriptions
  for select to authenticated
  using ( public.is_agency_member(agency_id) );

revoke insert, update, delete on public.agency_subscriptions from authenticated;
revoke insert, update, delete on public.agency_subscriptions from anon;

-- ─── 4. Seed 3 agency plans (idempotent) ────────────────────────────────────
-- All amounts kept consistent with the existing tenant rows:
--   - monthly_price_inr in rupees (display compat with the admin plans editor)
--   - price_inr_mo / price_inr_yr in paise (what Razorpay charges in)
-- For agency rows we additionally need quarterly + annual paise values; we
-- reuse price_inr_yr as the annual paise figure, store quarterly in agency_features
-- so we don't add another column for a 3-row use case (agencies.subscription
-- billing_period anchors the actual charge — Razorpay plan is provisioned on
-- the fly in the checkout route, just like the tenant quarterly path).

insert into public.plans (
  id, name, scope, max_sub_accounts,
  monthly_price_inr, price_inr_mo, price_inr_yr,
  features, limits, freemium_caps, agency_features,
  is_active, sort_order
)
values (
  'agency_starter', 'Agency Starter', 'agency', 5,
  3499, 349900, 3489800,
  ARRAY['agency.dashboard','agency.sub_accounts','agency.revshare','agency.payouts']::text[],
  '{"sub_accounts_max":5,"members_max":3,"fair_use_messages_per_month":-1}'::jsonb,
  '{}'::jsonb,
  '{"white_label_branding":false,"revshare_default_pct":30,"priority_support":false,"quarterly_paise":944700}'::jsonb,
  true, 10
)
on conflict (id) do nothing;

insert into public.plans (
  id, name, scope, max_sub_accounts,
  monthly_price_inr, price_inr_mo, price_inr_yr,
  features, limits, freemium_caps, agency_features,
  is_active, sort_order
)
values (
  'agency_growth', 'Agency Growth', 'agency', 25,
  9999, 999900, 9999000,
  ARRAY['agency.dashboard','agency.sub_accounts','agency.revshare','agency.payouts','agency.white_label']::text[],
  '{"sub_accounts_max":25,"members_max":10,"fair_use_messages_per_month":-1}'::jsonb,
  '{}'::jsonb,
  '{"white_label_branding":true,"revshare_default_pct":30,"priority_support":false,"quarterly_paise":2699700}'::jsonb,
  true, 11
)
on conflict (id) do nothing;

insert into public.plans (
  id, name, scope, max_sub_accounts,
  monthly_price_inr, price_inr_mo, price_inr_yr,
  features, limits, freemium_caps, agency_features,
  is_active, sort_order
)
values (
  'agency_scale', 'Agency Scale', 'agency', NULL,
  24999, 2499900, 24999000,
  ARRAY['agency.dashboard','agency.sub_accounts','agency.revshare','agency.payouts','agency.white_label','agency.priority_support','agency.dedicated_csm']::text[],
  '{"sub_accounts_max":-1,"sub_accounts_fair_use":100,"members_max":-1,"fair_use_messages_per_month":-1}'::jsonb,
  '{}'::jsonb,
  '{"white_label_branding":true,"revshare_default_pct":30,"priority_support":true,"dedicated_csm":true,"quarterly_paise":6749700}'::jsonb,
  true, 12
)
on conflict (id) do nothing;

-- ─── 5. Auto-update updated_at on agency_subscriptions ───────────────────────
-- Mirrors the trigger pattern used elsewhere in the schema.
create or replace function public.tg_set_updated_at_agency_subs()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_agency_subs_updated_at on public.agency_subscriptions;
create trigger trg_agency_subs_updated_at
  before update on public.agency_subscriptions
  for each row execute function public.tg_set_updated_at_agency_subs();

-- ─── End of migration 088 ────────────────────────────────────────────────────
