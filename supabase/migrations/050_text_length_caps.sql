-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 050 — length caps + JSONB type checks on user-input columns
--
-- Threat model: every text/jsonb column populated by webhook ingest, public
-- form submissions, or authenticated multi-tenant write paths is a vector
-- for unbounded growth attacks (e.g. a malicious actor stuffing a 50 MB
-- string into messages.content via a webhook). Postgres TOAST handles size
-- but our app-side parsers, BroadcastChannel payloads, and Realtime row
-- replays don't. Caps are enforced at the row level so no codepath bypass
-- is possible.
--
-- Choices:
--   • messages.content  — 64 KB JSONB (typical WA message ≤ 4 KB; allow audio/media transcripts headroom)
--   • messages.contact_phone — 32 chars (E.164 max is 15 + provider suffixes)
--   • wa_templates.body  — 4096 chars (WABA hard limit is 1024 but template body assembly w/ vars can grow)
--   • notifications.body — 4096 chars
--   • lead_rows.data — 128 KB AND must be a JSONB object (rejects arrays / scalars)
--   • contacts.name — 256 chars
--   • tenants.business_name — 256 chars
--
-- Each ALTER is wrapped in a DO block catching duplicate_object so the
-- migration is fully re-runnable on a DB that already has the constraint.
-- ─────────────────────────────────────────────────────────────────────────────

-- messages.content (jsonb) — cap serialized payload at 64 KB
DO $$ BEGIN
  ALTER TABLE public.messages
    ADD CONSTRAINT messages_content_len_chk
    CHECK (length(content::text) <= 65536);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- messages.contact_phone — cap at 32 chars
DO $$ BEGIN
  ALTER TABLE public.messages
    ADD CONSTRAINT messages_contact_phone_len_chk
    CHECK (length(contact_phone) <= 32);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- wa_templates.body — cap at 4096 chars
DO $$ BEGIN
  ALTER TABLE public.wa_templates
    ADD CONSTRAINT wa_templates_body_len_chk
    CHECK (length(body) <= 4096);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- notifications.body — cap at 4096 chars (only if table exists)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'notifications') THEN
    BEGIN
      ALTER TABLE public.notifications
        ADD CONSTRAINT notifications_body_len_chk
        CHECK (length(body) <= 4096);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- lead_rows.data — must be JSONB object AND ≤ 128 KB
DO $$ BEGIN
  ALTER TABLE public.lead_rows
    ADD CONSTRAINT lead_rows_data_shape_chk
    CHECK (jsonb_typeof(data) = 'object' AND length(data::text) <= 131072);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- contacts.name — cap at 256 chars
DO $$ BEGIN
  ALTER TABLE public.contacts
    ADD CONSTRAINT contacts_name_len_chk
    CHECK (length(name) <= 256);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- tenants.business_name — cap at 256 chars (column is nullable; check tolerates NULL)
DO $$ BEGIN
  ALTER TABLE public.tenants
    ADD CONSTRAINT tenants_business_name_len_chk
    CHECK (business_name IS NULL OR length(business_name) <= 256);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
