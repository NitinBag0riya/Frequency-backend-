-- ────────────────────────────────────────────────────────────────────────
-- 113_sites_foundation.sql
--
-- Promotes the single-page Forms builder into a multi-page Site builder
-- in the Shopify mold. A tenant builds a Site (or several) made of Pages.
-- Each Page composes the same widget library `form_pages.schema_json`
-- already uses — header / hero / section / form / image / video / CTA /
-- divider / payment / footer — so the existing PageRenderer + builder
-- carries forward unchanged.
--
-- Naming note: the data model says "sites" + "site_pages" universally.
-- The UI label forks to "Funnels" for agency-managed sub-tenants via
-- useSurfaceLabel() in the FE — no schema branching for that.
--
-- Tables introduced:
--   • sites        — one row per Site a tenant owns
--   • site_pages   — pages inside a site; each page has its own slug
--                    and PageSchema (same shape as form_pages.schema_json)
--
-- Cross-references:
--   • form_submissions / form_partial_submissions / form_field_events get
--     a nullable site_page_id so a Site page can collect submissions
--     exactly like a standalone form does today. form_id stays nullable
--     so legacy /forms keeps working untouched for the 90-day transition.
-- ────────────────────────────────────────────────────────────────────────

-- ── sites ───────────────────────────────────────────────────────────────
create table if not exists public.sites (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  name                text not null,
  slug                text not null,
  -- custom_domain stays null until task #5 (custom-domain provisioning)
  -- ships. When set, the public router resolves the host header to this
  -- site instead of using /p/:tenantSlug/:siteSlug/:pageSlug.
  custom_domain       text unique,
  -- The page rendered when the visitor hits the site root. Nullable
  -- because a brand-new site has no pages yet; first page created
  -- becomes home automatically.
  home_page_id        uuid,
  -- Navigation config — array of { label, page_id } that the site_nav
  -- widget consumes. Stored as jsonb so we can iterate without a
  -- migration every time we add a nav property (target=_blank, icon, …).
  nav_json            jsonb not null default '{"links": []}'::jsonb,
  -- Theme overrides (colors, font family, button radius). Inherits from
  -- tenant_brand_kit when keys are missing.
  theme_json          jsonb not null default '{}'::jsonb,
  status              text not null default 'draft'
                      check (status in ('draft','published','archived')),
  -- Plan tier at publish time — same snapshot model as form_pages so a
  -- downgrade can't strip features from an already-public site.
  published_plan_tier text,
  published_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, slug)
);

create index if not exists idx_sites_tenant_status
  on public.sites(tenant_id, status);

-- ── site_pages ──────────────────────────────────────────────────────────
create table if not exists public.site_pages (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.sites(id) on delete cascade,
  -- Denormalized tenant_id so RLS predicates can match on the row itself
  -- without joining to sites. Same trick form_submissions uses.
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  slug          text not null,
  title         text not null,
  schema_json   jsonb not null default '{"version":1,"widgets":[]}'::jsonb,
  -- Per-page settings that the form_pages table also has: a Site page
  -- IS a (possibly-form-containing) page, after all.
  post_save_action_json   jsonb,
  post_submit_action_json jsonb,
  response_table_id       uuid references public.lead_tables(id) on delete set null,
  -- SEO + open-graph (title override, description, og_image). Lets the
  -- builder set per-page meta without changing the schema_json.
  seo_json      jsonb not null default '{}'::jsonb,
  status        text not null default 'draft'
                check (status in ('draft','published','archived')),
  -- Display order in the SiteDetailPage list. Cheap integer; FE
  -- reorders by drag-and-drop and PATCHes new values.
  sort_order    integer not null default 0,
  -- Exactly one page per site should have is_home=true. We don't enforce
  -- with a unique partial index here because the FE always promotes a
  -- new home in a single transaction; if the invariant breaks, the
  -- renderer falls back to the lowest sort_order.
  is_home       boolean not null default false,
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (site_id, slug)
);

