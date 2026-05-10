-- Migration 021 — Billing layer per PRICING_SPEC.md (INR-only, Razorpay-only).
--
-- This is an ADDITIVE migration. We deliberately don't drop or rename
-- existing tables (plans, tenant_subscriptions) because the running app
-- (server's checkPermission, /home pricing, admin Plans editor, the
-- UpgradeBanner) reads from them and renaming would force a coordinated
-- multi-file refactor for no schema benefit.
--
-- Decisions:
--   - Keep `tenant_subscriptions` as the spec's "subscriptions". Add
--     the two columns the spec adds (billing_cycle, razorpay_customer_id).
--   - Keep `plans` as-is. Add price_inr_mo + price_inr_yr in paise
--     (what Razorpay charges in) on top of the existing rupee-display
--     `monthly_price_inr`. Update the 4 existing rows to spec prices
--     and insert the new Enterprise tier.
--   - Add usage_counters + invoices tables (genuinely new).
--   - Add RLS using the new RBAC tables (user_role_assignments + role_definitions).

-- ─── 1. Plans — add paise columns + spec prices + Enterprise tier ────────

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS price_inr_mo integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_inr_yr integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.plans.price_inr_mo IS 'Monthly price in paise (₹999 = 99900). Source of truth for Razorpay charges.';
COMMENT ON COLUMN public.plans.price_inr_yr IS 'Annual price in paise (~17% off monthly × 12).';

-- Update the 4 existing tiers to PRICING_SPEC §2.2 values + new Enterprise tier.
-- monthly_price_inr stays as rupees for display compat with /home + admin Plans editor.
UPDATE public.plans SET
  monthly_price_inr = 0,
  price_inr_mo      = 0,
  price_inr_yr      = 0,
  sort_order        = 1
WHERE id = 'free';

UPDATE public.plans SET
  monthly_price_inr = 999,
  price_inr_mo      = 99900,
  price_inr_yr      = 999000,
  sort_order        = 2
WHERE id = 'starter';

UPDATE public.plans SET
  monthly_price_inr = 2499,
  price_inr_mo      = 249900,
  price_inr_yr      = 2499000,
  sort_order        = 3
WHERE id = 'growth';

UPDATE public.plans SET
  monthly_price_inr = 6999,
  price_inr_mo      = 699900,
  price_inr_yr      = 6999000,
  sort_order        = 4
WHERE id = 'scale';

-- New Enterprise tier — custom pricing handled out-of-band.
INSERT INTO public.plans (id, name, monthly_price_inr, price_inr_mo, price_inr_yr, features, limits, freemium_caps, is_active, sort_order)
VALUES (
  'enterprise', 'Enterprise',
  -1, 0, 0,                                          -- -1 monthly_price_inr signals "custom" to legacy display code
  ARRAY['*']::text[],
  '{"contacts_max":-1,"messages_per_month":-1,"team_size_max":-1,"workflows_max":-1,"broadcasts_per_day":-1,"ai_tokens_per_month":-1,"custom_roles_allowed":true}'::jsonb,
  '{}'::jsonb,
  true,
  5
)
ON CONFLICT (id) DO UPDATE SET
  features  = EXCLUDED.features,
  limits    = EXCLUDED.limits,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order;

-- ─── 2. tenant_subscriptions — add the two columns the spec needs ──────

ALTER TABLE public.tenant_subscriptions
  ADD COLUMN IF NOT EXISTS billing_cycle        text NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly','annual')),
  ADD COLUMN IF NOT EXISTS razorpay_customer_id text;

COMMENT ON COLUMN public.tenant_subscriptions.billing_cycle        IS 'monthly | annual — drives Razorpay plan id selection.';
COMMENT ON COLUMN public.tenant_subscriptions.razorpay_customer_id IS 'Razorpay Customer id, created lazily on first checkout.';

-- ─── 3. usage_counters — NEW ───────────────────────────────────────────
-- Rolling counters for quota enforcement. Reset by period-rollover cron:
-- - daily metrics  (ai_generations) reset at 00:00 IST
-- - monthly metrics (messages_sent) reset at subscription period boundary

CREATE TABLE IF NOT EXISTS public.usage_counters (
  tenant_id    uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  metric       text        NOT NULL,
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  count        bigint      NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, metric, period_start)
);

CREATE INDEX IF NOT EXISTS usage_counters_tenant_metric_idx
  ON public.usage_counters (tenant_id, metric);

COMMENT ON TABLE public.usage_counters IS 'Rolling-window quota counters. metric ∈ {messages_sent, ai_generations, contacts, workflows_active, agent_seats_active}.';

-- ─── 4. invoices — NEW ─────────────────────────────────────────────────
-- All amounts in paise. GST tracked separately so reporting stays clean.

CREATE TABLE IF NOT EXISTS public.invoices (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  subscription_id uuid        REFERENCES public.tenant_subscriptions(id) ON DELETE SET NULL,
  amount_paise    bigint      NOT NULL,                 -- excluding GST
  gst_paise       bigint      NOT NULL DEFAULT 0,       -- 18% on SaaS
  currency        text        NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status          text        NOT NULL CHECK (status IN ('draft','open','paid','void','refunded')),
  razorpay_inv_id text,
  pdf_url         text,
  paid_at         timestamptz,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoices_tenant_idx ON public.invoices (tenant_id, created_at DESC);

COMMENT ON TABLE public.invoices IS 'Customer invoices in INR (paise). gst_paise tracked separately for reporting.';

-- ─── 5. RLS — read access for tenant members ──────────────────────────

ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices       ENABLE ROW LEVEL SECURITY;

-- usage_counters: anyone in the tenant can see usage
DROP POLICY IF EXISTS "tenant members read usage" ON public.usage_counters;
CREATE POLICY "tenant members read usage" ON public.usage_counters
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.user_role_assignments
      WHERE user_id = auth.uid() AND tenant_id = usage_counters.tenant_id
    )
    OR EXISTS (
      SELECT 1 FROM public.tenants WHERE id = usage_counters.tenant_id AND user_id = auth.uid()
    )
  );

-- invoices: only owner / workspace_admin / billing-eligible roles
DROP POLICY IF EXISTS "tenant admins read invoices" ON public.invoices;
CREATE POLICY "tenant admins read invoices" ON public.invoices
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM public.user_role_assignments a
      JOIN public.role_definitions     r ON r.id = a.role_id
      WHERE a.user_id  = auth.uid()
        AND a.tenant_id = invoices.tenant_id
        AND r.key IN ('owner', 'workspace_admin', 'platform_owner')
    )
    OR EXISTS (
      SELECT 1 FROM public.tenants WHERE id = invoices.tenant_id AND user_id = auth.uid()
    )
  );

-- tenant_subscriptions already has RLS from earlier migrations — leave alone.

-- ─── Sanity check (run manually after migration) ──────────────────────
-- select id, monthly_price_inr, price_inr_mo, price_inr_yr from public.plans order by sort_order;
-- select count(*) from public.usage_counters;
-- select count(*) from public.invoices;
