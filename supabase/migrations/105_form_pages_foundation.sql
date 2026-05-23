-- ────────────────────────────────────────────────────────────────────────
-- Migration 105 — Form Pages foundation (Phase 0 of the Pages/Forms feature)
-- ────────────────────────────────────────────────────────────────────────
-- Lands the schema for the new public page builder:
--   • tenant_brand_kit     — per-tenant brand defaults (logo, colors, font)
--   • form_pages           — the form/page itself (widget tree, config)
--   • form_submissions     — every public submission (audit + analytics)
--   • plan_quotas          — config table for plan-gate enforcement
--
-- Public URL: https://getfrequency.app/f/{tenant-slug}/{form-slug}
-- Plan gates locked-in 2026-05-23 — see plan_quotas seed at the bottom.
-- ────────────────────────────────────────────────────────────────────────

-- ── tenant_brand_kit ────────────────────────────────────────────────────
-- One row per tenant. Stores the visual defaults a Page widget can prefill
-- from. Created lazily the first time a tenant opens the form builder.
-- Editable inline in the Header widget; "Use for this form only" toggle
-- decides whether the edit writes through to this row or stays in the
-- form_pages.branding_overrides_json.
create table if not exists public.tenant_brand_kit (
  tenant_id       uuid primary key references public.tenants(id) on delete cascade,
  brand_name      text,
  logo_url        text,
  primary_color   text default '#10B981',   -- brand-500
  font_family     text default 'Inter',
  contact_email   text,
  display_phone   text,
  address_json    jsonb default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);

alter table public.tenant_brand_kit enable row level security;
-- Service role bypasses RLS; tenant members can read their own kit; only
-- admins can write. Same pattern as other tenant-scoped settings tables.
create policy tenant_brand_kit_select on public.tenant_brand_kit
  for select using (
    auth.uid() in (
      select user_id from public.user_role_assignments
      where tenant_id = tenant_brand_kit.tenant_id and disabled_at is null
    )
  );
create policy tenant_brand_kit_write on public.tenant_brand_kit
  for all using (
    auth.uid() in (
      select user_id from public.user_role_assignments
      where tenant_id = tenant_brand_kit.tenant_id and disabled_at is null
    )
  );

-- ── form_pages ──────────────────────────────────────────────────────────
-- One row per form. schema_json is the widget tree (see Phase 0 TS types).
-- Status lifecycle: draft → published → (archived).
-- response_table_id + response_mapping_id link a submitted form to the
-- existing Tables + Mapping system (so the entire ingest pipeline is
-- reused, including transforms, column allowlists, RLS).
create table if not exists public.form_pages (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  slug                     text not null,
  title                    text not null,
  schema_json              jsonb not null default '{"widgets":[]}'::jsonb,
  response_table_id        uuid references public.lead_tables(id) on delete set null,
  response_mapping_id      uuid references public.lead_field_mappings(id) on delete set null,
  post_save_action_json    jsonb default '{"kind":"none"}'::jsonb,
  branding_overrides_json  jsonb default '{}'::jsonb,
  settings_json            jsonb default '{}'::jsonb,
  status                   text not null default 'draft'
                           check (status in ('draft','published','archived')),
  -- Snapshot of plan tier at publish time so quota enforcement is stable
  -- even if the tenant downgrades mid-month.
  published_plan_tier      text,
  published_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- Per-tenant slug uniqueness. Public URL is /f/<tenant_slug>/<form_slug>.
  unique (tenant_id, slug)
);

create index if not exists idx_form_pages_tenant_status
  on public.form_pages (tenant_id, status);
create index if not exists idx_form_pages_published_at
  on public.form_pages (published_at desc nulls last) where status = 'published';

alter table public.form_pages enable row level security;
create policy form_pages_tenant on public.form_pages
  for all using (
    auth.uid() in (
      select user_id from public.user_role_assignments
      where tenant_id = form_pages.tenant_id and disabled_at is null
    )
  );
-- Public anon read for published forms — used by the public renderer.
-- Only the schema_json + title + slug surface; sensitive fields are
-- excluded by the server route (select clause), not RLS. The whole row
-- is fine to surface because there are no secrets in it.
create policy form_pages_public_read_published on public.form_pages
  for select to anon using (status = 'published');

-- ── form_submissions ────────────────────────────────────────────────────
-- One row per public form submit. Even if writing to the destination
-- Table fails, we land an audit row here so debugging is possible.
-- table_row_id is filled in after the lead row is created.
create table if not exists public.form_submissions (
  id                  uuid primary key default gen_random_uuid(),
  form_id             uuid not null references public.form_pages(id) on delete cascade,
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  submitted_at        timestamptz not null default now(),
  ip_hash             text,          -- sha256(ip + tenant_id) — for rate-limit + abuse, no raw IPs
  user_agent          text,
  referrer            text,
  utm_json            jsonb default '{}'::jsonb,   -- captured for analytics (Phase 3)
  response_data       jsonb not null,              -- raw form field values, validated
  table_row_id        uuid,                         -- filled in after successful Table INSERT
  post_action_status  text default 'pending'
                      check (post_action_status in ('pending','dispatched','succeeded','failed','none')),
  post_action_error   text,
  -- Sandbox test submissions auto-cleaned after 1h by the in-process
  -- daily scheduler (migration 104). Used by the editor's "Test submit".
  is_test             boolean not null default false
);

