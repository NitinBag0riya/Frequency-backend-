-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 027 — billing idempotency indexes
--
-- Two unique partial indexes that close audit-flagged race windows:
--
--   1. tenant_subscriptions.razorpay_subscription_id — prevents two tenants
--      from ever sharing the same Razorpay subscription_id (would happen if
--      e.g. test/live mode mixup or manual data fix). The webhook resolves
--      tenant by this column via .maybeSingle(), which would error PGRST116
--      if it found two rows.
--
--   2. invoices.razorpay_inv_id — Razorpay retries webhook delivery on any
--      non-2xx, so the payment.captured handler must be idempotent. The
--      handler now uses upsert(..., { onConflict: 'razorpay_inv_id' });
--      this index is what makes that conflict resolution work.
--
-- Both partial (WHERE x IS NOT NULL) so legacy rows without these IDs don't
-- block index creation.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS tenant_subs_razorpay_sub
  ON public.tenant_subscriptions(razorpay_subscription_id)
  WHERE razorpay_subscription_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_razorpay_inv
  ON public.invoices(razorpay_inv_id)
  WHERE razorpay_inv_id IS NOT NULL;

COMMENT ON INDEX public.tenant_subs_razorpay_sub IS
  'Idempotency guard for billing webhook tenant lookup. Without this, dup rows would crash .maybeSingle() with PGRST116.';

COMMENT ON INDEX public.invoices_razorpay_inv IS
  'Idempotency guard for payment.captured webhook. Razorpay retries on non-2xx, this lets us upsert(..onConflict).';
