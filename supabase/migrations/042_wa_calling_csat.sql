-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 042 — CSAT post-call template (v1.1 TASK-6)
--
-- Adds tenant-level toggle + template name + delay knob, plus a column on
-- call_sessions to correlate the CSAT survey message with the call later
-- (for the call-log "rating" pill when the customer replies).
--
-- Compliance note: WhatsApp Business policy treats unsolicited follow-up
-- messages as marketing. The disclosure greeting must mention "you may
-- receive a quick follow-up survey" before recording starts; that copy
-- update lives in compliance §6.7 and is captured separately in the
-- regulated-tenant onboarding checklist.
--
-- Idempotent — re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS csat_enabled         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS csat_template_name   TEXT,
  ADD COLUMN IF NOT EXISTS csat_delay_minutes   INT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS csat_min_call_seconds INT NOT NULL DEFAULT 30;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tenants_csat_delay_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_csat_delay_check
      CHECK (csat_delay_minutes BETWEEN 1 AND 60);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tenants_csat_min_seconds_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_csat_min_seconds_check
      CHECK (csat_min_call_seconds BETWEEN 10 AND 600);
  END IF;
END $$;

-- Correlate the CSAT survey send with the call so the call-log row can
-- show the customer's rating once they reply. NULL until the worker
-- enqueues the send. No FK to messages.id (messages are channel-scoped,
-- call.completed may fire before the row exists in some race orderings).
ALTER TABLE public.call_sessions
  ADD COLUMN IF NOT EXISTS csat_template_message_id UUID,
  ADD COLUMN IF NOT EXISTS csat_rating              SMALLINT,
  ADD COLUMN IF NOT EXISTS csat_response_received_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'call_sessions_csat_rating_check'
  ) THEN
    ALTER TABLE public.call_sessions
      ADD CONSTRAINT call_sessions_csat_rating_check
      CHECK (csat_rating IS NULL OR csat_rating BETWEEN 1 AND 5);
  END IF;
END $$;

COMMENT ON COLUMN public.tenants.csat_enabled IS
  'When true, the call-event-ingest worker enqueues a delayed WA template '
  'send after every call that completes with duration >= csat_min_call_seconds.';

COMMENT ON COLUMN public.tenants.csat_template_name IS
  'Name of the wa_templates row to send. Must be approved by Meta + flagged '
  'as a UTILITY or AUTHENTICATION category to bypass the 24h marketing window.';

COMMENT ON COLUMN public.call_sessions.csat_template_message_id IS
  'Set when the CSAT template send is enqueued (NULL if csat_enabled was off '
  'or call was too short). Use it to correlate the customer reply back to '
  'this call when populating csat_rating.';
