-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 070 — 14-day refund flow + GST invoice fields + tenant billing
-- address.
--
-- BRIEF (Indian SMB Omnichannel Wedge, P0.4):
--   • 14-day no-questions refund handled in-product (no email chain).
--   • Auto GST-compliant invoice generated on every invoice.paid webhook
--     and emailed to the billing contact.
--
-- Bundles three additive concerns into one migration because they all touch
-- the billing surface and ship together:
--   1. tenant_subscriptions refund tracking columns
--   2. tenants GST + billing address columns
--   3. invoices: GST line-item fields + a new pending_invoice_emails queue
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Refund tracking on tenant_subscriptions ──────────────────────────
ALTER TABLE public.tenant_subscriptions
  ADD COLUMN IF NOT EXISTS refund_initiated_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_amount_inr   bigint,
  ADD COLUMN IF NOT EXISTS refund_razorpay_id  text,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

COMMENT ON COLUMN public.tenant_subscriptions.refund_initiated_at IS '14d refund flow: when the user clicked Cancel & request refund (in-product). NULL if no refund requested.';
COMMENT ON COLUMN public.tenant_subscriptions.refund_completed_at IS '14d refund flow: set by Razorpay refund.processed webhook when bank confirms.';
COMMENT ON COLUMN public.tenant_subscriptions.refund_amount_inr   IS '14d refund flow: refunded amount in PAISE. Source = razorpay payment.amount on the most recent captured payment for this sub.';
COMMENT ON COLUMN public.tenant_subscriptions.refund_razorpay_id  IS '14d refund flow: rfnd_XXX id from Razorpay /refunds — keys the refund.processed webhook back to this row.';
COMMENT ON COLUMN public.tenant_subscriptions.cancellation_reason IS 'Free-text or canonical: refund_within_14d | user_initiated | non_payment | admin_terminated.';

-- Index supports the FE "is this sub still within the refund window?" check
-- and the admin reverse-lookup on refund webhooks.
CREATE INDEX IF NOT EXISTS tenant_subscriptions_refund_rzid_idx
  ON public.tenant_subscriptions(refund_razorpay_id)
  WHERE refund_razorpay_id IS NOT NULL;

-- ─── 2. Tenant GST / billing address ─────────────────────────────────────
-- Required by Indian GST law to render a compliant invoice. Optional —
-- when missing, the invoice falls back to "Unregistered" and the GST math
-- treats the buyer as B2C (CGST+SGST collected, no input credit shown).
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS gstin             text,
  ADD COLUMN IF NOT EXISTS billing_email     text,
  ADD COLUMN IF NOT EXISTS billing_address   text,
  ADD COLUMN IF NOT EXISTS billing_state     text,
  ADD COLUMN IF NOT EXISTS billing_state_code text,
  ADD COLUMN IF NOT EXISTS billing_pincode   text,
  ADD COLUMN IF NOT EXISTS legal_name        text;

COMMENT ON COLUMN public.tenants.gstin             IS 'Buyer GSTIN (15-char) for B2B invoices. Optional; absent → B2C invoice.';
COMMENT ON COLUMN public.tenants.billing_email     IS 'Where GST invoices are emailed. Falls back to tenant owner''s auth email if NULL.';
COMMENT ON COLUMN public.tenants.billing_address   IS 'Postal address printed on invoices (multiline OK).';
COMMENT ON COLUMN public.tenants.billing_state     IS 'State name e.g. "Maharashtra" — used for place-of-supply.';
COMMENT ON COLUMN public.tenants.billing_state_code IS 'GST state code (2-digit) e.g. "27" for Maharashtra. Drives CGST+SGST vs IGST split.';
COMMENT ON COLUMN public.tenants.billing_pincode   IS '6-digit Indian PIN code.';
COMMENT ON COLUMN public.tenants.legal_name        IS 'Registered business name (may differ from display business_name).';

-- ─── 3. invoices: GST line-item fields ───────────────────────────────────
-- The existing `invoices` table (migration 021) has amount_paise + gst_paise.
-- Indian GST law requires the split (CGST/SGST vs IGST) on the printed
-- invoice and a per-FY sequential invoice number. Add those without
-- breaking the existing read paths.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS invoice_number   text,
  ADD COLUMN IF NOT EXISTS hsn_sac          text DEFAULT '998314',  -- IT services SAC code
  ADD COLUMN IF NOT EXISTS place_of_supply  text,                   -- state code
  ADD COLUMN IF NOT EXISTS cgst_paise       bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_paise       bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_paise       bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gst_rate_pct     numeric(4,1) DEFAULT 18.0,
  ADD COLUMN IF NOT EXISTS buyer_gstin      text,
  ADD COLUMN IF NOT EXISTS seller_gstin     text,
  ADD COLUMN IF NOT EXISTS invoice_html     text,                   -- rendered HTML for PDF gen
  ADD COLUMN IF NOT EXISTS emailed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS emailed_to       text;

-- Sequential invoice numbers per FY (April→March in India). Enforced via
-- a function + unique constraint rather than a serial, because GST
-- compliance requires the number be stable + reset on FY boundary.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_invoice_number_uniq
  ON public.invoices(invoice_number)
  WHERE invoice_number IS NOT NULL;

