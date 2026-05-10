-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 029 — additional notification event types
--
-- Adds events the original 019 seed missed but the codebase now needs:
--   lead.assigned   — assignment rule routed a new row to a user (the
--                     real-time complement to MyQueue's badge polling)
--   workflow.chained — a downstream workflow auto-fired from chaining
--                      (debug aid for users wiring multi-step flows)
--
-- Idempotent via on conflict (key) do update set.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.notification_event_types
  (key, category, title_template, body_template, default_channels, severity, description)
VALUES
  -- Body template uses {{summary}} so the caller can pass either:
  --   "Open it from My Queue" (single row)
  --   "3 rows just landed — open My Queue" (batch)
  -- without the template trying to compose count + rule name itself.
  ('lead.assigned',     'inbox', 'New {{table_name}} row assigned to you',
    '{{summary}}',
    ARRAY['in_app']::text[], 'info',
    'Assignment rule auto-routed a new row to this user'),
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
