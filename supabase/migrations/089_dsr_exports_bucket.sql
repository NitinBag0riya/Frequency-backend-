-- 089_dsr_exports_bucket.sql — create the private storage bucket DSR
-- access/portability exports upload to, so /api/dsr/:id/download can
-- always mint a signed URL instead of streaming the inline payload.
--
-- Background: P0.7 ships an idempotent two-path download:
--   1. PREFERRED — receipt.payload.export_storage_path is set; we mint
--      a signed Supabase Storage URL capped to the remaining 24h window.
--   2. FALLBACK — inline JSON payload streamed directly.
--
-- The fallback exists because the bucket was historically created
-- manually in the Supabase dashboard. This migration removes that
-- manual step so fresh environments always get the signed-URL path.
--
-- The bucket is PRIVATE (public=false). Access is via signed URLs only.
-- Service-role bypasses RLS on the storage schema, so the worker can
-- upload + the route can sign without policy hassle. Authenticated
-- users cannot list / read / write objects directly — they go through
-- the /api/dsr/:id/download endpoint, which signs on their behalf.

-- Insert the bucket. ON CONFLICT (id) DO NOTHING so re-running is safe.
-- Supabase's storage.buckets table is the canonical place; the schema +
-- table are present out-of-the-box.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'dsr-exports',
    'dsr-exports',
    false,        -- private bucket, access via signed URL only
    52428800,     -- 50 MB cap per export (DSR personal-data exports
                  -- are typically <1 MB; 50 MB cap is forgiving for
                  -- pathological "thousands of messages" exports)
    array['application/json']   -- JSON only (DSR receipts are JSON)
  )
  on conflict (id) do nothing;

-- Storage object policies. By default Supabase Storage has an empty
-- policy set — meaning service-role can do everything (bypasses RLS)
-- and authenticated cannot. That's exactly what we want for this
-- bucket. The route handler in src/routes/privacy-center.ts uses
-- supabase.storage.from('dsr-exports').createSignedUrl(...) which works
-- via service-role on the BE and returns a URL the user's browser can
-- fetch without auth.
--
-- If you ever want tenant members to be able to list their own DSR
-- exports directly via PostgREST (bypassing the BE), add a SELECT
-- policy on storage.objects scoped by the path prefix matching
-- tenant_id. For now, the BE-mediated signed URL is the only access
-- path — defense in depth.

-- (Originally this migration also ran `comment on table storage.buckets` to
-- record the dsr-exports purpose. Supabase Storage's storage.buckets is
-- owned by `supabase_admin`; the migration role can't COMMENT on it
-- — `must be owner of table buckets (SQLSTATE 42501)`. The bucket row
-- itself carries enough metadata (file_size_limit, allowed_mime_types,
-- public=false) for the purpose to be obvious. Dropped the COMMENT
-- statement rather than escalate privileges.)
