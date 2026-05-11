-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 035 — WhatsApp Business Calling
--
-- See .calling-feature/think/03-migration-035.md for design rationale.
-- Refs: ADR-002 (.calling-feature/plan/02-adr-call-lifecycle.md),
--       PRD (.calling-feature/plan/01-prd.md),
--       Compliance (.calling-feature/plan/03-compliance.md).
--
-- Idempotent. Forward-only.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. tenants — calling defaults, retention, rate limits ──────────────────
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS recording_default       BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS transcription_default   BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS consent_default         TEXT    DEFAULT 'always_ask',
  ADD COLUMN IF NOT EXISTS call_minutes_allotment  INT     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS call_minutes_used_current_period INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS call_minutes_per_hour   INT     DEFAULT 60,
  ADD COLUMN IF NOT EXISTS recording_retention_days INT    DEFAULT 30,
  ADD COLUMN IF NOT EXISTS transcript_retention_days INT   DEFAULT 30,
  ADD COLUMN IF NOT EXISTS recording_retention_attestation_id UUID,
  ADD COLUMN IF NOT EXISTS allow_cross_border_transcription BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS regulated_vertical      TEXT;

DO $$ BEGIN
  ALTER TABLE public.tenants
    ADD CONSTRAINT tenants_consent_default_check
    CHECK (consent_default IN ('always_ask','always_on','always_off'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.tenants
    ADD CONSTRAINT tenants_recording_retention_days_check
    CHECK (recording_retention_days BETWEEN 1 AND 365);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.tenants
    ADD CONSTRAINT tenants_transcript_retention_days_check
    CHECK (transcript_retention_days BETWEEN 1 AND 365);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.tenants
    ADD CONSTRAINT tenants_regulated_vertical_check
    CHECK (regulated_vertical IS NULL
           OR regulated_vertical IN ('bfsi','healthcare','government','edtech_minors'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.tenants
    ADD CONSTRAINT tenants_call_minutes_per_hour_check
    CHECK (call_minutes_per_hour BETWEEN 0 AND 10000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. contacts — is_callable generated column ─────────────────────────────
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS is_callable BOOLEAN
    GENERATED ALWAYS AS (phone IS NOT NULL AND phone <> '') STORED;

CREATE INDEX IF NOT EXISTS contacts_callable_idx
  ON public.contacts(tenant_id) WHERE is_callable = true;

-- ── 3. helper — tenants of the calling user ────────────────────────────────
CREATE OR REPLACE FUNCTION public.current_user_tenant_ids() RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM public.user_role_assignments
  WHERE user_id = auth.uid()
    AND tenant_id IS NOT NULL
    AND disabled_at IS NULL
$$;
GRANT EXECUTE ON FUNCTION public.current_user_tenant_ids() TO authenticated;

-- ── 4. call_sessions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_sessions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  contact_id               UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  agent_id                 UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  direction                TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  status                   TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','dialing','ringing','connected',
                                             'completed','rejected','missed',
                                             'failed','cancelled')),
  source                   TEXT CHECK (source IN ('inbox','contacts','leads','inbound')),
  meta_call_id             TEXT UNIQUE,
  meta_waba_id             TEXT,
  recording_consent        TEXT NOT NULL DEFAULT 'none'
                           CHECK (recording_consent IN
                                  ('record_transcribe','record_only','none')),
  recording_consent_source TEXT CHECK (recording_consent_source IN
                                  ('agent_modal','tenant_default_on',
                                   'tenant_default_off','customer_dtmf_optout')),
  queued_at                TIMESTAMPTZ DEFAULT NOW(),
  dialing_at               TIMESTAMPTZ,
  ringing_at               TIMESTAMPTZ,
  connected_at             TIMESTAMPTZ,
  ended_at                 TIMESTAMPTZ,
  duration_seconds         INT GENERATED ALWAYS AS (
                             CASE WHEN connected_at IS NOT NULL AND ended_at IS NOT NULL
                                  THEN EXTRACT(EPOCH FROM (ended_at - connected_at))::INT
                                  ELSE NULL END
                           ) STORED,
  billable_seconds         INT,
  failure_reason           TEXT,
  ended_by                 TEXT CHECK (ended_by IN
                                  ('agent','customer','system','timeout','meta_error')),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.call_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS call_sessions_tenant_created_idx
  ON public.call_sessions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS call_sessions_tenant_status_idx
  ON public.call_sessions(tenant_id, status);
CREATE INDEX IF NOT EXISTS call_sessions_tenant_agent_created_idx
  ON public.call_sessions(tenant_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS call_sessions_tenant_contact_created_idx
  ON public.call_sessions(tenant_id, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS call_sessions_active_idx
  ON public.call_sessions(tenant_id, status, created_at DESC)
  WHERE status IN ('queued','dialing','ringing','connected');

DROP POLICY IF EXISTS "cs_tenant_select" ON public.call_sessions;
CREATE POLICY "cs_tenant_select" ON public.call_sessions
  FOR SELECT USING (tenant_id IN (SELECT public.current_user_tenant_ids()));
DROP POLICY IF EXISTS "cs_tenant_insert" ON public.call_sessions;
CREATE POLICY "cs_tenant_insert" ON public.call_sessions
  FOR INSERT WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
DROP POLICY IF EXISTS "cs_tenant_update" ON public.call_sessions;
CREATE POLICY "cs_tenant_update" ON public.call_sessions
  FOR UPDATE USING (tenant_id IN (SELECT public.current_user_tenant_ids()))
              WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));

COMMENT ON TABLE public.call_sessions IS
  'One row per WA Business Calling session (inbound or outbound). State machine '
  'driven by call_events; duration_seconds is generated from connected_at/ended_at. '
  'billable_seconds is written by the ingest worker.';

-- ── 5. call_events (append-only) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  call_session_id  UUID NOT NULL REFERENCES public.call_sessions(id) ON DELETE CASCADE,
  meta_event_id    TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  raw_payload      JSONB NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at     TIMESTAMPTZ,
  CONSTRAINT call_events_tenant_meta_event_uniq UNIQUE (tenant_id, meta_event_id)
);
ALTER TABLE public.call_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS call_events_session_received_idx
  ON public.call_events(call_session_id, received_at);
CREATE INDEX IF NOT EXISTS call_events_tenant_received_idx
  ON public.call_events(tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS call_events_unprocessed_idx
  ON public.call_events(tenant_id, received_at)
  WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION public.call_events_block_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'call_events is append-only (tenant=% event=%)',
    COALESCE(OLD.tenant_id::text, NEW.tenant_id::text),
    COALESCE(OLD.meta_event_id, NEW.meta_event_id);
END $$;

DROP TRIGGER IF EXISTS call_events_no_update ON public.call_events;
CREATE TRIGGER call_events_no_update
  BEFORE UPDATE ON public.call_events
  FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id
        OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
        OR OLD.call_session_id IS DISTINCT FROM NEW.call_session_id
        OR OLD.meta_event_id IS DISTINCT FROM NEW.meta_event_id
        OR OLD.event_type IS DISTINCT FROM NEW.event_type
        OR OLD.raw_payload::text IS DISTINCT FROM NEW.raw_payload::text
        OR OLD.received_at IS DISTINCT FROM NEW.received_at)
  EXECUTE FUNCTION public.call_events_block_mutation();

DROP TRIGGER IF EXISTS call_events_no_delete ON public.call_events;
CREATE TRIGGER call_events_no_delete
  BEFORE DELETE ON public.call_events
  FOR EACH ROW EXECUTE FUNCTION public.call_events_block_mutation();

DROP POLICY IF EXISTS "ce_tenant_select" ON public.call_events;
CREATE POLICY "ce_tenant_select" ON public.call_events
  FOR SELECT USING (tenant_id IN (SELECT public.current_user_tenant_ids()));

COMMENT ON TABLE public.call_events IS
  'Append-only event log (Meta webhook fan-in). UNIQUE (tenant_id, meta_event_id) '
  'is the idempotency contract. Triggers block UPDATE of forensic columns and any '
  'DELETE. processed_at is the only mutable field.';

-- ── 6. call_recordings ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_recordings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  call_session_id   UUID NOT NULL REFERENCES public.call_sessions(id) ON DELETE CASCADE,
  meta_recording_id TEXT,
  storage_path      TEXT,
  duration_seconds  INT,
  size_bytes        BIGINT,
  mime_type         TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','archived','failed','expired','deleted')),
  expires_at        TIMESTAMPTZ,
  archived_at       TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.call_recordings ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS call_recordings_tenant_expires_idx
  ON public.call_recordings(tenant_id, expires_at)
  WHERE status IN ('archived','pending');
CREATE INDEX IF NOT EXISTS call_recordings_session_idx
  ON public.call_recordings(call_session_id);

-- Note: can_access_recording() function lives outside this migration; the
-- API mediates playback. Plain RLS gates by tenant; per-row playback audit
-- is enforced at the API layer (writes to tenant_audit before signing URL).
DROP POLICY IF EXISTS "cr_tenant_select" ON public.call_recordings;
CREATE POLICY "cr_tenant_select" ON public.call_recordings
  FOR SELECT USING (tenant_id IN (SELECT public.current_user_tenant_ids()));
DROP POLICY IF EXISTS "cr_tenant_insert" ON public.call_recordings;
CREATE POLICY "cr_tenant_insert" ON public.call_recordings
  FOR INSERT WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
DROP POLICY IF EXISTS "cr_tenant_update" ON public.call_recordings;
CREATE POLICY "cr_tenant_update" ON public.call_recordings
  FOR UPDATE USING (tenant_id IN (SELECT public.current_user_tenant_ids()))
              WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));

