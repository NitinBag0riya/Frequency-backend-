-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 041 — Sentiment scoring on call transcripts (v1.1 TASK-5)
--
-- Adds four columns to call_transcripts so the transcribe worker can
-- attach a follow-up sentiment analysis to every completed transcript:
--   sentiment        — one-word label, constrained
--   summary          — one-line agent-facing summary
--   topics           — JSONB array of short topic tags
--   sentiment_dollar_cost — separate cost-bucket for the second Claude call
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.call_transcripts
  ADD COLUMN IF NOT EXISTS sentiment             TEXT,
  ADD COLUMN IF NOT EXISTS summary               TEXT,
  ADD COLUMN IF NOT EXISTS topics                JSONB,
  ADD COLUMN IF NOT EXISTS sentiment_dollar_cost NUMERIC(10,4);

-- Constraint added separately so the migration is rerunnable — duplicate
-- CHECK on the same name would otherwise fail on the second run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'call_transcripts_sentiment_check'
  ) THEN
    ALTER TABLE public.call_transcripts
      ADD CONSTRAINT call_transcripts_sentiment_check
      CHECK (sentiment IS NULL OR sentiment IN ('positive','neutral','negative','mixed'));
  END IF;
END $$;

COMMENT ON COLUMN public.call_transcripts.sentiment IS
  'Aggregate sentiment for the whole call. Set by call-transcribe worker '
  'AFTER the diarized transcript is persisted, via a second Anthropic call. '
  'NULL while pending or when AI dollar cap was hit before the sentiment pass.';

COMMENT ON COLUMN public.call_transcripts.summary IS
  '1-line agent-facing summary. Shown in CallTranscriptDrawer above the segments.';

COMMENT ON COLUMN public.call_transcripts.topics IS
  'JSONB string array of short topic tags ([\"billing\", \"refund\", \"churn-risk\"]). '
  'Used for analytics roll-ups + future sentiment-by-topic dashboards.';
