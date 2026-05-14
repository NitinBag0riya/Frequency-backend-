-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 056 — public waitlist signups
--
-- Captures pre-launch signups from the apex landing page (getfrequency.app).
-- Public POST endpoint /api/waitlist writes here. No auth required, RLS
-- prevents anonymous reads (counts go through a SECURITY DEFINER function
-- so we expose the rollup without leaking individual emails).
--
-- Idempotency: (lower(email)) is the unique key — a repeat submission with
-- the same email is silently treated as success (no PII duplication, no
-- error to the visitor). Phone is a soft attribute, not the dedup key,
-- because visitors might re-enter the same email with a different phone.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.waitlist (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  email_lower   text GENERATED ALWAYS AS (lower(email)) STORED,
  phone         text,
  source        text,                                          -- e.g. 'apex_landing'
  ip_hash       text,                                          -- sha256 of client IP for spam control
  user_agent    text,                                          -- truncated UA string
  referrer      text,                                          -- HTTP referer (truncated)
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Soft data integrity caps so a bot can't bloat the table
  CONSTRAINT waitlist_email_len CHECK (length(email) BETWEEN 3 AND 254),
  CONSTRAINT waitlist_phone_len CHECK (phone IS NULL OR length(phone) BETWEEN 4 AND 32),
  CONSTRAINT waitlist_ua_len    CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  CONSTRAINT waitlist_ref_len   CHECK (referrer IS NULL OR length(referrer) <= 512),
  CONSTRAINT waitlist_email_shape CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- Dedup unique on lowercased email
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_lower_uidx ON public.waitlist (email_lower);
CREATE INDEX IF NOT EXISTS waitlist_created_idx ON public.waitlist (created_at DESC);

-- RLS — no public reads. Inserts only via the service-role server endpoint.
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER function exposes the count without exposing rows.
-- Public landing page calls this via the server route to show "Join N
-- people waiting".
CREATE OR REPLACE FUNCTION public.waitlist_count()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::int FROM public.waitlist;
$$;

-- Allow anon role to call the count function (the rest of the table is
-- RLS-locked + service-role only). Inserts go through the server which
-- uses service-role, so no anon-INSERT policy is needed.
GRANT EXECUTE ON FUNCTION public.waitlist_count() TO anon, authenticated;
