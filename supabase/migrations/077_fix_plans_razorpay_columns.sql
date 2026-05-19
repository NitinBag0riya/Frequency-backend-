-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 077 — Heal pre-existing 026 drift on `plans` razorpay columns
--
-- Migration 026 (026_razorpay_plan_ids.sql) declared two columns:
--   - plans.razorpay_plan_id_monthly
--   - plans.razorpay_plan_id_yearly
-- and a partial index on the monthly column. The migration was stamped applied
-- on both Local and Remote in supabase_migrations.schema_migrations (026|026|026),
-- but the DDL never actually landed on the live `plans` table — same failure
-- mode as the earlier `ingest_token` bug (file in version control + row in
-- _migrations table, but the ALTER never executed, likely due to an interrupted
-- earlier push that committed the migration-tracking row before the DDL).
--
-- Symptom (pre-077):
--   GET /rest/v1/plans?select=razorpay_plan_id_monthly
--   → 400 { code: "42703", message: "column plans.razorpay_plan_id_monthly does not exist" }
--   src/routes/billing.ts hot path SELECTs these columns and would 500 on every
--   /api/billing/checkout request, silently breaking self-serve Razorpay
--   onboarding for the starter/growth/scale tiers.
--
-- Note: plans.razorpay_plan_id_quarterly (referenced by billing.ts since the
-- quarterly-billing feature shipped) was independently present on the live
-- schema (confirmed via REST probe → null value, not "column does not exist"),
-- so it's added below ONLY as a safety net via IF NOT EXISTS — no-op on prod,
-- but means dev / fresh-clone envs that never had the out-of-band fix end up
-- consistent with prod.
--
-- This migration is purely additive and uses ADD COLUMN IF NOT EXISTS, so it
-- is safe to run on environments where 026 did apply correctly. No row data
-- is touched. New columns default to NULL — ops fills the Razorpay plan_ids
-- via the admin Plans editor (per the original 026 contract).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS razorpay_plan_id_monthly   text,
  ADD COLUMN IF NOT EXISTS razorpay_plan_id_yearly    text,
  ADD COLUMN IF NOT EXISTS razorpay_plan_id_quarterly text;

COMMENT ON COLUMN public.plans.razorpay_plan_id_monthly IS
  'Razorpay plan_id for monthly billing of this tier. Pre-created in Razorpay dashboard. Null for free/enterprise/unconfigured. (Declared in 026, healed in 077.)';
COMMENT ON COLUMN public.plans.razorpay_plan_id_yearly IS
  'Razorpay plan_id for annual billing of this tier. Pre-created in Razorpay dashboard. (Declared in 026, healed in 077.)';
COMMENT ON COLUMN public.plans.razorpay_plan_id_quarterly IS
  'Razorpay plan_id for quarterly billing. Auto-provisioned on first quarterly checkout (see src/routes/billing.ts), then cached here.';

-- Hot-path lookup so /api/billing/checkout can resolve plan_id by tier+cycle in O(1).
-- Originally declared in 026 but never landed.
CREATE INDEX IF NOT EXISTS plans_razorpay_monthly_idx
  ON public.plans(razorpay_plan_id_monthly)
  WHERE razorpay_plan_id_monthly IS NOT NULL;
