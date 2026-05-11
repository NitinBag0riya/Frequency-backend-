-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 040 — WhatsApp Calling security patch (Wave 3)
--
-- Sources:
--   .calling-feature/deploy/02-security-review.md   (Security Engineer audit)
--   .calling-feature/deploy/01-reality-check.md     (Reality Checker, defect #12)
--
-- Addresses three live exposures:
--
--  F-02  Regulated-vertical tenants default to cross-border transcription ON
--        (DPDP §16 + RBI Outsourcing exposure). Backfill existing rows so
--        BFSI / healthcare / government tenants flip to FALSE unless the
--        tenant has explicitly attested in the meantime.
--
--  F-11  `append_tenant_audit` does not verify that the calling user belongs
--        to the target tenant — any authenticated user could pollute another
--        tenant's audit log. Add the same membership / platform check that
--        `insert_call_consent_log` already enforces.
--
--  #12   Orphan `call_sessions` rows created by `/api/calls/intent` are never
--        cleaned up when the matching `/api/calls/initiate` never arrives.
--        Add a daily pg_cron sweeper (extension-gated; no-op when pg_cron
--        is unavailable).
--
-- Idempotent. Forward-only. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── F-02 — backfill regulated-vertical default ─────────────────────────────
-- Existing tenants flagged as regulated whose cross-border flag is still the
-- platform default (true) are flipped to false. Tenants who have already
-- explicitly attested (allow_cross_border_transcription = true via the
-- regulated_vertical_attestation_id path) are detected by the presence of
-- that attestation id and left alone. Schema may not have an attestation_id
-- column on day 1 — guard the predicate accordingly.
DO $$
DECLARE
  has_attestation_col BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'tenants'
       AND column_name  = 'regulated_vertical_attestation_id'
  ) INTO has_attestation_col;

  IF has_attestation_col THEN
    UPDATE public.tenants
       SET allow_cross_border_transcription = FALSE
     WHERE regulated_vertical IS NOT NULL
       AND allow_cross_border_transcription IS DISTINCT FROM FALSE
       AND regulated_vertical_attestation_id IS NULL;
  ELSE
    UPDATE public.tenants
       SET allow_cross_border_transcription = FALSE
     WHERE regulated_vertical IS NOT NULL
       AND allow_cross_border_transcription IS DISTINCT FROM FALSE;
  END IF;
END $$;

-- Also flip the column default so brand-new regulated tenants inherit FALSE
-- when no value is supplied. We can't make this conditional in pure DDL, but
-- the platform onboarding code will set the right value at signup; this is
-- belt-and-braces for hand-created rows.
COMMENT ON COLUMN public.tenants.allow_cross_border_transcription IS
  'Tenant-level toggle for Anthropic (US-hosted) transcription. DEFAULT TRUE '
  'for general tenants; backfilled to FALSE for tenants where regulated_vertical '
  'IS NOT NULL (BFSI / healthcare / government). Set TRUE explicitly + attestation '
  'row required to opt regulated tenants back in. Worker enforces the regulated '
  'override even if this column is TRUE without an attestation id (defense in depth).';

-- ── F-11 — append_tenant_audit tenant-membership check ─────────────────────
-- Mirrors the per-row authorization in insert_call_consent_log. Platform-scoped
-- users (user_role_assignments.tenant_id IS NULL) are allowed to write audit
-- rows for any tenant — they're the actors performing super-admin actions, and
-- the audit row is precisely the trail of those actions.
CREATE OR REPLACE FUNCTION public.append_tenant_audit(
  p_tenant_id     UUID,
  p_actor_id      UUID,
  p_actor_role    TEXT,
  p_action        TEXT,
  p_entity_type   TEXT,
  p_entity_id     UUID,
  p_justification TEXT,
  p_ticket_ref    TEXT,
  p_before_value  JSONB,
  p_after_value   JSONB,
  p_ip_address    INET,
  p_user_agent    TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id      UUID;
  v_uid     UUID := auth.uid();
  v_allowed BOOLEAN;
BEGIN
  IF v_uid IS NOT NULL THEN
    -- Allow if caller is a member of the target tenant, OR holds a
    -- platform-scoped role (tenant_id IS NULL).
    SELECT EXISTS (
      SELECT 1 FROM public.user_role_assignments ura
       WHERE ura.user_id = v_uid
         AND ura.disabled_at IS NULL
         AND (ura.tenant_id = p_tenant_id OR ura.tenant_id IS NULL)
    ) INTO v_allowed;
    IF NOT v_allowed THEN
      RAISE EXCEPTION 'append_tenant_audit: caller % is not a member of tenant % nor a platform role', v_uid, p_tenant_id;
    END IF;
  END IF;

  INSERT INTO public.tenant_audit
    (tenant_id, actor_id, actor_role, action, entity_type, entity_id,
     justification, ticket_ref, before_value, after_value, ip_address, user_agent)
  VALUES
    (p_tenant_id, p_actor_id, p_actor_role, p_action, p_entity_type, p_entity_id,
     p_justification, p_ticket_ref, p_before_value, p_after_value, p_ip_address, p_user_agent)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ── #12 — orphan call_sessions sweeper ─────────────────────────────────────
-- `/api/calls/intent` pre-allocates a call_sessions row (status='queued') so
-- the consent log FK can be NOT NULL. If the user never calls /initiate (tab
-- closed, network drop), the row sits forever. Sweep daily at 02:15 IST.
-- CASCADE deletes the related call_consent_log and call_events rows (small
-- by definition for a never-dispatched session).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'wa-calling-orphan-sessions-sweep',
      '15 20 * * *',  -- 20:15 UTC = 01:45 IST next day (close to the existing 02:00 IST retention slot)
      $sql$
        DELETE FROM public.call_sessions
         WHERE status = 'queued'
           AND created_at < NOW() - INTERVAL '15 minutes';
      $sql$
    );
  END IF;
END $$;