create index if not exists idx_site_pages_site         on public.site_pages(site_id);
create index if not exists idx_site_pages_status       on public.site_pages(status);
create index if not exists idx_site_pages_tenant       on public.site_pages(tenant_id);

-- Now wire the home_page_id FK now that site_pages exists. Done as a
-- DEFERRABLE FK so an INSERT to sites + INSERT to site_pages +
-- UPDATE sites.home_page_id can all happen in the same transaction.
alter table public.sites
  add constraint sites_home_page_fkey
  foreign key (home_page_id) references public.site_pages(id) on delete set null
  deferrable initially deferred;

-- ── Submission FK extensions ────────────────────────────────────────────
-- form_submissions et al keep working for legacy standalone forms; the
-- new site_page_id column lights up the Site page submission path.
alter table public.form_submissions
  add column if not exists site_page_id uuid references public.site_pages(id) on delete cascade;
alter table public.form_partial_submissions
  add column if not exists site_page_id uuid references public.site_pages(id) on delete cascade;
alter table public.form_field_events
  add column if not exists site_page_id uuid references public.site_pages(id) on delete cascade;

-- Drop the NOT NULL on form_id since Site-page submissions don't have one.
-- (Standalone-form submissions still set it; Site-page submissions leave
--  it null and use site_page_id instead.)
alter table public.form_submissions         alter column form_id drop not null;
alter table public.form_partial_submissions alter column form_id drop not null;
alter table public.form_field_events        alter column form_id drop not null;

-- At least one of (form_id, site_page_id) must be set on every row.
-- Skip if a previous attempt already added the constraint.
do $$ begin
  alter table public.form_submissions
    add constraint form_submissions_target_check
    check (form_id is not null or site_page_id is not null);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.form_partial_submissions
    add constraint form_partial_submissions_target_check
    check (form_id is not null or site_page_id is not null);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.form_field_events
    add constraint form_field_events_target_check
    check (form_id is not null or site_page_id is not null);
exception when duplicate_object then null; end $$;

create index if not exists idx_form_submissions_site_page
  on public.form_submissions(site_page_id) where site_page_id is not null;

-- ── updated_at triggers ─────────────────────────────────────────────────
drop trigger if exists trg_sites_updated_at on public.sites;
create trigger trg_sites_updated_at before update on public.sites
  for each row execute function public.set_updated_at();

drop trigger if exists trg_site_pages_updated_at on public.site_pages;
create trigger trg_site_pages_updated_at before update on public.site_pages
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────
alter table public.sites enable row level security;
alter table public.site_pages enable row level security;

-- Same tenant-membership predicate as form_pages — a user can read/write
-- a site iff they hold an active role assignment in its tenant.
create policy sites_tenant on public.sites
  for all using (
    auth.uid() in (
      select user_id from public.user_role_assignments
      where tenant_id = sites.tenant_id and disabled_at is null
    )
  );

create policy site_pages_tenant on public.site_pages
  for all using (
    auth.uid() in (
      select user_id from public.user_role_assignments
      where tenant_id = site_pages.tenant_id and disabled_at is null
    )
  );

-- Public anon read for published pages — used by /p/:tenant/:site/:page.
-- Only published pages of published sites are visible to anon.
create policy site_pages_public_read on public.site_pages
  for select to anon using (
    status = 'published' and
    site_id in (select id from public.sites where status = 'published')
  );

create policy sites_public_read on public.sites
  for select to anon using (status = 'published');

-- ── Comments (ops + introspection) ──────────────────────────────────────
comment on table public.sites      is 'Multi-page Site (a tenant''s microsite). Custom-domain capable. Live at /p/{tenant}/{site_slug}/{page_slug} or {custom_domain}/{page_slug}.';
comment on table public.site_pages is 'A page inside a Site. schema_json uses the same widget library as form_pages.schema_json.';
comment on column public.form_submissions.site_page_id is
  'When non-null, this submission belongs to a Site page (form_id stays null). Mutually exclusive with form_id but the CHECK constraint only requires one to be set.';
