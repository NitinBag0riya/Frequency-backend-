-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 037 — WhatsApp Business Calling FIXES
--
-- Surgical fixes to migration 035 follow-up from the QA audit
-- (.calling-feature/qa/01-api-audit.md). Two defects addressed at the DB layer:
--
--   • Defect #2 — call_recordings.upsert(onConflict: 'call_session_id') fails
--     because migration 035 omitted the UNIQUE constraint on that column.
--
--   • Defect #10 — call_events BEFORE-DELETE trigger blocks FK CASCADE,
--     making tenant deletion impossible once any call history exists. We
--     replace the trigger function so cascaded deletes (pg_trigger_depth > 0)
--     are allowed while manual DELETEs still RAISE.
--
-- Idempotent. Forward-only. Header style matches migration 035.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Defect #2 — UNIQUE constraint on call_recordings.call_session_id ────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'call_recordings_call_session_id_key'
       AND conrelid = 'public.call_recordings'::regclass
  ) THEN
    ALTER TABLE public.call_recordings
      ADD CONSTRAINT call_recordings_call_session_id_key UNIQUE (call_session_id);
  END IF;
END $$;

-- ── Defect #10 — call_events trigger allows CASCADE DELETE ──────────────────
-- pg_trigger_depth() > 0 is true when this trigger fires as part of a
-- cascading action from a parent table (tenants/call_sessions DELETE),
-- so we permit the row to be removed. Manual DELETE FROM call_events
-- still RAISES — depth==0.
CREATE OR REPLACE FUNCTION public.call_events_block_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'call_events is append-only (tenant=% event=%)',
    COALESCE(OLD.tenant_id::text, NEW.tenant_id::text),
    COALESCE(OLD.meta_event_id, NEW.meta_event_id);
END $$;
