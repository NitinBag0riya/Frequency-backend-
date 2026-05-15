-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 058 — lead_rows.dedup_key for idempotent webhook ingest
--
-- Bug: src/leads.ts:949 was doing a plain `.from('lead_rows').insert(inserts)`
-- on every POST to /api/ingest/:token. That means a Zapier retry, an n8n
-- replayed run, or a double-clicked form submission all created duplicate
-- rows. The endpoint had a token-bucket rate limiter but no idempotency
-- semantics, so well-behaved at-least-once delivery producers — exactly the
-- producers most likely to talk to this endpoint — produced duplicates.
--
-- Fix design (full detail in src/leads.ts deriveDedupKey + the upsert path):
--   1. Explicit `_dedup_key` field in the payload wins (Stripe-style key).
--   2. Else fall back to email (lowercased) or phone (digits-only) read from
--      common spellings: email/Email/e_mail, phone/Phone/phone_number/...
--   3. If neither, no dedup_key is stored and a plain insert happens — the
--      legacy behaviour is fully preserved for payloads that genuinely lack
--      a natural identity. (Doing otherwise would silently break Zapier
--      pipelines that intentionally allow duplicates.)
--
-- Storage side (this file):
--   • Add a nullable `dedup_key text` column. NULL = "no dedup possible".
--   • Add a PARTIAL unique index on (table_id, dedup_key) WHERE dedup_key
--     IS NOT NULL. The partial predicate is critical — without it the
--     unique constraint would treat each NULL as distinct under MVCC but
--     prevent us from cleanly stating intent. With it the index is small
--     (only rows that opted in to dedup) and only enforces uniqueness where
--     dedup_key is set.
--   • No backfill. Existing rows stay NULL → they never collide. Future
--     rows from the webhook handler will carry dedup_key when derivable.
--
-- Race-condition note:
--   The handler does SELECT-by-(table_id, dedup_key) → merge → upsert. Two
--   near-simultaneous POSTs with the same key can both see "no existing
--   row", both attempt an INSERT, and the second one hits a unique
--   violation against this index. That's the index's job: it's the
--   serializer of last resort. The handler catches the 23505 SQLSTATE and
--   retries via the merge path. See deriveDedupKey + upsertWithDedup.
--
-- Backwards compatibility:
--   • Column is nullable → existing INSERT paths that don't supply
--     dedup_key continue to work unchanged.
--   • Manual row creation, CSV import, data-source sync (Google Sheets /
--     Airtable / CSV URL) all bypass the webhook handler and never set
--     dedup_key. They keep their current dedup model (or lack thereof —
--     Sheets/Airtable already dedup at the source-row level).
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Add the column ────────────────────────────────────────────────────
-- Nullable, no default. NULL means "this row was not eligible for dedup at
-- ingest time" (manual row, CSV import, payload without _dedup_key/email/
-- phone). The webhook handler writes a normalized non-null value when it
-- can derive one.
ALTER TABLE public.lead_rows
  ADD COLUMN IF NOT EXISTS dedup_key text;

COMMENT ON COLUMN public.lead_rows.dedup_key IS
  'Idempotency key for webhook ingest (migration 058). Source: explicit '
  '_dedup_key payload field, else lowercased email, else digits-only phone. '
  'NULL = no dedup possible. See src/leads.ts deriveDedupKey().';

-- ── 2. Partial unique index ──────────────────────────────────────────────
-- WHERE dedup_key IS NOT NULL keeps the index small (only opt-in rows) and
-- avoids enforcing uniqueness on the legacy NULL population. Re-POSTing the
-- same _dedup_key (or the same email/phone) for the same table_id is
-- rejected at the storage layer with SQLSTATE 23505 — handler catches and
-- folds the new payload into the existing row.
CREATE UNIQUE INDEX IF NOT EXISTS lead_rows_table_dedup_uq
  ON public.lead_rows (table_id, dedup_key)
  WHERE dedup_key IS NOT NULL;

COMMENT ON INDEX public.lead_rows_table_dedup_uq IS
  'Enforces idempotent webhook ingest. Partial: only rows with a derivable '
  'dedup_key participate. Handler path: src/leads.ts → /api/ingest/:token.';

COMMIT;
