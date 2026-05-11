-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 038 — call_recordings UNIQUE on call_session_id
--
-- Surgical fix from the QA audit (.calling-feature/qa/01-api-audit.md
-- defect #2): the recording-archive worker calls
--   .upsert(row, { onConflict: 'call_session_id' })
-- which fails 100% of the time because migration 035 declared the column
-- NOT NULL REFERENCES … but omitted the UNIQUE constraint.
-- Without this, every recording archive job hits PG 42P10 and the playback
-- button never enables for any call.
--
-- Idempotent (DO block — Postgres < 16 doesn't support ADD CONSTRAINT IF NOT
-- EXISTS for UNIQUE). Forward-only. Header style matches migration 035.
-- ─────────────────────────────────────────────────────────────────────────────

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
