-- ────────────────────────────────────────────────────────────────────────
-- Migration 106 — form-uploads storage bucket policies
-- ────────────────────────────────────────────────────────────────────────
-- Phase 2 file-upload field needs a Supabase Storage bucket that:
--   • Accepts anon writes via signed upload URL (we mint per submit)
--   • Lets tenant members read their own uploads
--   • Service role bypasses everything (the public submit endpoint
--     persists the resulting object key onto form_submissions.response_data)
--
-- The bucket itself is private — the public form renderer never reads
-- objects directly. Submissions are reviewed via the FormSubmissionsPage
-- which proxies through the service-role API.
-- ────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'form-uploads',
  'form-uploads',
  false,
  -- 10MB cap matches plan_quotas.max_file_size_mb. Larger uploads fail at
  -- the Storage layer before we waste BE compute. Per-tenant plan-tier
  -- caps are enforced in the route handler.
  10 * 1024 * 1024,
  null  -- mime accept list is per-field on the form, enforced FE + BE
)
on conflict (id) do update set
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── Storage RLS policies ────────────────────────────────────────────────
-- Object key shape (enforced by the upload endpoint, NOT by RLS):
--   form-uploads/{tenant_id}/{form_id}/{submission_id}/{filename}
-- That lets us scope reads + deletes by tenant_id via the path's first
-- segment. Tenant members can read anything under their tenant prefix;
-- service role bypasses RLS entirely.

drop policy if exists "tenant members read form-uploads" on storage.objects;
create policy "tenant members read form-uploads"
  on storage.objects for select
  using (
    bucket_id = 'form-uploads'
    and (storage.foldername(name))[1]::uuid in (
      select tenant_id from public.user_role_assignments
      where user_id = auth.uid() and disabled_at is null
    )
  );

-- Anonymous insert is allowed via the signed-URL flow (PostgREST mints a
-- one-shot upload token in the submit endpoint). No anon insert policy
-- needed here because signed URLs bypass RLS.

-- No anon delete; tenant admins delete via the API path (service role).
