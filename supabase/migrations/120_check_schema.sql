-- SQL to add the missing channel column to workflow_sessions
ALTER TABLE public.workflow_sessions
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';

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

CREATE INDEX IF NOT EXISTS workflow_sessions_active_by_channel
  ON public.workflow_sessions (tenant_id, channel, contact_phone)
  WHERE status = 'active';
