-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 053 — missing FK + composite indexes
--
-- Trade-off: dropped CONCURRENTLY because supabase CLI's pgwire pipeline
-- rejects it (pipeline mode = implicit transaction; CONCURRENTLY can't
-- run inside any transaction). For tables that are large in production
-- (>1M rows on wa_flow_responses or messages), re-create the index by
-- hand via the Supabase Studio SQL editor or a direct psql session:
--   DROP INDEX IF EXISTS <name>;
--   CREATE INDEX CONCURRENTLY <name> ON <table>(...);
-- That avoids the brief write lock the regular CREATE INDEX takes here.
--
-- Threat model: missing FK indexes turn UPDATE/DELETE on the parent table
-- into a sequential scan on the child to enforce referential integrity.
-- For wa_flow_responses (rows-per-flow can reach 100k+) deleting a single
-- contact triggers a full-table scan.
--
-- All indexes are IF NOT EXISTS — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- wa_flow_responses.contact_id → contacts(id) (set null cascade path scans this)
CREATE INDEX IF NOT EXISTS wa_flow_responses_contact_idx
  ON public.wa_flow_responses (contact_id);

-- meta_ad_campaigns.ad_account_id (text, but app filters by it constantly)
CREATE INDEX IF NOT EXISTS meta_ad_campaigns_ad_account_idx
  ON public.meta_ad_campaigns (ad_account_id);

-- campaign_enrollments.contact_id → contacts(id)
CREATE INDEX IF NOT EXISTS campaign_enrollments_contact_idx
  ON public.campaign_enrollments (contact_id);

-- messages: composite for inbox/session join — partial because session_id
-- is sparse and we never query without a tenant filter.
CREATE INDEX IF NOT EXISTS messages_session_tenant_idx
  ON public.messages (tenant_id, session_id)
  WHERE session_id IS NOT NULL;

-- messages: composite for broadcast stats rollup (sent / delivered / read).
-- Partial because broadcast_id is null on inbound messages.
CREATE INDEX IF NOT EXISTS messages_broadcast_tenant_idx
  ON public.messages (tenant_id, broadcast_id, created_at DESC)
  WHERE broadcast_id IS NOT NULL;
