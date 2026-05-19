-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 071 — Click-to-WhatsApp (CTWA) ad → conversation → revenue
-- attribution.
--
-- BRIEF (Indian SMB Omnichannel Wedge, P0.6): SMBs run Meta CTWA ads with
-- WhatsApp-CTA destination. Meta delivers a `referral` object on the first
-- inbound message identifying which ad / ad-set / campaign / ctwa_clid
-- drove the conversation. We attribute the conversation → revenue back to
-- the ad and surface the funnel in a new analytics tab.
--
-- Data model (one row per attributed contact-thread):
--   ctwa_attribution
--   ├── tenant_id, contact_id          — multi-tenant + contact link
--   ├── meta_ad_id, meta_adset_id      — Meta object IDs from the referral
--   ├── meta_campaign_id               — joined to meta_ad_campaigns for spend
--   ├── ctwa_clid                      — unique click id; dedup key
--   ├── referral_headline / _body      — ad creative copy snapshot
--   ├── source_url, image_url          — additional referral fields
--   ├── first_message_at               — when the WA convo started
--   ├── replied_at                     — when the tenant replied (engagement)
--   ├── converted_at, revenue_inr      — set by /mark-converted endpoint
--   └── conversion_source              — 'razorpay' | 'lead_table' | 'manual'
--
-- RLS: tenant-scoped read; INSERT/UPDATE allowed via service-role only
-- (the webhook handler runs with service_role).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ctwa_attribution (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  -- Meta object hierarchy
  meta_ad_id          text,
  meta_adset_id       text,
  meta_campaign_id    text,
  ctwa_clid           text,                                  -- Meta click id, unique per click
  -- Creative snapshot
  referral_headline   text,
  referral_body       text,
  source_url          text,
  image_url           text,
  referral_source_type text,                                 -- 'ad' | 'post' (Meta sends both)
  -- Timeline
  first_message_at    timestamptz NOT NULL DEFAULT now(),
  replied_at          timestamptz,                           -- when tenant sent first reply
  converted_at        timestamptz,
  revenue_inr         bigint,                                -- paise
  conversion_source   text CHECK (conversion_source IS NULL OR conversion_source IN ('razorpay','lead_table','manual','webhook')),
  -- Raw referral payload for debug / replay
  raw_referral        jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ctwa_attribution IS
  'Per-conversation attribution row written when an inbound WhatsApp message carries a Meta `referral` object (CTWA). Joined to meta_ad_campaigns by meta_campaign_id for ROAS reporting.';

-- ─── Indexes ─────────────────────────────────────────────────────────────
-- Dashboard reads filter by tenant + date — keep this index hot.
CREATE INDEX IF NOT EXISTS ctwa_attribution_tenant_time_idx
  ON public.ctwa_attribution(tenant_id, first_message_at DESC);

-- Adset rollup ("ROAS per ad-set" table on the dashboard).
CREATE INDEX IF NOT EXISTS ctwa_attribution_adset_idx
  ON public.ctwa_attribution(tenant_id, meta_adset_id)
  WHERE meta_adset_id IS NOT NULL;

-- Campaign join target for spend rollup.
CREATE INDEX IF NOT EXISTS ctwa_attribution_campaign_idx
  ON public.ctwa_attribution(tenant_id, meta_campaign_id)
  WHERE meta_campaign_id IS NOT NULL;

-- ctwa_clid dedup — Meta retries inbound webhooks; without this we'd write
-- duplicate attribution rows on the same click. Unique WITHIN a tenant so
-- two tenants who somehow see the same clid don't collide (unlikely but
-- defensive — Meta clid is globally unique in practice).
CREATE UNIQUE INDEX IF NOT EXISTS ctwa_attribution_tenant_clid_uniq
  ON public.ctwa_attribution(tenant_id, ctwa_clid)
  WHERE ctwa_clid IS NOT NULL;

-- Conversion lookup: when a Razorpay payment lands we look up by contact_id
-- to mark conversion. Cheap, supports the /mark-converted hot path.
CREATE INDEX IF NOT EXISTS ctwa_attribution_contact_idx
  ON public.ctwa_attribution(tenant_id, contact_id)
  WHERE contact_id IS NOT NULL;

