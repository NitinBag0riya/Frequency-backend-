-- Add ingest_source audit column on lead_rows.
--
-- Background: four code paths (CSV import, webhook ingest, Google/Airtable
-- sync worker, data-sources route) write `ingest_source: '<csv|webhook|sync>'`
-- on every row insert as an audit trail — distinguishing webhook-ingested
-- rows from manual creations even when both stamp user_id = table.user_id.
--
-- The column was never actually created in any prior migration. supabase-js
-- silently dropped the field on inserts, but PostgREST 13+ now rejects with
-- "Could not find the 'ingest_source' column of 'lead_rows' in the schema
-- cache" because schema-cache misses produce 4xx errors instead of silent
-- drops. Users got the error on every Google Sheet import attempt.
--
-- Idempotent: IF NOT EXISTS so this migration is safe to re-run.
--
-- Values stamped by the application:
--   • 'webhook'  → POST /api/ingest/:token
--   • 'csv'      → CSV upload during table create
--   • 'sync'     → data-source-sync worker (Google Sheets, Airtable mirror)
--   • 'manual'   → POST /lead-tables/:id/rows (user-created via UI)  [default]

ALTER TABLE public.lead_rows
  ADD COLUMN IF NOT EXISTS ingest_source text DEFAULT 'manual';

-- Backfill existing rows to 'manual' (default kicks in for any NULL).
UPDATE public.lead_rows
  SET ingest_source = 'manual'
  WHERE ingest_source IS NULL;

-- Index for "show me everything that came from webhooks" / source attribution
-- queries on the Source tab. Partial index keeps it small — manual rows are
-- the common case and don't need the index.
CREATE INDEX IF NOT EXISTS lead_rows_ingest_source_idx
  ON public.lead_rows (table_id, ingest_source)
  WHERE ingest_source <> 'manual';

-- Refresh PostgREST schema cache so the new column is visible to API calls
-- immediately (without waiting for the next NOTIFY tick).
NOTIFY pgrst, 'reload schema';
