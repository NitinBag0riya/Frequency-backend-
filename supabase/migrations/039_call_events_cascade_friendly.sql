-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 039 — call_events trigger: allow FK CASCADE, still block manual DML
--
-- QA audit Defect #10 (.calling-feature/qa/01-api-audit.md). The
-- BEFORE-DELETE trigger on call_events from migration 035 fired for ALL
-- deletes, including ones coming from FK CASCADE (e.g. DELETE FROM tenants
-- ⇒ call_sessions ⇒ call_events). Result: any tenant with call history
-- was undeletable (breaks GDPR account closure + QA cleanup).
--
-- Fix: pg_trigger_depth() > 1 means this trigger is firing inside a deeper
-- trigger context — i.e. as part of a CASCADE from a parent FK. In that
-- case we permit the row to be removed. Manual `DELETE FROM call_events`
-- still RAISES (depth==1). UPDATE behaviour is unchanged.
--
-- Idempotent. Forward-only. CREATE OR REPLACE — no-op on environments
-- where untracked migration 037 has already applied the same fix.
-- ─────────────────────────────────────────────────────────────────────────────

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

-- ── QA audit Defect #7 — plans.features must include 'calls' ─────────────────
-- The routes now `checkPermission('calls', <action>)` (granular calls.*
-- permission tree from migration 035 §13). `checkPermission` step 4
-- (plan whitelist) requires the feature key to be present in plans.features.
-- Scale already has '*'; growth needs 'calls' added. Free/starter are blocked
-- earlier by the entitlement gate (plan-tier check). Idempotent.
UPDATE public.plans
   SET features = features || ARRAY['calls']::text[]
 WHERE id = 'growth'
   AND NOT (features @> ARRAY['calls']::text[]);
