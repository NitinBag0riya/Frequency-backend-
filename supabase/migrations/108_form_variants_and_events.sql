-- ────────────────────────────────────────────────────────────────────────
-- Migration 108 — A/B variants + funnel analytics events
-- ────────────────────────────────────────────────────────────────────────
-- Two changes share this migration because they share the same data
-- infrastructure:
--
--   1) form_pages gets variant linking columns so a single form can have
--      multiple variants with deterministic traffic split.
--   2) form_field_events captures per-field engagement signals (focus,
--      blur, change, abandon) so we can render a drop-off funnel.
-- ────────────────────────────────────────────────────────────────────────

-- ── A/B variants ────────────────────────────────────────────────────────
alter table public.form_pages
  add column if not exists variant_of    uuid references public.form_pages(id) on delete set null,
  add column if not exists variant_label text,
  add column if not exists variant_weight integer default 50;

create index if not exists idx_form_pages_variant_of
  on public.form_pages (variant_of) where variant_of is not null;

-- Stamp the chosen variant on every submission so the funnel can
-- correlate downstream conversion.
alter table public.form_submissions
  add column if not exists variant_id uuid references public.form_pages(id) on delete set null;

create index if not exists idx_form_submissions_variant
  on public.form_submissions (variant_id) where variant_id is not null;

-- ── form_field_events (funnel analytics) ────────────────────────────────
-- One row per engagement event on the public form. Tiny rows; high
-- volume. anonymous_visitor_id is sticky across multi-step navigation
-- for the same visitor so we can compute "started → completed" funnels.
create table if not exists public.form_field_events (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  form_id               uuid not null references public.form_pages(id) on delete cascade,
  variant_id            uuid references public.form_pages(id) on delete set null,
  anonymous_visitor_id  text not null,
  field_id              text,             -- nullable for whole-page events (e.g. step_advance)
  event_type            text not null
                        check (event_type in (
                          'view','focus','change','blur','step_advance','submit_attempt','submit_success'
                        )),
  step_index            integer,
  utm_json              jsonb default '{}'::jsonb,
  event_ts              timestamptz not null default now()
);

create index if not exists idx_form_field_events_form_time
  on public.form_field_events (form_id, event_ts desc);
create index if not exists idx_form_field_events_visitor
  on public.form_field_events (form_id, anonymous_visitor_id);

alter table public.form_field_events enable row level security;
create policy form_field_events_read_tenant on public.form_field_events
  for select using (
    exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid() and tenant_id = form_field_events.tenant_id
        and disabled_at is null
    )
  );
-- Inserts only via service role (the public ingest endpoint runs as
-- service role). No anon/authed insert policies → fully blocked.

comment on table  public.form_field_events
  is 'Engagement events on public forms (Block C). Funnel + conversion analytics.';
comment on column public.form_pages.variant_of
  is 'A/B variants — when set, this row is a variant of another form_pages row. Parent stays canonical.';