COMMENT ON COLUMN public.invoices.invoice_number  IS 'FY-sequential GST invoice number e.g. FREQ/2026-27/00001. Unique across the platform; reset every FY (April).';
COMMENT ON COLUMN public.invoices.hsn_sac         IS 'HSN/SAC code. Default 998314 = "Hosting and information technology infrastructure services" (CBIC SAC list).';
COMMENT ON COLUMN public.invoices.place_of_supply IS 'GST state code of the buyer. Equal to seller state → intra-state (CGST+SGST). Different → inter-state (IGST).';
COMMENT ON COLUMN public.invoices.cgst_paise      IS 'Central GST in paise. Non-zero only on intra-state supply.';
COMMENT ON COLUMN public.invoices.sgst_paise      IS 'State GST in paise. Non-zero only on intra-state supply.';
COMMENT ON COLUMN public.invoices.igst_paise      IS 'Integrated GST in paise. Non-zero only on inter-state supply (or B2C exports).';
COMMENT ON COLUMN public.invoices.gst_rate_pct    IS 'Headline GST rate. 18% for SaaS in India today.';
COMMENT ON COLUMN public.invoices.buyer_gstin     IS 'Buyer GSTIN at time of invoice (snapshotted from tenants.gstin so historical invoices are immutable even if tenant edits later).';
COMMENT ON COLUMN public.invoices.seller_gstin    IS 'Our GSTIN (snapshotted from env at issue time).';
COMMENT ON COLUMN public.invoices.invoice_html    IS 'Rendered HTML body of the invoice. Stored so re-printing / re-emailing the exact same invoice is possible without regenerating from scratch.';
COMMENT ON COLUMN public.invoices.emailed_at      IS 'When the GST invoice email was successfully handed to the email provider. NULL = pending or failed.';
COMMENT ON COLUMN public.invoices.emailed_to      IS 'Recipient address used for the invoice email (audit trail).';

-- ─── 4. pending_invoice_emails — queue/DLQ for invoice email delivery ────
-- If Resend is unconfigured or returns an error, we drop a row here so we
-- have an auditable trail of "this invoice would have been emailed to X
-- at Y". A simple worker can later flush this queue — for the MVP it's
-- read-only telemetry.
CREATE TABLE IF NOT EXISTS public.pending_invoice_emails (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invoice_id      uuid REFERENCES public.invoices(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  reason          text NOT NULL,        -- 'email_provider_not_configured' | 'send_failed' | 'manual_retry'
  last_error      text,
  attempts        int  NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  resolved_at     timestamptz,          -- set when a later successful send clears it
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_invoice_emails_tenant_idx
  ON public.pending_invoice_emails(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pending_invoice_emails_unresolved_idx
  ON public.pending_invoice_emails(tenant_id)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE public.pending_invoice_emails IS
  'DLQ for GST invoice emails that failed to deliver (Resend down / not configured). Worker can retry; FE reads count to surface "1 invoice email pending" banners.';

ALTER TABLE public.pending_invoice_emails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant admins read pending_invoice_emails" ON public.pending_invoice_emails;
CREATE POLICY "tenant admins read pending_invoice_emails" ON public.pending_invoice_emails
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM public.user_role_assignments a
      JOIN public.role_definitions     r ON r.id = a.role_id
      WHERE a.user_id  = auth.uid()
        AND a.tenant_id = pending_invoice_emails.tenant_id
        AND r.key IN ('owner', 'workspace_admin', 'platform_owner')
    )
    OR EXISTS (
      SELECT 1 FROM public.tenants WHERE id = pending_invoice_emails.tenant_id AND user_id = auth.uid()
    )
  );

-- ─── 5. notification event types — billing.refund_* ─────────────────────
INSERT INTO public.notification_event_types
  (key, category, title_template, body_template, default_channels, severity, description)
VALUES
  ('billing.refund_initiated',
    'billing',
    'Refund initiated',
    'A refund of ₹{{amount}} has been requested. Razorpay will return it to your card in 5–7 business days.',
    ARRAY['in_app','email']::text[],
    'info',
    'User clicked "Cancel & request refund" within the 14-day window'),
  ('billing.refund_completed',
    'billing',
    'Refund completed',
    'Razorpay confirmed the ₹{{amount}} refund has been processed.',
    ARRAY['in_app','email']::text[],
    'success',
    'Razorpay refund.processed webhook fired for a 14d-window refund'),
  ('billing.invoice_emailed',
    'billing',
    'Invoice sent',
    'GST invoice {{invoice_number}} for ₹{{amount}} was emailed to {{recipient}}.',
    ARRAY['in_app']::text[],
    'info',
    'Auto-generated GST invoice was emailed to the billing contact after a successful payment')
ON CONFLICT (key) DO UPDATE SET
  category         = EXCLUDED.category,
  title_template   = EXCLUDED.title_template,
  body_template    = EXCLUDED.body_template,
  default_channels = EXCLUDED.default_channels,
  severity         = EXCLUDED.severity,
  description      = EXCLUDED.description;

-- ─── Sanity check (run manually after migration) ──────────────────────
-- select column_name from information_schema.columns where table_name='tenant_subscriptions' and column_name like 'refund%';
-- select column_name from information_schema.columns where table_name='invoices' and column_name in ('invoice_number','hsn_sac','place_of_supply','cgst_paise','sgst_paise','igst_paise');
-- select column_name from information_schema.columns where table_name='tenants' and column_name in ('gstin','billing_email','billing_state_code');
-- select count(*) from public.pending_invoice_emails;
-- select key from public.notification_event_types where key like 'billing.refund_%' or key='billing.invoice_emailed';
