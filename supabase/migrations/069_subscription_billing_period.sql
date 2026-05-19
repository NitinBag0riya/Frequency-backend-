-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 069 — Quarterly billing period on tenant_subscriptions
--
-- BRIEF (Indian SMB Omnichannel Wedge, P0.4): add a quarterly option to the
-- self-serve checkout so customers can lock in 3 months @ 10% discount —
-- matches the typical Indian SMB cash-flow cadence (UPI mandate friction
-- once per quarter instead of every month).
--
-- Existing surface uses `billing_cycle ∈ ('monthly','annual')` (migration
-- 021). We deliberately keep that intact — it's read by the checkout endpoint
-- to pick the Razorpay plan_id (razorpay_plan_id_monthly vs _yearly). The
-- NEW `billing_period` column is the SMB-facing concept that drives discount
-- math + the Razorpay plan creation API; it sits ALONGSIDE billing_cycle:
--
--   billing_period   billing_cycle  Razorpay plan period (created on the fly)
--   ──────────────   ─────────────  ─────────────────────────────────────────
--   monthly          monthly        monthly      (existing path, no change)
--   quarterly        monthly        quarterly    (NEW — Razorpay charges every 3 months)
--   annual           annual         yearly       (existing annual path)
--
-- Why not just expand the billing_cycle enum? Because dozens of read sites
-- (UpgradeBanner, plan picker copy, /home pricing tiles) check
-- `billing_cycle === 'annual'`. Adding 'quarterly' there would silently
-- break those code paths until each one is touched. Keeping the SMB-facing
-- period orthogonal means the upgrade is fully additive — the only writer is
-- the checkout endpoint, the only reader (today) is the BillingPage to show
-- "Renews in 3 months" copy.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenant_subscriptions
  ADD COLUMN IF NOT EXISTS billing_period text NOT NULL DEFAULT 'monthly'
    CHECK (billing_period IN ('monthly','quarterly','annual'));

COMMENT ON COLUMN public.tenant_subscriptions.billing_period IS
  'SMB-facing billing rhythm. monthly | quarterly | annual. Drives Razorpay plan period (monthly|quarterly|yearly) + 10% quarterly discount math. Sits alongside the legacy billing_cycle column which still drives plans.razorpay_plan_id_monthly/_yearly selection — monthly+quarterly both map to billing_cycle=monthly internally.';

-- Backfill existing rows: 'annual' billing_cycle rows → 'annual' period,
-- everything else → 'monthly' period. Idempotent — re-runnable safely.
UPDATE public.tenant_subscriptions
  SET billing_period = CASE billing_cycle WHEN 'annual' THEN 'annual' ELSE 'monthly' END
  WHERE billing_period = 'monthly' AND billing_cycle = 'annual';

-- ─── Quarterly Razorpay plan IDs on `plans` ──────────────────────────────
-- Razorpay needs ONE plan_id per (tier × period). For monthly/yearly we
-- pre-create them in the dashboard (migration 026). For quarterly we don't
-- — instead the checkout endpoint creates the plan on the fly the first
-- time someone subscribes quarterly to a given tier, then caches the
-- razorpay_plan_id back to this column. Subsequent quarterly checkouts on
-- the same tier reuse it.
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS razorpay_plan_id_quarterly text;

COMMENT ON COLUMN public.plans.razorpay_plan_id_quarterly IS
  'Razorpay plan_id for quarterly billing of this tier. Created lazily by the checkout endpoint the first time a quarterly subscription is requested. NULL = not yet provisioned.';

CREATE INDEX IF NOT EXISTS plans_razorpay_quarterly_idx
  ON public.plans(razorpay_plan_id_quarterly)
  WHERE razorpay_plan_id_quarterly IS NOT NULL;

-- ─── Sanity check (run manually after migration) ──────────────────────
-- select id, billing_cycle, billing_period from public.tenant_subscriptions order by tenant_id;
-- select id, razorpay_plan_id_monthly, razorpay_plan_id_yearly, razorpay_plan_id_quarterly from public.plans order by sort_order;
