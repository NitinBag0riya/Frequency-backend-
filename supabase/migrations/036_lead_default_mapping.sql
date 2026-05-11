-- 036_lead_default_mapping.sql
-- Pins a saved field mapping to be auto-applied at ingest time.
--
-- Three ingest entry points fold into this:
--
--   1. `lead_tables.default_mapping_id`
--      Applied by POST /api/ingest/:token (webhook) when set. Pinned from the
--      table's Source tab in the UI. Without it, webhook payloads land
--      verbatim (current behaviour) — the column is NULL by default so this
--      migration is non-breaking.
--
--   2. `data_source_subscriptions.default_mapping_id`
--      Applied by the data-source-sync worker on every Google Sheets /
--      Airtable poll. Pinned from the live-mirror card in the UI. NULL =
--      worker's existing keyify/column_mappings behaviour (back-compat).
--
-- Both reference `lead_field_mappings(id)` with ON DELETE SET NULL so
-- deleting a mapping from the global library doesn't orphan ingest paths —
-- they just fall back to verbatim mode and the UI prompts the user to pick
-- a new one.

ALTER TABLE lead_tables
  ADD COLUMN IF NOT EXISTS default_mapping_id uuid
    REFERENCES lead_field_mappings(id) ON DELETE SET NULL;

ALTER TABLE data_source_subscriptions
  ADD COLUMN IF NOT EXISTS default_mapping_id uuid
    REFERENCES lead_field_mappings(id) ON DELETE SET NULL;

-- Index the FK columns so the worker tick + the webhook handler don't pay
-- a seq scan when looking up the pinned mapping. Both are nullable so we
-- use partial indexes to keep them tight.
CREATE INDEX IF NOT EXISTS idx_lead_tables_default_mapping_id
  ON lead_tables(default_mapping_id)
  WHERE default_mapping_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_data_source_subscriptions_default_mapping_id
  ON data_source_subscriptions(default_mapping_id)
  WHERE default_mapping_id IS NOT NULL;