COMMENT ON TABLE public.call_recordings IS
  'One row per recorded call. storage_path -> inbox-media/calls/<tenant>/<call>.opus. '
  'expires_at set at archive time. Retention cron flips status=deleted + clears '
  'storage_path; bucket delete via BullMQ. Playback path is API-mediated and '
  'audit-logged in tenant_audit.';

-- ── 7. call_transcripts ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_transcripts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  call_session_id          UUID NOT NULL UNIQUE
                           REFERENCES public.call_sessions(id) ON DELETE CASCADE,
  status                   TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','completed','failed',
                                             'skipped_cap','skipped_no_consent',
                                             'expired','deleted')),
  transcript_raw           TEXT,
  transcript_redacted      TEXT,
  segments                 JSONB,
  input_tokens             INT DEFAULT 0,
  output_tokens            INT DEFAULT 0,
  dollar_cost              NUMERIC(10,4) DEFAULT 0,
  ai_cap_pre_check_passed  BOOLEAN,
  attempts                 INT NOT NULL DEFAULT 0,
  failure_reason           TEXT,
  expires_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  archived_at              TIMESTAMPTZ,
  deleted_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.call_transcripts ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS call_transcripts_tenant_expires_idx
  ON public.call_transcripts(tenant_id, expires_at)
  WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS call_transcripts_session_idx
  ON public.call_transcripts(call_session_id);
