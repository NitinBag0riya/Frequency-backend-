-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 079 — Agency white-label dashboard (P1 #12)
--
-- BRIEF: Agencies in India (digital marketing, BPO outsourcers, CRM
-- resellers) onboard SMBs and want a single pane of glass over every
-- client. Four capabilities ship in this slice:
--
--   1. Multi-client switcher  — one user sees + switches between every
--                                sub-account they're a member of.
--   2. Agency RBAC            — agency_owner / agency_admin / agency_operator.
--   3. Revshare tracking      — 30% default, accrued on invoice.paid.
--                                Append-only ledger.
--   4. Sub-account billing    — toggle billing_owner ('agency' | 'tenant')
--                                per sub-account so the agency can absorb
--                                the bill or pass-through.
--
-- Vanity branding (CNAME, custom logos) is INTENTIONALLY OUT for this round
-- — keeps the cut tight + ships in one pass. Schema columns below leave
-- room for the next slice (status, razorpay_customer_id, default_revshare_pct
-- etc.) without a follow-on migration.
--
-- Five tables:
--   1. agencies              — top-level agency record (owner_user_id is the
--                              creator; agency_paid_by_default decides what
--                              billing_owner new sub-accounts default to).
--   2. agency_members        — (agency_id, user_id, role). Invite/accept
--                              workflow uses signed stateless tokens
--                              (HMAC) issued by the BE.
--   3. agency_sub_accounts   — (agency_id, tenant_id, billing_owner,
--                              revshare_pct_override). Unique on tenant_id
--                              so a tenant belongs to at most one agency.
--   4. agency_revshare_entries — append-only accrual ledger. UNIQUE
--                              (agency_id, tenant_id, period_start,
--                              period_end, invoice_id) for idempotency.
--                              authenticated REVOKE on update/delete.
--   5. agency_payouts        — monthly payout aggregates. authenticated
--                              REVOKE on update/delete.
--
-- RLS model:
--   agencies / members / sub_accounts → SELECT for is_agency_member(agency_id).
--   agencies UPDATE / sub_accounts INSERT,UPDATE,DELETE → owner/admin only.
--   revshare_entries / payouts → service-role only writes; agency members
--                                 SELECT for their agency.
--
-- Tenant-scoped tables (contacts, conversations, messages, broadcasts,
-- wa_templates) get an ADDITIONAL "agency members read" policy — they
-- inherit the existing per-tenant policies untouched and the new policy
-- ORs in agency-member read access.
--
-- Idempotent — safe to re-run. No `||` inside COMMENT ON (single string
-- literals only — PG rejects `'a' || 'b'` in those).
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. agencies ─────────────────────────────────────────────────────────────
create table if not exists public.agencies (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  slug                        text not null,
  owner_user_id               uuid not null references auth.users(id),
  default_revshare_pct        numeric(5,2) not null default 30 check (default_revshare_pct >= 0 and default_revshare_pct <= 100),
  agency_paid_by_default      boolean not null default true,
  status                      text not null default 'active' check (status in ('active','suspended','archived')),
  razorpay_customer_id        text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- Unique slug — agency URL space (/agency/:slug/...). Idempotent via DO block.
do $$ begin
  if not exists (
    select 1 from pg_indexes where schemaname='public' and indexname='ux_agencies_slug'
  ) then
    create unique index ux_agencies_slug on public.agencies(slug);
  end if;
end $$;

create index if not exists idx_agencies_owner on public.agencies(owner_user_id);

comment on table public.agencies is
  'Top-level agency record. owner_user_id is the seed user who created it; the agency_members table is the source of truth for membership + role. agency_paid_by_default decides what billing_owner new sub-accounts get on invite. default_revshare_pct is the percentage of paid invoices we accrue to the agency on invoice.paid; can be overridden per sub-account via agency_sub_accounts.revshare_pct_override.';

alter table public.agencies enable row level security;

-- ─── 2. agency_members ───────────────────────────────────────────────────────
create table if not exists public.agency_members (
  id            uuid primary key default gen_random_uuid(),
  agency_id     uuid not null references public.agencies(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null check (role in ('agency_owner','agency_admin','agency_operator')),
  invited_by    uuid references auth.users(id),
  invited_at    timestamptz not null default now(),
  accepted_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (agency_id, user_id)
);

create index if not exists idx_agency_members_user   on public.agency_members(user_id);
create index if not exists idx_agency_members_agency on public.agency_members(agency_id);

comment on table public.agency_members is
  'Agency RBAC. role is one of agency_owner (full control), agency_admin (manage members + sub-accounts, no agency delete), agency_operator (read-only across sub-accounts; cannot manage members or billing).';

alter table public.agency_members enable row level security;

-- ─── 3. agency_sub_accounts ──────────────────────────────────────────────────
create table if not exists public.agency_sub_accounts (
  id                       uuid primary key default gen_random_uuid(),
  agency_id                uuid not null references public.agencies(id) on delete cascade,
  tenant_id                uuid not null references public.tenants(id)  on delete cascade,
  billing_owner            text not null default 'agency' check (billing_owner in ('agency','tenant')),
  revshare_pct_override    numeric(5,2) check (revshare_pct_override is null or (revshare_pct_override >= 0 and revshare_pct_override <= 100)),
  added_by                 uuid references auth.users(id),
  added_at                 timestamptz not null default now(),
  removed_at               timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- A tenant belongs to at most one agency at a time. Re-add by setting
-- removed_at on the prior row + inserting a fresh row would violate this;
-- instead we soft-restore by clearing removed_at. To keep the constraint
-- simple, unique on tenant_id and the invite flow refuses to insert if a
-- row already exists — caller flips removed_at instead.
do $$ begin
  if not exists (
    select 1 from pg_indexes where schemaname='public' and indexname='ux_agency_sub_accounts_tenant'
  ) then
    create unique index ux_agency_sub_accounts_tenant on public.agency_sub_accounts(tenant_id);
  end if;
end $$;

create index if not exists idx_agency_sub_accounts_agency on public.agency_sub_accounts(agency_id);

comment on table public.agency_sub_accounts is
  'Maps a tenant to its agency. billing_owner toggles who pays Razorpay for the tenant (agency = bill-to the agency MoR; tenant = pass-through). revshare_pct_override is null by default; when set it overrides agencies.default_revshare_pct for this tenant only. removed_at soft-deletes — the FK is preserved so revshare ledger entries keep their target.';

alter table public.agency_sub_accounts enable row level security;

-- ─── 4. agency_revshare_entries ──────────────────────────────────────────────
create table if not exists public.agency_revshare_entries (
  id                          uuid primary key default gen_random_uuid(),
  agency_id                   uuid not null references public.agencies(id),
  tenant_id                   uuid not null references public.tenants(id),
  invoice_id                  text not null,
  period_start                timestamptz not null,
  period_end                  timestamptz not null,
  base_amount_inr_paise       bigint  not null check (base_amount_inr_paise >= 0),
  revshare_pct                numeric(5,2) not null check (revshare_pct >= 0 and revshare_pct <= 100),
  revshare_amount_inr_paise   bigint  not null check (revshare_amount_inr_paise >= 0),
  status                      text not null default 'accrued' check (status in ('accrued','paid','reversed')),
  paid_at                     timestamptz,
  notes                       text,
  created_at                  timestamptz not null default now()
);

-- Idempotency anchor: one accrual per (agency, tenant, period, invoice).
-- Razorpay sometimes double-fires invoice.paid on retries; the upsert
-- onConflict clause in the BE leans on this constraint.
do $$ begin
  if not exists (
    select 1 from pg_indexes where schemaname='public' and indexname='ux_agency_revshare_unique'
  ) then
    create unique index ux_agency_revshare_unique on public.agency_revshare_entries(agency_id, tenant_id, period_start, period_end, invoice_id);
  end if;
end $$;

create index if not exists idx_agency_revshare_agency_status on public.agency_revshare_entries(agency_id, status);
create index if not exists idx_agency_revshare_tenant        on public.agency_revshare_entries(tenant_id);

comment on table public.agency_revshare_entries is
  'Append-only accrual ledger. One row per (agency, tenant, period, invoice). authenticated has SELECT only — INSERT/UPDATE/DELETE go through the service role on invoice.paid. status flows accrued → paid (via payout) or accrued → reversed (refund). Never mutate; correct mistakes by inserting a reversed row.';

alter table public.agency_revshare_entries enable row level security;

-- Append-only at the GRANT level — even if RLS slipped, the role can't write.
revoke insert, update, delete on public.agency_revshare_entries from authenticated;

-- ─── 5. agency_payouts ───────────────────────────────────────────────────────
create table if not exists public.agency_payouts (
  id                  uuid primary key default gen_random_uuid(),
  agency_id           uuid not null references public.agencies(id),
  period_start        timestamptz not null,
  period_end          timestamptz not null,
  amount_inr_paise    bigint  not null check (amount_inr_paise >= 0),
  status              text not null default 'pending' check (status in ('pending','processing','paid','failed')),
  paid_at             timestamptz,
  razorpay_payout_id  text,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

do $$ begin
  if not exists (
    select 1 from pg_indexes where schemaname='public' and indexname='ux_agency_payouts_period'
  ) then
    create unique index ux_agency_payouts_period on public.agency_payouts(agency_id, period_start, period_end);
  end if;
end $$;

create index if not exists idx_agency_payouts_agency_status on public.agency_payouts(agency_id, status);

comment on table public.agency_payouts is
  'Monthly aggregate payouts. One row per (agency, period_start, period_end) — the aggregator worker upserts on conflict. status flows pending → processing → paid|failed. razorpay_payout_id set when we move to Razorpay payouts; null while pending.';

alter table public.agency_payouts enable row level security;

revoke insert, update, delete on public.agency_payouts from authenticated;

-- ─── Helper: is_agency_member ────────────────────────────────────────────────
-- SECURITY DEFINER so RLS policies can call it from authenticated context
-- without an infinite-recursion risk on agency_members's own policies.
-- search_path locked to public + pg_temp to defeat search-path hijack via
-- a temp-schema function.
create or replace function public.is_agency_member(_agency_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.agency_members am
    where am.agency_id = _agency_id
      and am.user_id   = auth.uid()
  );
$$;

revoke all on function public.is_agency_member(uuid) from public;
grant execute on function public.is_agency_member(uuid) to authenticated;

comment on function public.is_agency_member(uuid) is
  'Returns true when the calling auth.uid() is a member of the given agency. SECURITY DEFINER + locked search_path so RLS policies can call it without recursive policy evaluation.';

-- ─── RLS policies ────────────────────────────────────────────────────────────

-- agencies: members read; owner+admin update.
drop policy if exists "agencies_member_read"   on public.agencies;
create policy "agencies_member_read" on public.agencies
  for select to authenticated
  using ( public.is_agency_member(id) );

drop policy if exists "agencies_owner_update" on public.agencies;
create policy "agencies_owner_update" on public.agencies
  for update to authenticated
  using (
    exists (
      select 1 from public.agency_members am
      where am.agency_id = agencies.id
        and am.user_id   = auth.uid()
        and am.role in ('agency_owner','agency_admin')
    )
  )
  with check (
    exists (
      select 1 from public.agency_members am
      where am.agency_id = agencies.id
        and am.user_id   = auth.uid()
        and am.role in ('agency_owner','agency_admin')
    )
  );

-- INSERT/DELETE on agencies happen via service-role from POST /api/agencies.
-- We deliberately do NOT expose them to authenticated — keeps slug-uniqueness
-- + owner-seeding atomic and audited in one place.

-- agency_members: members read own agency; service-role writes.
drop policy if exists "agency_members_read" on public.agency_members;
create policy "agency_members_read" on public.agency_members
  for select to authenticated
  using ( public.is_agency_member(agency_id) );

-- agency_sub_accounts: members read; owner/admin manage.
drop policy if exists "agency_sub_accounts_read" on public.agency_sub_accounts;
create policy "agency_sub_accounts_read" on public.agency_sub_accounts
  for select to authenticated
  using ( public.is_agency_member(agency_id) );

drop policy if exists "agency_sub_accounts_admin_write" on public.agency_sub_accounts;
create policy "agency_sub_accounts_admin_write" on public.agency_sub_accounts
  for update to authenticated
  using (
    exists (
      select 1 from public.agency_members am
      where am.agency_id = agency_sub_accounts.agency_id
        and am.user_id   = auth.uid()
        and am.role in ('agency_owner','agency_admin')
    )
  )
  with check (
    exists (
      select 1 from public.agency_members am
      where am.agency_id = agency_sub_accounts.agency_id
        and am.user_id   = auth.uid()
        and am.role in ('agency_owner','agency_admin')
    )
  );

-- agency_revshare_entries: members SELECT only. Writes via service role only
-- (authenticated already REVOKE'd at GRANT level above; no INSERT/UPDATE/
-- DELETE policy needed — RLS denies by default when no policy matches).
drop policy if exists "agency_revshare_read" on public.agency_revshare_entries;
create policy "agency_revshare_read" on public.agency_revshare_entries
  for select to authenticated
  using ( public.is_agency_member(agency_id) );

-- agency_payouts: members SELECT only.
drop policy if exists "agency_payouts_read" on public.agency_payouts;
create policy "agency_payouts_read" on public.agency_payouts
  for select to authenticated
  using ( public.is_agency_member(agency_id) );

-- ─── Tenant-table cross-read policies (agency members read sub-accounts) ─────
-- Pattern: existing per-tenant policies are LEFT UNTOUCHED. We add a new
-- SELECT policy that ORs in agency-member access. Policies are additive in
-- Postgres: any matching policy grants — never removes — access.

drop policy if exists "agency_members_read_contacts" on public.contacts;
create policy "agency_members_read_contacts" on public.contacts
  for select to authenticated
  using (
    exists (
      select 1 from public.agency_sub_accounts asa
      join public.agency_members am on am.agency_id = asa.agency_id
      where asa.tenant_id = contacts.tenant_id
        and asa.removed_at is null
        and am.user_id = auth.uid()
    )
  );

-- Note: there is no standalone public.conversations table in this schema —
-- conversations are derived from public.messages grouped by (tenant_id,
-- contact_id, channel). The agency-member access policy below on messages
-- already covers conversation-view reads. If a future migration adds a
-- conversations table, add the parallel policy here.

drop policy if exists "agency_members_read_messages" on public.messages;
create policy "agency_members_read_messages" on public.messages
  for select to authenticated
  using (
    exists (
      select 1 from public.agency_sub_accounts asa
      join public.agency_members am on am.agency_id = asa.agency_id
      where asa.tenant_id = messages.tenant_id
        and asa.removed_at is null
        and am.user_id = auth.uid()
    )
  );

drop policy if exists "agency_members_read_broadcasts" on public.broadcasts;
create policy "agency_members_read_broadcasts" on public.broadcasts
  for select to authenticated
  using (
    exists (
      select 1 from public.agency_sub_accounts asa
      join public.agency_members am on am.agency_id = asa.agency_id
      where asa.tenant_id = broadcasts.tenant_id
        and asa.removed_at is null
        and am.user_id = auth.uid()
    )
  );

drop policy if exists "agency_members_read_wa_templates" on public.wa_templates;
create policy "agency_members_read_wa_templates" on public.wa_templates
  for select to authenticated
  using (
    exists (
      select 1 from public.agency_sub_accounts asa
      join public.agency_members am on am.agency_id = asa.agency_id
      where asa.tenant_id = wa_templates.tenant_id
        and asa.removed_at is null
        and am.user_id = auth.uid()
    )
  );

-- ─── End of migration 079 ────────────────────────────────────────────────────
