-- The pre-insert pattern (P0-4) writes outbound rows with status='queued'
-- BEFORE the Meta send, then patches to 'sent'/'failed' after. The original
-- messages.status CHECK constraint (migration 002) only allowed
-- 'sent'|'delivered'|'read'|'failed' — the 'queued' INSERT silently
-- violated the check and dropped the row, defeating the race fix.
--
-- Widen the constraint to accept 'queued'. Drop + recreate is the only
-- way to alter a CHECK in Postgres.

alter table public.messages
  drop constraint if exists messages_status_check;

alter table public.messages
  add constraint messages_status_check
  check (status in ('queued','sent','delivered','read','failed'));