CREATE INDEX IF NOT EXISTS call_transcripts_tenant_status_idx
  ON public.call_transcripts(tenant_id, status);

DROP POLICY IF EXISTS "ct_tenant_select" ON public.call_transcripts;
CREATE POLICY "ct_tenant_select" ON public.call_transcripts
  FOR SELECT USING (tenant_id IN (SELECT public.current_user_tenant_ids()));
DROP POLICY IF EXISTS "ct_tenant_insert" ON public.call_transcripts;
CREATE POLICY "ct_tenant_insert" ON public.call_transcripts
  FOR INSERT WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
DROP POLICY IF EXISTS "ct_tenant_update" ON public.call_transcripts;
CREATE POLICY "ct_tenant_update" ON public.call_transcripts
  FOR UPDATE USING (tenant_id IN (SELECT public.current_user_tenant_ids()))
              WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));

COMMENT ON TABLE public.call_transcripts IS
  'At most one transcript per call (UNIQUE call_session_id). transcript_raw is '
  'pre-redaction; transcript_redacted is what the UI reads (Aadhaar/PAN/card '
  'scrubbed by lib/redact.ts). dollar_cost integrates with the existing '
  'AI dollar meter via usage_counters(metric=ai_cost_cents, purpose=call_transcript).';

-- ── 8. call_routing_rules ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_routing_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL UNIQUE
                      REFERENCES public.tenants(id) ON DELETE CASCADE,
  business_hours      JSONB NOT NULL DEFAULT '{}'::jsonb,
  agent_pool          UUID[] NOT NULL DEFAULT '{}',
  fallback_action     TEXT NOT NULL DEFAULT 'none'
                      CHECK (fallback_action IN ('voicemail','missed_template','none')),
  missed_template_id  UUID REFERENCES public.wa_templates(id) ON DELETE SET NULL,
  ring_strategy       TEXT NOT NULL DEFAULT 'parallel'
                      CHECK (ring_strategy IN ('parallel','round_robin')),
  ring_timeout_seconds INT NOT NULL DEFAULT 25 CHECK (ring_timeout_seconds BETWEEN 5 AND 60),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.call_routing_rules ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS call_routing_rules_tenant_idx
  ON public.call_routing_rules(tenant_id);

