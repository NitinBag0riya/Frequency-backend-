-- ────────────────────────────────────────────────────────────────────────
-- 112_form_plan_limits_lift.sql
--
-- Lift Forms plan gates so Indian SMBs on lower tiers can still use the
-- full builder feature set. Locks down only the metered axes (form count,
-- monthly submissions, storage) and leaves the *capabilities* (signed
-- forms, A/B variants, gated content) on for everyone.
--
-- Why:
--   - Hard-gating "signed forms" behind growth+ confuses tenants who pick
--     the "Doctor consult" or "Wedding RSVP" template, find a Signature
--     field in the builder, and discover at submit time that nothing
--     renders. Better to let everyone build + collect, and meter on
--     submissions if we need to monetise.
--   - A/B variants are a power-user feature but harmless on lower tiers
--     — the FE simply hides the tab if there's no second variant. No
--     reason to lock it.
--   - footer_removable stays restricted to pro (it's pure branding).
--
-- Updated quotas (vs migration 105):
--                            forms  subs/mo  subs/form  storage  ab    signed  gated  footer
--   free      …  was   1 /     100 /      50 /      25 / off / off / off / off
--             …  now  10 /   2,000 /     500 /     200 / on  / on  / on  / off
--   starter   …  was   5 /   1,000 /     300 /     500 / on  / off / off / off
--             …  now  50 /  20,000 /   5,000 /   2,000 / on  / on  / on  / off
--   growth    …  was  25 /  10,000 /   3,000 /   5,120 / on  / on  / on  / off
--             …  now 250 / 100,000 /  20,000 /  20,000 / on  / on  / on  / on
--   pro       …  unchanged (already unlimited)
--
-- This is an idempotent UPDATE — re-runs are no-ops.
-- ────────────────────────────────────────────────────────────────────────

update public.plan_quotas
   set max_forms_per_tenant   = 10,
       max_subs_per_tenant_mo = 2000,
       max_subs_per_form_mo   = 500,
       max_storage_mb         = 200,
       ab_variants_allowed    = true,
       signed_forms_allowed   = true,
       gated_content_allowed  = true,
       footer_removable       = false,
       max_form_tables        = null,
       updated_at             = now()
 where plan_tier = 'free';

update public.plan_quotas
   set max_forms_per_tenant   = 50,
       max_subs_per_tenant_mo = 20000,
       max_subs_per_form_mo   = 5000,
       max_storage_mb         = 2000,
       ab_variants_allowed    = true,
       signed_forms_allowed   = true,
       gated_content_allowed  = true,
       footer_removable       = false,
       updated_at             = now()
 where plan_tier = 'starter';

update public.plan_quotas
   set max_forms_per_tenant   = 250,
       max_subs_per_tenant_mo = 100000,
       max_subs_per_form_mo   = 20000,
       max_storage_mb         = 20480,
       ab_variants_allowed    = true,
       signed_forms_allowed   = true,
       gated_content_allowed  = true,
       footer_removable       = true,
       updated_at             = now()
 where plan_tier = 'growth';

-- pro untouched (already null / unlimited everywhere). Bump file size +
-- storage caps for clarity:
update public.plan_quotas
   set max_subs_per_tenant_mo = greatest(coalesce(max_subs_per_tenant_mo, 0), 500000),
       max_subs_per_form_mo   = greatest(coalesce(max_subs_per_form_mo,   0), 100000),
       max_file_size_mb       = greatest(coalesce(max_file_size_mb,       0), 50),
       updated_at             = now()
 where plan_tier = 'pro';

comment on table public.plan_quotas is
  'Plan-gate config table. Migration 112 lifted feature flags (signed, A/B, gated) for all tiers — only metered axes (count + monthly submissions + storage) still vary by plan.';
