-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 026 — Razorpay plan IDs on `plans`
--
-- Razorpay Subscriptions require a Razorpay-side `plan_id` (created once in
-- their dashboard / API) to spin up a subscription. We need one per pricing
-- tier per billing cycle (monthly / annual).
--
-- These columns are nullable because:
--   1. `free` and `enterprise` tiers don't go through Razorpay subscriptions.
--   2. The platform owner pre-populates them via Razorpay dashboard or the
--      admin Plans editor — code can't auto-create them safely (would need
--      live API credentials at migration time).
--
-- The /api/billing/checkout endpoint refuses (with a clear error) when the
-- requested plan/cycle has no razorpay_plan_id — surfaces "this tier isn't
-- configured for online checkout yet, contact support".
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS razorpay_plan_id_monthly text,
  ADD COLUMN IF NOT EXISTS razorpay_plan_id_yearly  text;

COMMENT ON COLUMN public.plans.razorpay_plan_id_monthly IS
  'Razorpay plan_id for monthly billing of this tier. Pre-created in Razorpay dashboard. Null for free/enterprise/unconfigured.';
COMMENT ON COLUMN public.plans.razorpay_plan_id_yearly IS
  'Razorpay plan_id for annual billing of this tier. Pre-created in Razorpay dashboard.';

-- Hot-path lookup so the checkout endpoint can resolve plan_id by tier+cycle in O(1).
CREATE INDEX IF NOT EXISTS plans_razorpay_monthly_idx ON public.plans(razorpay_plan_id_monthly)
  WHERE razorpay_plan_id_monthly IS NOT NULL;
