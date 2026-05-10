-- ─── tenants.gmail_history_id ───────────────────────────────────────────
--
-- Per-tenant cursor for the gmail-poller worker. Gmail's `history.list`
-- endpoint takes a `startHistoryId` and returns only changes since that
-- point — much cheaper than re-listing the whole inbox each tick.
--
-- Lifecycle:
--   - NULL on a fresh Google connect → worker uses bootstrap path
--     (last 5 minutes of primary inbox) and seeds this column with the
--     newest history id from that result
--   - Updated on every successful poll tick to the most recent history id
--   - Reset to NULL if Gmail returns 404 on history.list (the id is too
--     old; Gmail purges history records after ~7 days). Worker re-bootstraps
--     on the next tick.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS gmail_history_id text;

COMMENT ON COLUMN public.tenants.gmail_history_id IS
  'Gmail mailbox history cursor for the gmail-poller worker. NULL = bootstrap '
  'on next tick. Updated to the newest history id after each successful poll.';