-- ─── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE public.ctwa_attribution ENABLE ROW LEVEL SECURITY;

-- Tenant members read. Service-role writes (webhook handler uses
-- SUPABASE_SERVICE_ROLE_KEY which bypasses RLS).
DROP POLICY IF EXISTS "tenant members read ctwa_attribution" ON public.ctwa_attribution;
CREATE POLICY "tenant members read ctwa_attribution" ON public.ctwa_attribution
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.user_role_assignments
      WHERE user_id = auth.uid() AND tenant_id = ctwa_attribution.tenant_id
    )
    OR EXISTS (
      SELECT 1 FROM public.tenants WHERE id = ctwa_attribution.tenant_id AND user_id = auth.uid()
    )
  );

-- Owners + workspace_admin + sales roles can manually mark conversion via
-- the /mark-converted endpoint. The endpoint itself enforces tenant scoping;
-- this policy is defense-in-depth.
DROP POLICY IF EXISTS "tenant admins update ctwa_attribution" ON public.ctwa_attribution;
CREATE POLICY "tenant admins update ctwa_attribution" ON public.ctwa_attribution
  FOR UPDATE USING (
    EXISTS (
      SELECT 1
      FROM public.user_role_assignments a
      JOIN public.role_definitions     r ON r.id = a.role_id
      WHERE a.user_id  = auth.uid()
        AND a.tenant_id = ctwa_attribution.tenant_id
        AND r.key IN ('owner', 'workspace_admin', 'platform_owner', 'sales_manager')
    )
    OR EXISTS (
      SELECT 1 FROM public.tenants WHERE id = ctwa_attribution.tenant_id AND user_id = auth.uid()
    )
  );

-- ─── updated_at maintenance ──────────────────────────────────────────────
-- Use the existing tg_set_updated_at trigger if present in the schema;
-- otherwise create + attach our own. Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'tg_set_updated_at'
  ) THEN
    CREATE FUNCTION public.tg_set_updated_at() RETURNS trigger AS $fn$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END$$;

DROP TRIGGER IF EXISTS ctwa_attribution_set_updated_at ON public.ctwa_attribution;
CREATE TRIGGER ctwa_attribution_set_updated_at
  BEFORE UPDATE ON public.ctwa_attribution
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ─── Auto-fill replied_at on first outbound WA message ──────────────────
-- The funnel measures "contacts who replied" = "contacts the tenant has
-- responded to since CTWA". Rather than instrumenting every outbound send
-- site (there are ~6 in the codebase: direct send, broadcast, template,
-- interactive, etc.) we use an AFTER INSERT trigger on `messages` that
-- updates the matching ctwa_attribution row's replied_at the first time
-- the tenant sends an outbound WA message to a CTWA-attributed contact.
--
-- Lookup: by (tenant_id, contact phone via contacts.phone). Keeps the
-- trigger simple — no JOIN to messages.contact_id (which can be NULL).
CREATE OR REPLACE FUNCTION public.tg_ctwa_mark_replied()
RETURNS trigger AS $$
BEGIN
  -- Only care about outbound WhatsApp messages.
  IF NEW.direction <> 'outbound' OR NEW.channel <> 'whatsapp' THEN
    RETURN NEW;
  END IF;
  -- Find the contact row this message goes to (phone is "919xxxx" with no +).
  -- contacts.phone is "+919xxxx" so compare on a stripped form.
  UPDATE public.ctwa_attribution
    SET replied_at = COALESCE(replied_at, NEW.created_at)
    WHERE tenant_id = NEW.tenant_id
      AND replied_at IS NULL
      AND contact_id IN (
        SELECT id FROM public.contacts
         WHERE tenant_id = NEW.tenant_id
           AND (
             phone = NEW.contact_phone
             OR phone = '+' || NEW.contact_phone
             OR REPLACE(phone, '+', '') = NEW.contact_phone
           )
      );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_ctwa_mark_replied ON public.messages;
CREATE TRIGGER messages_ctwa_mark_replied
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_ctwa_mark_replied();

-- ─── Sanity check ──────────────────────────────────────────────────────
-- select count(*) from public.ctwa_attribution;
-- \d+ public.ctwa_attribution
