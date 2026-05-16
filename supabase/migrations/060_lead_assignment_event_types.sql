-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 060 — lead.assigned + workflow.chained event types
--
-- AUDIT NOTE (2026-05-16): The same INSERTs lived in migration 029, but that
-- file never landed in production (verified by selecting
-- notification_event_types where key='lead.assigned' → empty result, with
-- the rest of the 028-onward migrations intact). That left every call site
-- in src/leads.ts that emits `lead.assigned` silently no-opping — the
-- emitNotification() helper logs "[notifications] unknown event_key" and
-- returns [] without writing a row. Result: rule-based assignment, manual
-- assignment, bulk apply, webhook ingest, and CSV import all worked
-- functionally but assignees never got an in-app notification.
--
-- Idempotent via ON CONFLICT — safe to apply on any environment regardless
-- of whether 029 made it. Keep the file even after the next deploy so
-- fresh-environment bootstraps (CI ephemeral DBs, contributor laptops)
-- still produce a complete event-type catalog.
--
-- Channel choice rationale:
--   • lead.assigned — default ['in_app'] only. Email per-assignment would
--     be noisy for high-volume sales orgs (one a minute). Users who want
--     email for this can opt in via Settings → Notifications.
--   • workflow.chained — debug aid for users wiring multi-step workflows;
--     default ['in_app'] only for the same reason.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.notification_event_types
  (key, category, title_template, body_template, default_channels, severity, description)
VALUES
  -- Body uses {{summary}} so the caller composes "Open it from My Queue"
  -- (single row) or "3 rows just landed — open My Queue" (batch) without
  -- the template trying to compose count + rule name itself.
  ('lead.assigned',     'inbox', 'New {{table_name}} row assigned to you',
    '{{summary}}',
    ARRAY['in_app']::text[], 'info',
    'Assignment rule auto-routed a new row to this user, or a teammate manually assigned a row to them'),
  ('workflow.chained',  'system', 'Workflow "{{name}}" auto-started',
    'Chained from "{{upstream_name}}"',
    ARRAY['in_app']::text[], 'info',
    'A downstream workflow auto-fired from chaining')
ON CONFLICT (key) DO UPDATE SET
  category         = EXCLUDED.category,
  title_template   = EXCLUDED.title_template,
  body_template    = EXCLUDED.body_template,
  default_channels = EXCLUDED.default_channels,
  severity         = EXCLUDED.severity,
  description      = EXCLUDED.description;
