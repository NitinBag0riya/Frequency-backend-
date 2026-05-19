-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 087 — Sales CRM Lite (P2 #22).
--
-- BRIEF: "pipeline view tied to conversations". A lightweight Kanban-style
-- pipeline where each card represents a deal/opportunity linked to a contact
-- (and through the contact, their conversation thread).
--
-- This is intentionally NOT a full CRM. We model just what a small Indian SMB
-- needs to track sales conversations:
--   1. crm_stages       — tenant-customisable pipeline columns (Lead, Qualified
--                         …, Won, Lost). Probability % per stage drives a
--                         weighted pipeline-value summary on the FE.
--   2. crm_deals        — the cards. Always linked to a contact (so opening
--                         a deal can deep-link to the inbox conversation for
--                         that contact). Value stored in INR paise (no
--                         multi-currency in Lite).
--   3. crm_deal_events  — append-only audit (created, stage_changed,
--                         value_changed, owner_changed, note_added, won, lost,
--                         reopened). Tenant-readable, but inserts only via
--                         service role (route handler) so we keep a single
--                         source of truth on event semantics.
--
-- Tenant-scoped RLS on all three tables, using the standard membership clause
-- (user_role_assignments ∪ user_roles ∪ tenants.user_id) we use across the
-- product.
--
-- Idempotent. Apply via `supabase db push`. No `||` in COMMENT ON anywhere
-- (concat in COMMENT ON has bitten us before — Postgres parses the `||` as
-- end-of-comment-text and chokes on the rest of the file).
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. crm_stages — tenant-customisable pipeline columns ────────────────────
-- Each tenant defines its own pipeline stages. We seed defaults on first
-- access from the BE (not from this migration — seeding here would require
-- enumerating every tenant_id, and new tenants created after the migration
-- would still need lazy seeding anyway, so we centralise that logic).
--
-- `position` is the sort key — lower comes first. Standard pattern: 10, 20, 30
-- so the user can insert between without renumbering everything.
--
-- `probability_pct` (0–100) drives the weighted pipeline-value summary
-- (value × prob / 100). Terminal stages (is_won / is_lost) are excluded
-- from active pipeline value entirely — those deals are counted in won/lost
-- buckets instead.
create table if not exists public.crm_stages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null check (length(name) between 1 and 60),
  position        int  not null default 0,
  probability_pct numeric(5,2) not null default 0
    check (probability_pct >= 0 and probability_pct <= 100),
  -- Terminal-stage flags. We model these as booleans on the row (rather than
  -- a separate stage_type enum or a stages_won child table) because there
  -- can be multiple won/lost stages per tenant in practice — e.g. "Won —
  -- One-time" vs "Won — Subscription" — and a flag-per-row is the flattest
  -- way to express that.
  is_won          boolean not null default false,
  is_lost         boolean not null default false,
  color_hex       text not null default '#94A3B8'
    check (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, name)
);

create index if not exists idx_crm_stages_tenant_pos
  on public.crm_stages(tenant_id, position);

alter table public.crm_stages enable row level security;

drop policy if exists "crm_stages_tenant_rw" on public.crm_stages;
create policy "crm_stages_tenant_rw" on public.crm_stages for all to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
      union
      select id from public.tenants where user_id = auth.uid()
    )
  )
  with check (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
      union
      select id from public.tenants where user_id = auth.uid()
    )
  );

-- ─── 2. crm_deals — the cards on the Kanban ──────────────────────────────────
-- A deal is an opportunity to win revenue from a contact. The contact link
-- is REQUIRED so deals are always tied to a real person — that's the
-- "tied to conversations" part of the brief: opening a deal opens the
-- conversation history for that contact in a side panel.
--
-- `stage_entered_at` is denormalised on the row (rather than computed from
-- the latest stage_changed event) so the time-in-stage display on each
-- card is a single-table lookup. We update it in the route handler whenever
-- stage_id changes.
--
-- `value_inr_paise` is INR paise (bigint, not numeric — multi-currency is
-- explicitly P3). 1 INR = 100 paise.
create table if not exists public.crm_deals (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  contact_id          uuid not null references public.contacts(id) on delete cascade,
  stage_id            uuid not null references public.crm_stages(id) on delete restrict,
  title               text not null check (length(title) between 2 and 200),
  value_inr_paise     bigint not null default 0 check (value_inr_paise >= 0),
  owner_user_id       uuid references auth.users(id) on delete set null,
  expected_close_date date,
  notes               text,
  stage_entered_at    timestamptz not null default now(),
  closed_at           timestamptz,
  closed_reason       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_crm_deals_tenant_stage
  on public.crm_deals(tenant_id, stage_id);
create index if not exists idx_crm_deals_contact
  on public.crm_deals(contact_id);
create index if not exists idx_crm_deals_owner
  on public.crm_deals(owner_user_id);

alter table public.crm_deals enable row level security;

drop policy if exists "crm_deals_tenant_rw" on public.crm_deals;
create policy "crm_deals_tenant_rw" on public.crm_deals for all to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
      union
      select id from public.tenants where user_id = auth.uid()
    )
  )
  with check (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
      union
      select id from public.tenants where user_id = auth.uid()
    )
  );

-- ─── 3. crm_deal_events — append-only audit ──────────────────────────────────
-- One row per (deal, event_type, actor, occurred_at). The route handler
-- inserts via the service role; authenticated/anon have only SELECT.
--
-- We keep both from_stage_id and to_stage_id nullable because most event
-- types (note_added, value_changed, owner_changed) don't involve a stage
-- transition — only stage_changed / won / lost / reopened populate them.
create table if not exists public.crm_deal_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  deal_id         uuid not null references public.crm_deals(id) on delete cascade,
  event_type      text not null check (event_type in (
    'created',
    'stage_changed',
    'value_changed',
    'owner_changed',
    'note_added',
    'won',
    'lost',
    'reopened'
  )),
  from_stage_id   uuid references public.crm_stages(id),
  to_stage_id     uuid references public.crm_stages(id),
  actor_user_id   uuid references auth.users(id) on delete set null,
  payload         jsonb not null default '{}'::jsonb,
  occurred_at     timestamptz not null default now()
);

create index if not exists idx_crm_deal_events_deal
  on public.crm_deal_events(deal_id, occurred_at desc);
create index if not exists idx_crm_deal_events_tenant_occurred
  on public.crm_deal_events(tenant_id, occurred_at desc);

alter table public.crm_deal_events enable row level security;

drop policy if exists "crm_deal_events_tenant_read" on public.crm_deal_events;
create policy "crm_deal_events_tenant_read" on public.crm_deal_events for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
      union
      select id from public.tenants where user_id = auth.uid()
    )
  );

-- Append-only. All inserts come from the BE route handler via the service
-- role; we lock client-role writes so a tenant can never forge or rewrite
-- their own audit trail.
revoke insert, update, delete on public.crm_deal_events from authenticated;
revoke insert, update, delete on public.crm_deal_events from anon;

-- ─── updated_at triggers ─────────────────────────────────────────────────────
-- Keep updated_at fresh on row updates so the FE can sort by recency without
-- relying on the BE to remember to set it on every PATCH.
create or replace function public.crm_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_crm_stages_touch on public.crm_stages;
create trigger trg_crm_stages_touch
  before update on public.crm_stages
  for each row execute function public.crm_touch_updated_at();

drop trigger if exists trg_crm_deals_touch on public.crm_deals;
create trigger trg_crm_deals_touch
  before update on public.crm_deals
  for each row execute function public.crm_touch_updated_at();
