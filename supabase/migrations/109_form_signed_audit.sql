-- ────────────────────────────────────────────────────────────────────────
-- Migration 109 — Signed forms audit columns
-- ────────────────────────────────────────────────────────────────────────
-- Adds the audit trail fields a signed-form submission needs to be
-- legally defensible:
--   • signer_name      — typed-name fallback if no signature widget value
--   • signed_at        — server-set timestamp at submit
--   • signer_ip_hash   — already on the row via the existing ip_hash;
--                        kept aliased here for clarity
--   • signer_user_agent — already on the row via user_agent; reused
--   • document_hash    — sha256 of the form's schema_json AT submit time,
--                        so we can later prove "this is the exact doc
--                        they signed" even if the form was edited later
--   • pdf_path         — Supabase Storage path to the generated PDF
--                        receipt (worker fills in async)
--   • pdf_status       — 'pending' | 'rendered' | 'failed'
-- ────────────────────────────────────────────────────────────────────────

alter table public.form_submissions
  add column if not exists signer_name      text,
  add column if not exists signed_at        timestamptz,
  add column if not exists document_hash    text,
  add column if not exists pdf_path         text,
  add column if not exists pdf_status       text
    check (pdf_status in ('pending','rendered','failed')),
  add column if not exists pdf_error        text;

create index if not exists idx_form_submissions_signed_at
  on public.form_submissions (form_id, signed_at desc)
  where signed_at is not null;

comment on column public.form_submissions.document_hash
  is 'sha256(schema_json) at submit time. Proves form contents at signing.';
comment on column public.form_submissions.pdf_path
  is 'Supabase Storage path to the generated PDF receipt (form-uploads bucket).';
