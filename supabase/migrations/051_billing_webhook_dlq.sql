-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 051 — billing_webhook_dlq (dead-letter queue for Razorpay events)
--
-- Threat model: when the Razorpay webhook handler raises (DB outage, schema
-- drift, plan-mapping miss), today the request 5xx's and Razorpay retries
-- with backoff. After 24 retries Razorpay gives up and the event is lost.
-- We need a durable record so on-call can re-drive failed events without
-- pulling them out of provider dashboards. Strict super-admin-only RLS so
-- payloads (which contain customer email + amount) never leak to tenants.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.billing_webhook_dlq (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    text         NOT NULL,
  payload       jsonb        NOT NULL,
  error         text,
  received_at   timestamptz  NOT NULL DEFAULT now(),
  retried_at    timestamptz,
  status        text         NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','retried_ok','retried_failed','manual_review'))
);

CREATE INDEX IF NOT EXISTS billing_webhook_dlq_status_idx
  ON public.billing_webhook_dlq (status, received_at);

ALTER TABLE public.billing_webhook_dlq ENABLE ROW LEVEL SECURITY;

-- ── Strict: only super-admins may SELECT. No INSERT/UPDATE/DELETE policy
--    means RLS denies all authenticated traffic — service_role bypasses
--    RLS, which is exactly what the webhook handler uses.
DROP POLICY IF EXISTS dlq_super_admin_only ON public.billing_webhook_dlq;
CREATE POLICY dlq_super_admin_only ON public.billing_webhook_dlq
  FOR SELECT USING (public.is_super_admin());
COMMENT ON POLICY dlq_super_admin_only ON public.billing_webhook_dlq IS
  'Threat model: payload contains customer email + paise amounts. Tenants must '
  'never read this; only platform on-call. Service role (webhook handler) bypasses RLS.';

COMMENT ON TABLE public.billing_webhook_dlq IS
  'Failed Razorpay webhook events. Drained by ops via /admin/billing/dlq. '
  'See docs/runbooks/billing-dlq.md.';