DROP POLICY IF EXISTS "crr_tenant_all" ON public.call_routing_rules;
CREATE POLICY "crr_tenant_all" ON public.call_routing_rules
  FOR ALL USING (tenant_id IN (SELECT public.current_user_tenant_ids()))
          WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));

COMMENT ON TABLE public.call_routing_rules IS
  'One rule per tenant in v1 (UNIQUE tenant_id). business_hours: '
  '{"monday":[{"start":"09:00","end":"18:00","tz":"Asia/Kolkata"}], ...}. '
  'agent_pool is auth.users(id)[] eligible to receive inbound rings.';

-- ── 9. call_consent_log (immutable) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_consent_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  call_session_id  UUID NOT NULL REFERENCES public.call_sessions(id) ON DELETE CASCADE,
  agent_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  consent_choice   TEXT NOT NULL
                   CHECK (consent_choice IN
                          ('record_transcribe','record_only','none',
                           'customer_dtmf_optout')),
  source           TEXT NOT NULL
                   CHECK (source IN ('agent_modal','tenant_default','customer_dtmf')),
  decided_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modal_dismissed  BOOLEAN NOT NULL DEFAULT false,
  ip_address       INET,
  user_agent       TEXT
);
ALTER TABLE public.call_consent_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS call_consent_log_session_idx
  ON public.call_consent_log(call_session_id);
CREATE INDEX IF NOT EXISTS call_consent_log_tenant_decided_idx
  ON public.call_consent_log(tenant_id, decided_at DESC);

DROP POLICY IF EXISTS "ccl_tenant_select" ON public.call_consent_log;
CREATE POLICY "ccl_tenant_select" ON public.call_consent_log
  FOR SELECT USING (tenant_id IN (SELECT public.current_user_tenant_ids()));

