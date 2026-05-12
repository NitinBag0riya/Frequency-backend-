-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 043 — Callback queue MVP (v1.1 TASK-4a)
--
-- Adds an `outcome` column to call_sessions so missed/abandoned calls
-- can be triaged from a dedicated Callbacks tab on WACallingPage. NULL
-- means "still in the callback queue"; any non-NULL value moves the row
-- out of the queue.
--
-- Enum values (extensible later as the IVR/voicemail bundle lands):
--   callback_attempted — agent clicked "Call back", new outbound call placed
--   callback_done      — customer eventually called back themselves
--   no_action          — agent decided no follow-up needed (dismiss)
--   voicemail_left     — reserved for TASK-4b
--
-- Idempotent — re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.call_sessions
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outcome_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'call_sessions_outcome_check'
  ) THEN
    ALTER TABLE public.call_sessions
      ADD CONSTRAINT call_sessions_outcome_check
      CHECK (
        outcome IS NULL OR outcome IN (
          'callback_attempted',
          'callback_done',
          'no_action',
          'voicemail_left'
        )
      );
  END IF;
END $$;

-- Partial index — only the rows that need triage. Keeps the callback
-- queue listing query (WHERE status='missed' AND outcome IS NULL) cheap
-- even when the call_sessions table grows to millions of rows.
CREATE INDEX IF NOT EXISTS call_sessions_callback_queue_idx
  ON public.call_sessions (tenant_id, ended_at DESC)
  WHERE status = 'missed' AND outcome IS NULL;

COMMENT ON COLUMN public.call_sessions.outcome IS
  'Triage state for missed/abandoned calls in the Callbacks tab. NULL means '
  'still in the queue; setting any allowed value moves the row out.';
