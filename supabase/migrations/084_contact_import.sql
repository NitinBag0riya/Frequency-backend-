-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 084 — Bulk contact import + saved segments (P1 #18).
--
-- BRIEF: Indian SMBs onboarding to Frequency arrive with thousands of
-- existing customer contacts in spreadsheets (Wati exports, Tally CRM
-- dumps, Excel sheets the founder's PA maintains). They need to:
--
--   1. Upload that spreadsheet and have it land in `contacts` without
--      a manual paste-per-row, AND with explicit DPDPA-compliant proof
--      of WHERE the consent for each row was originally captured.
--   2. Slice their contact book into saved segments ("Mumbai opted-in
--      WA marketing customers, contacted in the last 7 days") that
--      broadcasts and campaigns can target by id.
--
-- Two tables, both tenant-scoped via RLS that mirrors the existing
-- consent_events / contact_segments-adjacent pattern in 072 + 010.
--
-- Append-only on the import job side (worker writes everything else),
-- mutable on the segments side. Per-contact consent provenance lives
-- in `consent_events` rows the worker inserts — this table only carries
-- the job-level metadata (file label + consent basis + proof text).
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. contact_import_jobs — async file-driven contact import tracker ───
-- Operator uploads a CSV/XLSX; the API persists either the storage_path
-- (when Supabase Storage is configured) or the raw inline_payload (CSV
-- text only, capped at ~5MB at the route layer). The worker picks the
-- row up, parses, dry-runs, and once committed inserts contacts +
-- consent_events for each row.
create table if not exists public.contact_import_jobs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  uploaded_by     uuid references auth.users(id) on delete set null,
  -- Storage object key — 'tenant_id/job_id.csv' under the
  -- 'contact-imports' bucket. NULL when inline_payload is used instead.
  storage_path    text,
  -- Fallback when Storage isn't configured (dev / small uploads).
  -- The route layer caps this at 5MB so a runaway client can't exhaust
  -- the DB. Worker prefers storage_path when both are present.
  inline_payload  text,
  -- Human-friendly source filename (preserved for the audit trail —
  -- consent_events.source_detail keeps the same value).
  filename        text not null,
  -- Free-text tenant-supplied label, e.g. 'wati_export_2026Q1',
  -- 'website_signup_apr_jun'. Lands in consent_events.source_detail
  -- so the DPDPA audit log can group imports by collection campaign.
  source_label    text not null,
  -- DPDPA basis enum — the legal ground on which this batch of consents
  -- was originally collected. Maps 1:1 to consent_events.proof_text +
  -- source_detail.consent_basis so a regulator query can drill from
  -- one contact's consent event back to this row.
  consent_basis   text not null check (consent_basis in (
    'opt_in_form',
    'existing_customer',
    'migration',
    'referral',
    'manual_entry'
  )),
  -- Free-text evidentiary string the importer types in: e.g.
  -- "Customers who opted in to marketing on the website checkout
  -- flow, Apr–Jun 2026, IP logged at the time." This is the row that
  -- gets quoted in a DPDPA Board response.
  consent_proof_text text not null,
  status          text not null default 'pending' check (status in (
    'pending',
    'parsing',
    'dry_run',
    'executing',
    'completed',
    'failed',
    'partial',
    'cancelled'
  )),
  rows_total      int not null default 0,
  rows_imported   int not null default 0,
  rows_updated    int not null default 0,
  rows_skipped    int not null default 0,
  rows_error      int not null default 0,
  -- List of { row_number, error, raw } — capped at 200 entries by the
  -- worker so a 50k-row import with 49k errors doesn't blow up the row.
  errors_jsonb    jsonb not null default '[]'::jsonb,
  -- Preview cache from the dry-run step. First ~100 normalised rows so
  -- the FE can render a confirmation table without re-uploading.
  preview_jsonb   jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz
);

create index if not exists idx_cij_tenant
  on public.contact_import_jobs(tenant_id, created_at desc);

-- Hot-path index for the worker's "next job to process" query.
create index if not exists idx_cij_pending
  on public.contact_import_jobs(tenant_id, status)
  where status in ('pending','parsing','dry_run','executing');

comment on table public.contact_import_jobs is
  'Async CSV/XLSX contact import jobs. Worker (contact-import-processor) parses, dry-runs, then commits. Per-row consent provenance is materialised into consent_events at commit time — this table carries only the job-level evidentiary metadata (source_label + consent_basis + consent_proof_text).';

alter table public.contact_import_jobs enable row level security;

-- SELECT — tenant members read their own tenant's jobs.
drop policy if exists "cij_tenant_read" on public.contact_import_jobs;
create policy "cij_tenant_read" on public.contact_import_jobs
  for select to authenticated
  using (
    exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid() and tenant_id = contact_import_jobs.tenant_id
    )
    or exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and tenant_id = contact_import_jobs.tenant_id
    )
    or exists (
      select 1 from public.tenants where id = contact_import_jobs.tenant_id and user_id = auth.uid()
    )
  );

