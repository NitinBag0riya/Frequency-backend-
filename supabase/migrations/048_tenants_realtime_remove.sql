-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 048 — remove `public.tenants` from supabase_realtime publication
--
-- Threat model: tenants.access_token is a Meta WhatsApp Business long-lived
-- user access token. The same row also stores google_access_token and
-- google_refresh_token. Adding the table to supabase_realtime causes the
-- row's full payload to be replicated to every client subscribed to the
-- channel. Combined with the (intentionally permissive) RLS policy
-- "Users manage own tenants", a workspace owner's tokens are broadcast in
-- realtime — and any future RLS bug or service_role-key leak would expose
-- secrets to all listeners.
--
-- We never need realtime updates on tenant rows in the FE (status flips are
-- displayed on next page load). Drop from publication, keep RLS as-is.
--
-- Idempotent — DROP TABLE IF EXISTS is safe to re-run, and the wrapping
-- exception swallows the case where the publication itself doesn't exist
-- (fresh local dev DB without the supabase_realtime extension).
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.tenants;
  EXCEPTION
    WHEN undefined_object THEN NULL;  -- table not in publication, fine
    WHEN undefined_table  THEN NULL;  -- table doesn't exist (impossible in prod, defensive)
    WHEN others           THEN NULL;  -- publication doesn't exist on local dev
  END;
END $$;

COMMENT ON TABLE public.tenants IS
  'Realtime intentionally NOT enabled — row contains Meta access_token + Google '
  'refresh_token. See migration 048.';