CREATE OR REPLACE FUNCTION public.insert_call_consent_log(
  p_tenant_id       UUID,
  p_call_session_id UUID,
  p_agent_id        UUID,
  p_consent_choice  TEXT,
  p_source          TEXT,
  p_modal_dismissed BOOLEAN,
  p_ip_address      INET,
  p_user_agent      TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_role_assignments ura
    WHERE ura.user_id = auth.uid()
      AND ura.tenant_id = p_tenant_id
      AND ura.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'insert_call_consent_log: caller is not a member of tenant %', p_tenant_id;
  END IF;

  INSERT INTO public.call_consent_log
    (tenant_id, call_session_id, agent_id, consent_choice, source,
     modal_dismissed, ip_address, user_agent)
  VALUES
    (p_tenant_id, p_call_session_id, p_agent_id, p_consent_choice, p_source,
     COALESCE(p_modal_dismissed, false), p_ip_address, p_user_agent)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE INSERT, UPDATE, DELETE ON public.call_consent_log FROM PUBLIC, anon, authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.insert_call_consent_log(
  UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, INET, TEXT
) TO authenticated, service_role;

COMMENT ON TABLE public.call_consent_log IS
  'Immutable evidentiary log of per-call consent (DPDP §6). INSERT only via '
  'insert_call_consent_log() SECURITY DEFINER. UPDATE/DELETE revoked from every '
  'role. Per-row write authorization (caller belongs to tenant) is enforced '
  'inside the function for defense-in-depth.';

-- ── 10. tenant_audit (immutable) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tenant_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  actor_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role    TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     UUID,
  justification TEXT,
  ticket_ref    TEXT,
  before_value  JSONB,
  after_value   JSONB,
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.tenant_audit ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS tenant_audit_tenant_created_idx
  ON public.tenant_audit(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tenant_audit_actor_created_idx
  ON public.tenant_audit(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tenant_audit_action_idx
  ON public.tenant_audit(tenant_id, action, created_at DESC);

DROP POLICY IF EXISTS "ta_tenant_select" ON public.tenant_audit;
CREATE POLICY "ta_tenant_select" ON public.tenant_audit
  FOR SELECT USING (tenant_id IN (SELECT public.current_user_tenant_ids()));

REVOKE INSERT, UPDATE, DELETE ON public.tenant_audit FROM PUBLIC, anon, authenticated, service_role;

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
DECLARE v_id UUID;
BEGIN
  INSERT INTO public.tenant_audit
    (tenant_id, actor_id, actor_role, action, entity_type, entity_id,
     justification, ticket_ref, before_value, after_value, ip_address, user_agent)
  VALUES
    (p_tenant_id, p_actor_id, p_actor_role, p_action, p_entity_type, p_entity_id,
     p_justification, p_ticket_ref, p_before_value, p_after_value, p_ip_address, p_user_agent)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
GRANT EXECUTE ON FUNCTION public.append_tenant_audit(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, JSONB, JSONB, INET, TEXT
) TO authenticated, service_role;

COMMENT ON TABLE public.tenant_audit IS
  'Tenant-scoped immutable audit log. Append-only via append_tenant_audit(). '
  'Used for: recording.playback, transcript.export, retention_policy.change, '
  'consent_default.change, cross_border_flag.toggle, erasure.request, erasure.complete. '
  'Retention 7y per compliance §9.1.';

-- ── 11. notification_event_types seed ──────────────────────────────────────
INSERT INTO public.notification_event_types
  (key, category, title_template, body_template, default_channels, severity, description)
VALUES
  ('call.incoming',           'inbox',   'Incoming call from {{contact_name}}', '{{phone}}',
   ARRAY['in_app']::text[], 'info',
   'A customer is calling — surface as ringing toast on agent-pool clients'),
  ('call.missed',             'inbox',   'Missed call from {{contact_name}}',   '{{phone}} · {{missed_at}}',
   ARRAY['in_app','email']::text[], 'warning',
   'An inbound call was missed (no agent picked up / outside business hours)'),
  ('call.transcript_ready',   'inbox',   'Transcript ready for {{contact_name}}', 'Open call to review',
   ARRAY['in_app']::text[], 'success',
   'Post-call transcription completed'),
  ('call.recording_expiring', 'billing', 'Recordings expiring in 7 days',         '{{count}} recordings will be purged on {{purge_date}}',
   ARRAY['in_app','email']::text[], 'warning',
   'Retention warning sent 7 days before retention deadline')
ON CONFLICT (key) DO UPDATE SET
  category         = EXCLUDED.category,
  title_template   = EXCLUDED.title_template,
  body_template    = EXCLUDED.body_template,
  default_channels = EXCLUDED.default_channels,
  severity         = EXCLUDED.severity,
  description      = EXCLUDED.description;

-- ── 12. feature flag ───────────────────────────────────────────────────────
INSERT INTO public.feature_flags
  (key, is_enabled, rollout_percent, enabled_for_tenants, value_json, description, updated_at)
VALUES
  ('wa_calling_enabled', false, 0, '{}'::uuid[], '{}'::jsonb,
   'Per-tenant gate for WhatsApp Business Calling (LA rollout). Super-admin '
   'enables tenants individually via enabled_for_tenants during Limited Availability.',
   NOW())
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at  = NOW();

-- ── 13. role_definitions — calls.* capabilities ────────────────────────────
UPDATE public.role_definitions
SET permissions = jsonb_set(permissions, '{calls}',
  jsonb_build_object('initiate',true,'answer',true,'listen',true,
    'read_transcript',true,'configure_default',true,'view_billing',true,
    'download_recording',true,'override_dnd',true,'read_metadata',true), true)
WHERE scope='tenant' AND key='workspace_admin' AND is_built_in=true;

UPDATE public.role_definitions
SET permissions = jsonb_set(permissions, '{calls}',
  jsonb_build_object('initiate',true,'answer',true,'listen',true,
    'read_transcript',true,'configure_default',false,'view_billing',true,
    'download_recording',true,'override_dnd',true,'read_metadata',true), true)
WHERE scope='tenant' AND key='sales_manager' AND is_built_in=true;

UPDATE public.role_definitions
SET permissions = jsonb_set(permissions, '{calls}',
  jsonb_build_object('initiate',true,'answer',true,'listen',true,
    'read_transcript',true,'configure_default',false,'view_billing',false,
    'download_recording',false,'override_dnd',false,'read_metadata',true), true)
WHERE scope='tenant' AND key='sales_rep' AND is_built_in=true;

UPDATE public.role_definitions
SET permissions = jsonb_set(permissions, '{calls}',
  jsonb_build_object('initiate',true,'answer',true,'listen',true,
    'read_transcript',true,'configure_default',false,'view_billing',false,
    'download_recording',false,'override_dnd',false,'read_metadata',true), true)
WHERE scope='tenant' AND key='support_agent' AND is_built_in=true;

UPDATE public.role_definitions
SET permissions = jsonb_set(permissions, '{calls}',
  jsonb_build_object('initiate',false,'answer',false,'listen',false,
    'read_transcript',false,'configure_default',false,'view_billing',true,
    'download_recording',false,'override_dnd',false,'read_metadata',false), true)
WHERE scope='tenant' AND key='marketing_manager' AND is_built_in=true;

UPDATE public.role_definitions
SET permissions = jsonb_set(permissions, '{calls}',
  jsonb_build_object('initiate',false,'answer',false,'listen',false,
    'read_transcript',false,'configure_default',false,'view_billing',true,
    'download_recording',false,'override_dnd',false,'read_metadata',true), true)
WHERE scope='tenant' AND key='analyst' AND is_built_in=true;

UPDATE public.role_definitions
SET permissions = jsonb_set(permissions, '{calls}',
  jsonb_build_object('initiate',true,'answer',true,'listen',true,
    'read_transcript',true,'configure_default',true,'view_billing',true,
    'download_recording',true,'override_dnd',true,'read_metadata',true,
    'impersonator_can_call',false), true)
WHERE scope='platform' AND key='platform_owner' AND is_built_in=true;

-- ── 14. Realtime publication (matches existing pattern) ────────────────────
DO $$ BEGIN
  PERFORM 1 FROM pg_publication WHERE pubname = 'supabase_realtime';
  IF FOUND THEN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.call_sessions;     EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.call_events;       EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.call_recordings;   EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.call_transcripts;  EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- ── 15. pg_cron retention jobs (only if extension is enabled) ──────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.schedule(
      'wa_calling_retention_daily',
      '30 20 * * *',
      $cron$
        WITH r AS (
          UPDATE public.call_recordings cr
             SET status='deleted', storage_path=NULL, deleted_at=NOW(), updated_at=NOW()
           WHERE cr.expires_at < NOW() AND cr.status IN ('archived','pending')
          RETURNING cr.id, cr.tenant_id, cr.call_session_id
        )
        INSERT INTO public.tenant_audit (tenant_id, action, entity_type, entity_id, after_value)
        SELECT tenant_id, 'recording.retention_purge', 'call_recording', id,
               jsonb_build_object('call_session_id', call_session_id) FROM r;
      $cron$
    );
    PERFORM cron.schedule(
      'wa_calling_transcript_retention_daily',
      '35 20 * * *',
      $cron$
        UPDATE public.call_transcripts
           SET status='deleted', transcript_raw=NULL, transcript_redacted=NULL,
               segments=NULL, deleted_at=NOW(), updated_at=NOW()
         WHERE expires_at < NOW() AND status='completed';
      $cron$
    );
  END IF;
END $$;

-- ── 16. Done. Verification queries in .calling-feature/think/03-migration-035.md §11.