-- INSERT — tenant members can kick off an import. The .strict() schema on
-- the route side prevents spoofing status / rows_* fields.
drop policy if exists "cij_tenant_insert" on public.contact_import_jobs;
create policy "cij_tenant_insert" on public.contact_import_jobs
  for insert to authenticated
  with check (
    exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid() and tenant_id = contact_import_jobs.tenant_id
    )
    or exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and tenant_id = contact_import_jobs.tenant_id
    )
    or exists (
      select 1 from public.tenants where id = contact_import_jobs.tenant_id and user_id = auth.uid()
    )
  );

-- UPDATE / DELETE — service-role only (worker). Tenant users mutate via
-- the API (POST /commit, POST /cancel) which calls supabase with the
-- service role key. Revoking the table privileges at the role level is
-- belt-and-braces on top of "no policy = no access".
revoke update, delete on public.contact_import_jobs from authenticated;
revoke update, delete on public.contact_import_jobs from anon;

-- ─── 2. contact_segments — saved contact filters ─────────────────────────
-- Filter rules are jsonb so we can add filter keys (last_message_at,
-- segment-of-a-segment, …) without a follow-up migration. The
-- lib/segment-filter.ts evaluator on the server is the source of truth
-- for which keys are honoured.
create table if not exists public.contact_segments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null check (length(name) between 2 and 80),
  description     text,
  -- Filter spec, e.g.:
  --   { "city": "Mumbai",
  --     "tags": ["vip"],
  --     "opted_in_channel": "whatsapp",
  --     "created_at_after": "2026-01-01T00:00:00Z" }
  -- Unknown keys are ignored by the evaluator (forward compat).
  filters         jsonb not null default '{}'::jsonb,
  -- Cached estimate so the FE can show "≈ 1.2k matching" without
  -- re-evaluating on every render. Worker / count endpoint refreshes
  -- on read with a stale-while-revalidate flavour.
  estimated_count int not null default 0,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  archived_at     timestamptz,
  unique (tenant_id, name)
);

-- Only the non-archived segments are surfaced in the segment picker —
-- a partial index keeps that lookup tight.
create index if not exists idx_cs_tenant_archived
  on public.contact_segments(tenant_id)
  where archived_at is null;

comment on table public.contact_segments is
  'Saved contact filters. Broadcasts / campaigns target a segment by id; the segment-filter evaluator turns filters jsonb into a Supabase query against contacts (+ contact_consent_state for channel-opt-in joins).';

alter table public.contact_segments enable row level security;

-- SELECT — tenant members read their tenant's segments.
drop policy if exists "cs_tenant_read" on public.contact_segments;
create policy "cs_tenant_read" on public.contact_segments
  for select to authenticated
  using (
    exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid() and tenant_id = contact_segments.tenant_id
    )
    or exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and tenant_id = contact_segments.tenant_id
    )
    or exists (
      select 1 from public.tenants where id = contact_segments.tenant_id and user_id = auth.uid()
    )
  );

-- ALL (insert/update/delete) — tenant members. Defense-in-depth on top
-- of the API's checkPermission('leads','edit') gate.
drop policy if exists "cs_tenant_write" on public.contact_segments;
create policy "cs_tenant_write" on public.contact_segments
  for all to authenticated
  using (
    exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid() and tenant_id = contact_segments.tenant_id
    )
    or exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and tenant_id = contact_segments.tenant_id
    )
    or exists (
      select 1 from public.tenants where id = contact_segments.tenant_id and user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid() and tenant_id = contact_segments.tenant_id
    )
    or exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and tenant_id = contact_segments.tenant_id
    )
    or exists (
      select 1 from public.tenants where id = contact_segments.tenant_id and user_id = auth.uid()
    )
  );

-- ─── 3. updated_at maintenance for contact_segments ──────────────────────
-- Reuses the shared tg_set_updated_at trigger function from 072.
drop trigger if exists contact_segments_set_updated_at on public.contact_segments;
create trigger contact_segments_set_updated_at
  before update on public.contact_segments
  for each row execute function public.tg_set_updated_at();

-- ─── 4. broadcasts.segment_id — link a broadcast to a saved segment ──────
-- Additive column. When set, broadcast-worker resolves the audience via
-- lib/segment-filter.ts instead of the legacy audience.tags / exclude_tags
-- shape. Legacy broadcasts (segment_id IS NULL) keep working unchanged.
alter table public.broadcasts
  add column if not exists segment_id uuid references public.contact_segments(id) on delete set null;

comment on column public.broadcasts.segment_id is
  'Optional saved-segment target. When set, broadcast-worker uses lib/segment-filter.ts to resolve the audience instead of the legacy audience.tags shape. Both can coexist on a broadcast row; segment_id wins if both are present.';

create index if not exists idx_broadcasts_segment
  on public.broadcasts(segment_id)
  where segment_id is not null;

-- ─── Sanity check (run after migration) ──────────────────────────────────
-- \d+ public.contact_import_jobs
-- \d+ public.contact_segments
-- select column_name from information_schema.columns
--   where table_name='broadcasts' and column_name='segment_id';
-- select polname, polcmd from pg_policy where polrelid = 'public.contact_import_jobs'::regclass;
-- select polname, polcmd from pg_policy where polrelid = 'public.contact_segments'::regclass;
