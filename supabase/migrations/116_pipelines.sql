-- ────────────────────────────────────────────────────────────────────────
-- Migration 116 — Pipelines + Vertical Packs foundation
-- ────────────────────────────────────────────────────────────────────────
-- Lands the three overlay tables that turn a raw lead_tables + workflows
-- pair into a first-class "Pipeline" — a multi-stage funnel with bound
-- workflows for lifecycle events. Real Estate is the first vertical pack
-- (seeded from the BE manifest in src/data/packs/real-estate-pack.ts via
-- the boot upsert in src/lib/seed-packs.ts).
--
--   • pipelines                   — installed pipeline bundles per tenant
--   • pipeline_workflow_bindings  — ties workflows to lifecycle events
--   • pipeline_packs              — curated marketplace, public-read
--
-- Storage is intentionally thin: data still lives in lead_tables /
-- lead_rows; workflows still live in `workflows`. These tables only add
-- the overlay (stage definitions, event bindings, install metadata) so
-- the existing engine + UI surfaces keep working unchanged.
--
-- Phase 2 (out of scope here): pipeline dashboard, kanban view, stage
-- transitions, activity log. Tracked at the top of src/routes/pipelines.ts.
-- ────────────────────────────────────────────────────────────────────────

-- ── pipelines ────────────────────────────────────────────────────────────
-- One row per installed pipeline. source_table_id points at the leads
-- table this pipeline owns. stages_json holds the stage definitions
-- (id, name, sort_order, color, terminal?). stage_column / key_column
-- tell the runtime which lead_columns to read for stage routing and
-- inbound message matching.
create table if not exists public.pipelines (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  slug            text not null,
  vertical        text not null
                  check (vertical in ('real_estate','healthcare','coaching','education','d2c','hospitality','other')),
  source_table_id uuid not null references public.lead_tables(id) on delete cascade,
  stages_json     jsonb not null default '[]'::jsonb,
  stage_column    text not null default 'Lead_Stage',
  key_column      text not null default 'Mobile',
  status          text not null default 'active'
                  check (status in ('active','archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, slug)
);

create index if not exists idx_pipelines_tenant_status
  on public.pipelines (tenant_id, status);
create index if not exists idx_pipelines_source_table
  on public.pipelines (source_table_id);

alter table public.pipelines enable row level security;

-- Tenant-isolated reads/writes via user_role_assignments — mirrors form_pages.
create policy pipelines_tenant on public.pipelines
  for all using (
    auth.uid() in (
      select user_id from public.user_role_assignments
      where tenant_id = pipelines.tenant_id and disabled_at is null
    )
  );

-- ── pipeline_workflow_bindings ───────────────────────────────────────────
-- Glue between pipelines and workflows. event identifies WHEN the
-- workflow should fire (row created, stage transition, inbound text,
-- scheduled cron, form submit, generic webhook). event_filter is the
-- event-specific payload — stage name for row_updated_stage, keyword
-- prefix for inbound_text, cron expression for scheduled, etc.
create table if not exists public.pipeline_workflow_bindings (
  id              uuid primary key default gen_random_uuid(),
  pipeline_id     uuid not null references public.pipelines(id) on delete cascade,
  workflow_id     uuid not null references public.workflows(id) on delete cascade,
  event           text not null
                  check (event in ('row_created','row_updated_stage','inbound_button',
                                   'inbound_text','webhook','scheduled','form_submit')),
  event_filter    text,
  sort_order      integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  -- A workflow can be bound to the same pipeline multiple times only if
  -- it listens to different events or different filters within an event.
  unique (pipeline_id, workflow_id, event, event_filter)
);

create index if not exists idx_pwb_pipeline
  on public.pipeline_workflow_bindings (pipeline_id, is_active);
create index if not exists idx_pwb_workflow
  on public.pipeline_workflow_bindings (workflow_id);
create index if not exists idx_pwb_event_lookup
  on public.pipeline_workflow_bindings (pipeline_id, event, is_active);

alter table public.pipeline_workflow_bindings enable row level security;

-- A binding inherits tenant scope from its parent pipeline. Use an EXISTS
-- predicate against pipelines so we don't have to redundantly store
-- tenant_id on every binding row (FK cascade handles deletion).
create policy pipeline_workflow_bindings_tenant on public.pipeline_workflow_bindings
  for all using (
    exists (
      select 1
      from public.pipelines p
      where p.id = pipeline_workflow_bindings.pipeline_id
        and auth.uid() in (
          select user_id from public.user_role_assignments
          where tenant_id = p.tenant_id and disabled_at is null
        )
    )
  );

-- ── pipeline_packs ───────────────────────────────────────────────────────
-- Curated marketplace of vertical packs. manifest_json is the
-- PackManifest TS interface (table schema + pipeline stages + workflow
-- blueprints + template drafts). Public-read to any authed user so the
-- marketplace gallery works for everyone; writes are service-role only
-- (no policy granted to authenticated for write).
create table if not exists public.pipeline_packs (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  description     text,
  vertical        text not null
                  check (vertical in ('real_estate','healthcare','coaching','education','d2c','hospitality','other')),
  is_curated      boolean not null default false,
  manifest_json   jsonb not null,
  install_count   integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_pipeline_packs_vertical
  on public.pipeline_packs (vertical, is_curated);

alter table public.pipeline_packs enable row level security;

-- Any authenticated user can list/read packs (gallery is shared across
-- tenants). install_count bumps happen via service-role from the install
-- handler — no INSERT/UPDATE policy for authed callers.
create policy pipeline_packs_read on public.pipeline_packs
  for select to authenticated using (true);

-- ── updated_at triggers (uses set_updated_at from migration 105) ─────────
drop trigger if exists trg_pipelines_updated_at on public.pipelines;
create trigger trg_pipelines_updated_at before update on public.pipelines
  for each row execute function public.set_updated_at();

drop trigger if exists trg_pipeline_packs_updated_at on public.pipeline_packs;
create trigger trg_pipeline_packs_updated_at before update on public.pipeline_packs
  for each row execute function public.set_updated_at();

-- ── Comments ─────────────────────────────────────────────────────────────
comment on table public.pipelines is
  'Installed pipeline bundles per tenant. Overlay over lead_tables + workflows that defines stages + bindings. Created via POST /api/pipeline-packs/:packId/install.';
comment on table public.pipeline_workflow_bindings is
  'Ties workflows to pipeline lifecycle events (row_created, row_updated_stage, inbound_text, scheduled, etc.). Read by the engine to route runtime events.';
comment on table public.pipeline_packs is
  'Curated marketplace of vertical packs. manifest_json is upserted on every BE boot from src/data/packs/*.ts. Public-read to authed users.';
