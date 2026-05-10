-- ─── workflow_sessions.channel ──────────────────────────────────────────
--
-- Multi-channel workflow execution. Before this migration the executor
-- ALWAYS sent replies via WhatsApp because that's the only thing the send
-- queue knew how to route to. Now that workers/message-sender.ts handles
-- WhatsApp + Instagram + Telegram + email, the executor needs to know
-- which channel to use for the reply — and the source of truth is the
-- channel the workflow was triggered FROM.
--
-- Default 'whatsapp' so existing rows behave exactly as before
-- (no behaviour change for anyone who hasn't connected IG / TG).
--
-- All steps idempotent — re-running this migration is a no-op.

ALTER TABLE public.workflow_sessions
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';

-- Constrain to known channels. Adding the constraint AFTER the column so
-- existing rows pick up the default first and pass the check.
DO $$ BEGIN
  ALTER TABLE public.workflow_sessions
    ADD CONSTRAINT workflow_sessions_channel_check
    CHECK (channel IN ('whatsapp', 'instagram', 'telegram'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.workflow_sessions.channel IS
  'Origin channel the workflow was triggered from. The executor uses this to '
  'route reply messages back through the same channel via message-sender. '
  'Set by the inbound webhook handlers (whatsapp/instagram/telegram).';

-- Index by (tenant_id, channel, contact_phone) so the inbound webhook
-- session-lookup query (find active session for this contact on this
-- channel) is O(index) — without it the existing (tenant_id, contact_phone)
-- index could match a Telegram chat_id against a WhatsApp phone if the
-- numeric strings collided.
CREATE INDEX IF NOT EXISTS workflow_sessions_active_by_channel
  ON public.workflow_sessions (tenant_id, channel, contact_phone)
  WHERE status = 'active';