create index if not exists idx_form_submissions_form_time
  on public.form_submissions (form_id, submitted_at desc);
create index if not exists idx_form_submissions_tenant_month
  on public.form_submissions (tenant_id, submitted_at desc);
-- Index for the tenant-monthly quota check (covered by tenant_id + time).
create index if not exists idx_form_submissions_test_cleanup
  on public.form_submissions (submitted_at) where is_test = true;

alter table public.form_submissions enable row level security;
create policy form_submissions_tenant on public.form_submissions
  for select using (
    auth.uid() in (
      select user_id from public.user_role_assignments
      where tenant_id = form_submissions.tenant_id and disabled_at is null
    )
  );
-- Writes only via service role (the public submit endpoint runs with
-- service role; RLS-protected client never inserts directly here).
-- No insert/update/delete policies for anon/authed → fully blocked.

-- ── plan_quotas ─────────────────────────────────────────────────────────
-- Config table that drives the runtime gate checks. Keeping the limits in
-- the DB (instead of hardcoded constants) means we can adjust without a
-- deploy. The "Locked-in plan gates" table from the user discussion lives
-- here as seed data.
--
-- Read by:
--   • src/lib/form-quotas.ts on the public submit path (subs-per-form,
--     subs-per-tenant, file-size, storage)
--   • src/routes/forms.ts on create (forms-per-tenant)
--   • The footer-removal check on render time
create table if not exists public.plan_quotas (
  plan_tier              text primary key
                         check (plan_tier in ('free','starter','growth','pro')),
  max_forms_per_tenant   integer,             -- null = unlimited
  max_subs_per_tenant_mo integer,
  max_subs_per_form_mo   integer,
  max_file_size_mb       integer not null default 10,
  max_storage_mb         integer not null,
  ab_variants_allowed    boolean not null default false,
  signed_forms_allowed   boolean not null default false,
  gated_content_allowed  boolean not null default false,
  footer_removable       boolean not null default false,
  max_form_tables        integer,             -- only meaningful for free; null = unlimited
  updated_at             timestamptz not null default now()
);

insert into public.plan_quotas
  (plan_tier, max_forms_per_tenant, max_subs_per_tenant_mo, max_subs_per_form_mo,
   max_file_size_mb, max_storage_mb,
   ab_variants_allowed, signed_forms_allowed, gated_content_allowed, footer_removable,
   max_form_tables)
values
  ('free',     1,    100,    50,    10, 25,   false, false, false, false, 1),
  ('starter',  5,    1000,   300,   10, 500,  true,  false, false, false, null),
  ('growth',   25,   10000,  3000,  10, 5120, true,  true,  true,  false, null),
  ('pro',      null, 100000, 30000, 10, 51200,true,  true,  true,  true,  null)
on conflict (plan_tier) do update set
  max_forms_per_tenant   = excluded.max_forms_per_tenant,
  max_subs_per_tenant_mo = excluded.max_subs_per_tenant_mo,
  max_subs_per_form_mo   = excluded.max_subs_per_form_mo,
  max_file_size_mb       = excluded.max_file_size_mb,
  max_storage_mb         = excluded.max_storage_mb,
  ab_variants_allowed    = excluded.ab_variants_allowed,
  signed_forms_allowed   = excluded.signed_forms_allowed,
  gated_content_allowed  = excluded.gated_content_allowed,
  footer_removable       = excluded.footer_removable,
  max_form_tables        = excluded.max_form_tables,
  updated_at             = now();

alter table public.plan_quotas enable row level security;
-- Anyone (authed) can read; nobody can write except service role.
create policy plan_quotas_read on public.plan_quotas
  for select using (true);

-- ── updated_at triggers ──────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_form_pages_updated_at on public.form_pages;
create trigger trg_form_pages_updated_at before update on public.form_pages
  for each row execute function public.set_updated_at();

drop trigger if exists trg_tenant_brand_kit_updated_at on public.tenant_brand_kit;
create trigger trg_tenant_brand_kit_updated_at before update on public.tenant_brand_kit
  for each row execute function public.set_updated_at();

-- ── Comments (for ops + introspection) ───────────────────────────────────
comment on table  public.form_pages           is 'Public forms/pages built via the drag-and-drop builder. Live at /f/{tenant_slug}/{slug} when status=published.';
comment on table  public.form_submissions     is 'Audit + analytics row per public form submit. Survives even if the Table INSERT fails — so you can debug.';
comment on table  public.tenant_brand_kit     is 'Per-tenant brand defaults the form builder prefills into Header widget. Editable.';
comment on table  public.plan_quotas          is 'Plan-gate config table. Adjust limits without code deploys. Locked-in values set in migration 105 seed.';
