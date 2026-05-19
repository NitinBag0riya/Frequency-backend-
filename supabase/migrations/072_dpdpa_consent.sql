-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 072 — DPDPA-ready consent layer.
--
-- BRIEF (Indian SMB Omnichannel Wedge, P0.7): Indian SMBs sell the
-- WhatsApp/Instagram/Telegram suite into legal-sensitive segments
-- (finance, edtech, healthtech). Their compliance team always asks the
-- same 4 questions before signing:
--
--   1. "Can I PROVE the contact opted in?"        → consent_events
--   2. "Can I delete a contact and prove it?"     → dsr_requests
--   3. "What happens if there's a breach?"        → breach_notifications
--   4. "Is my data stored in India?"              → tenants.data_residency
--
-- One additive migration that wires all four. No existing tables are
-- restructured (contacts.consent_captured_at remains the hot-path mirror
-- from 068; consent_events is the full evidentiary trail).
--
-- All four tables have RLS. consent_events + dsr_requests are tenant-scoped
-- read/write (modulo no DELETE on dsr_requests — audit trail). Tenant scope
-- via user_role_assignments + role_definitions + legacy user_roles + the
-- tenants.user_id ownership fallback (matches the pattern used everywhere
-- else in this codebase — e.g. 070, 071). breach_notifications is
-- super-admin write per the public_incidents pattern in 067.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. consent_events — full append-only history ────────────────────────
-- Every consent state change writes one row. The AFTER INSERT trigger then
-- materializes the latest (contact, channel, purpose) state to
-- contact_consent_state for hot-path reads (sender gates, contact-list
-- badges).
create table if not exists public.consent_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  -- contact_id is nullable so a landing-page form can capture consent BEFORE
  -- we've upserted a contact row. The audit row stands on its own evidentially
  -- (proof_text + source_detail tell the story).
  contact_id      uuid references public.contacts(id) on delete cascade,
  channel         text not null check (channel in ('whatsapp','instagram','telegram','email','sms','all')),
  event_type      text not null check (event_type in (
    'opt_in',           -- explicit affirmative consent
    'opt_out',          -- contact revoked
    'reaffirm',         -- contact re-confirmed (e.g. after policy change)
    'transfer',         -- consent transferred (e.g. merging contacts)
    'expired'           -- system-marked expiration (per DPDPA stale-consent rule)
  )),
  purpose         text not null,           -- 'transactional' | 'marketing' | 'service_updates' | 'all'
  source          text not null,           -- 'manual_add' | 'web_form' | 'qr_scan' | 'imported' | 'api' | 'whatsapp_inbound' | 'instagram_inbound' | 'telegram_inbound' | 'dsr_erasure' | 'expiry_sweep'
  source_detail   jsonb not null default '{}'::jsonb,  -- {form_id, ip_hashed, user_agent_class, ...}
  proof_text      text,                    -- exact checkbox label / inbound first message — this is the evidentiary string
  captured_by     uuid references auth.users(id) on delete set null,
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists idx_consent_events_contact
  on public.consent_events (contact_id, occurred_at desc);
create index if not exists idx_consent_events_tenant
  on public.consent_events (tenant_id, occurred_at desc);

comment on table public.consent_events is
  'DPDPA evidentiary log of every consent state change. Append-only; UPDATE+DELETE prohibited via RLS for tenant users. The denormalized current state lives in contact_consent_state, maintained by trigger.';

-- ─── 2. contact_consent_state — current per-(contact,channel,purpose) ────
-- One row per (contact_id, channel, purpose). Maintained ONLY by the
-- trigger below; tenant users cannot UPDATE this table directly (RLS).
create table if not exists public.contact_consent_state (
  contact_id      uuid not null references public.contacts(id) on delete cascade,
  channel         text not null,
  purpose         text not null,
  status          text not null check (status in ('opted_in','opted_out','expired','never_set')),
  effective_at    timestamptz not null,
  last_event_id   uuid references public.consent_events(id) on delete set null,
  primary key (contact_id, channel, purpose)
);

create index if not exists idx_contact_consent_state_status
  on public.contact_consent_state (contact_id, status);

comment on table public.contact_consent_state is
  'Materialized current consent per (contact, channel, purpose). Updated by trg_consent_event_materialize_state after every consent_events insert.';

-- Trigger function — derive new status from event_type, upsert state row.
create or replace function public.tg_consent_event_materialize_state()
returns trigger
language plpgsql
as $$
declare
  new_status text;
  existing_status text;
begin
  -- Pre-contact consent (e.g. landing-page form) has no contact_id —
  -- nothing to materialize, the audit row stands alone.
  if new.contact_id is null then
    return new;
  end if;

  if new.event_type = 'opt_in' then
    new_status := 'opted_in';
  elsif new.event_type = 'reaffirm' then
    new_status := 'opted_in';
  elsif new.event_type = 'opt_out' then
    new_status := 'opted_out';
  elsif new.event_type = 'expired' then
    new_status := 'expired';
  elsif new.event_type = 'transfer' then
    -- Carry forward existing status if present, else default to opted_in
    -- (a transfer event without a prior state is treated as a fresh opt-in
    -- because the merge source must itself have been opted in to be merged).
    select status into existing_status
      from public.contact_consent_state
      where contact_id = new.contact_id
        and channel = new.channel
        and purpose = new.purpose;
    new_status := coalesce(existing_status, 'opted_in');
  else
    return new;  -- unknown event_type — leave state untouched
  end if;

  insert into public.contact_consent_state
    (contact_id, channel, purpose, status, effective_at, last_event_id)
  values
    (new.contact_id, new.channel, new.purpose, new_status, new.occurred_at, new.id)
  on conflict (contact_id, channel, purpose) do update
    set status        = excluded.status,
        effective_at  = excluded.effective_at,
        last_event_id = excluded.last_event_id;

  return new;
end;
$$;

drop trigger if exists trg_consent_event_materialize_state on public.consent_events;
create trigger trg_consent_event_materialize_state
  after insert on public.consent_events
  for each row execute function public.tg_consent_event_materialize_state();

-- ─── 3. dsr_requests — Data Subject Rights workflow ──────────────────────
-- One row per DSR request (access, erasure, rectification, portability).
-- Cannot be deleted by tenant users — audit trail required.
create table if not exists public.dsr_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  -- contact_id nullable: DSR may be raised by email/phone before we know
  -- which contact row the requester maps to.
  contact_id      uuid references public.contacts(id) on delete set null,
  request_type    text not null check (request_type in ('access','erasure','rectification','portability')),
  requester_email text not null,
  requester_proof text,                    -- e.g. WhatsApp OTP token id, signed challenge
  status          text not null default 'pending' check (status in ('pending','verifying','in_progress','completed','rejected')),
  verified_at     timestamptz,
  completed_at    timestamptz,
  executed_by     uuid references auth.users(id) on delete set null,
  notes           text,
  payload         jsonb,                   -- export blob for access/portability; receipt for erasure
  reason          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_dsr_requests_tenant
  on public.dsr_requests (tenant_id, created_at desc);
create index if not exists idx_dsr_requests_contact
  on public.dsr_requests (contact_id)
  where contact_id is not null;
create index if not exists idx_dsr_requests_status
  on public.dsr_requests (tenant_id, status);

comment on table public.dsr_requests is
  'DPDPA §11–14 Data Subject Rights tracker. DELETE is blocked via RLS — these rows are the audit trail of erasure receipts.';

-- ─── 4. breach_notifications — DPDPA §8(6) breach reporting ──────────────
-- Super-admin authored; tenant-scoped read so an affected tenant can see
-- "your tenant was affected by this breach". A null tenant_id = platform-
-- wide breach (read by everyone via the platform-scope tenant memberships).
create table if not exists public.breach_notifications (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid references public.tenants(id) on delete cascade,  -- nullable = platform-wide
  severity                text not null check (severity in ('low','medium','high','critical')),
  discovered_at           timestamptz not null default now(),
  description             text not null,
  affected_contact_count  bigint not null default 0,
  affected_data_classes   jsonb not null default '[]'::jsonb,  -- ['phone','email','message_content', ...]
  notified_authority_at   timestamptz,                          -- DPDPA Board notification
  notified_users_at       timestamptz,                          -- mass user email
  created_by              uuid references auth.users(id) on delete set null,
  status                  text not null default 'investigating' check (status in ('investigating','notified','resolved')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists idx_breach_notifications_tenant
  on public.breach_notifications (tenant_id, discovered_at desc);
create index if not exists idx_breach_notifications_status
  on public.breach_notifications (status, discovered_at desc);

comment on table public.breach_notifications is
  'Platform-authored breach log per DPDPA §8(6). tenant_id NULL = platform-wide breach (every tenant can read). INSERT/UPDATE restricted to super-admin (pattern from migration 067).';

-- ─── 5. tenants.data_residency ───────────────────────────────────────────
-- Metadata flag — we are not multi-region today, but tenants ask "is my
-- data stored in India?" before signing. Adding the column now lets us
-- expose an honest "Data stored in Mumbai (ap-south-1)" badge today and
-- migrate per-tenant on request later without a second schema change.
alter table public.tenants
  add column if not exists data_residency text not null default 'IN'
    check (data_residency in ('IN','EU','US'));

comment on column public.tenants.data_residency is
  'DPDPA-readiness flag. IN=Mumbai (ap-south-1, default for new tenants), EU=Frankfurt, US=us-east-1. Today this is metadata only — existing data is in the default region. Migration to other regions available on request.';

-- ─── 6. updated_at maintenance ───────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'tg_set_updated_at') then
    create function public.tg_set_updated_at() returns trigger as $fn$
    begin
      new.updated_at = now();
      return new;
    end;
    $fn$ language plpgsql;
  end if;
end$$;

drop trigger if exists dsr_requests_set_updated_at on public.dsr_requests;
create trigger dsr_requests_set_updated_at
  before update on public.dsr_requests
  for each row execute function public.tg_set_updated_at();

drop trigger if exists breach_notifications_set_updated_at on public.breach_notifications;
create trigger breach_notifications_set_updated_at
  before update on public.breach_notifications
  for each row execute function public.tg_set_updated_at();

-- ─── 7. RLS — consent_events ─────────────────────────────────────────────
alter table public.consent_events enable row level security;

-- SELECT: tenant members read all consent events for their tenant.
drop policy if exists "tenant members read consent_events" on public.consent_events;
create policy "tenant members read consent_events" on public.consent_events
  for select using (
    exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid() and tenant_id = consent_events.tenant_id
    )
    or exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and tenant_id = consent_events.tenant_id
    )
    or exists (
      select 1 from public.tenants where id = consent_events.tenant_id and user_id = auth.uid()
    )
  );

-- INSERT: any tenant member. The server-side handler enforces business rules
-- (e.g. which event_type for which source); defense-in-depth keeps inserts
-- inside the tenant boundary.
drop policy if exists "tenant members insert consent_events" on public.consent_events;
create policy "tenant members insert consent_events" on public.consent_events
  for insert with check (
    exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid() and tenant_id = consent_events.tenant_id
    )
    or exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and tenant_id = consent_events.tenant_id
    )
    or exists (
      select 1 from public.tenants where id = consent_events.tenant_id and user_id = auth.uid()
    )
  );

-- No UPDATE policy — consent_events is append-only.
-- No DELETE policy — same.

-- ─── 8. RLS — contact_consent_state ──────────────────────────────────────
alter table public.contact_consent_state enable row level security;

-- SELECT: tenant members read state for contacts in their tenant.
-- We join through contacts (no tenant_id on the state table — it's keyed
-- by contact_id which already FKs to a tenant-scoped row).
drop policy if exists "tenant members read contact_consent_state" on public.contact_consent_state;
create policy "tenant members read contact_consent_state" on public.contact_consent_state
  for select using (
    exists (
      select 1 from public.contacts c
      where c.id = contact_consent_state.contact_id
        and (
          exists (
            select 1 from public.user_role_assignments
            where user_id = auth.uid() and tenant_id = c.tenant_id
          )
          or exists (
            select 1 from public.user_roles
            where user_id = auth.uid() and tenant_id = c.tenant_id
          )
          or exists (
            select 1 from public.tenants where id = c.tenant_id and user_id = auth.uid()
          )
        )
    )
  );

-- No INSERT/UPDATE/DELETE policy for authenticated users — the trigger
-- (running with table-owner privileges) maintains rows. The service role
-- bypasses RLS so server-side reads/writes work without policy bloat.

-- ─── 9. RLS — dsr_requests ───────────────────────────────────────────────
alter table public.dsr_requests enable row level security;

drop policy if exists "tenant members read dsr_requests" on public.dsr_requests;
create policy "tenant members read dsr_requests" on public.dsr_requests
  for select using (
    exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid() and tenant_id = dsr_requests.tenant_id
    )
    or exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and tenant_id = dsr_requests.tenant_id
    )
    or exists (
      select 1 from public.tenants where id = dsr_requests.tenant_id and user_id = auth.uid()
    )
  );

-- INSERT — any tenant member can file a DSR (the API itself gates on role).
drop policy if exists "tenant members insert dsr_requests" on public.dsr_requests;
create policy "tenant members insert dsr_requests" on public.dsr_requests
  for insert with check (
    exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid() and tenant_id = dsr_requests.tenant_id
    )
    or exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and tenant_id = dsr_requests.tenant_id
    )
    or exists (
      select 1 from public.tenants where id = dsr_requests.tenant_id and user_id = auth.uid()
    )
  );

-- UPDATE — tenant admins only (owner / workspace_admin / platform_owner).
-- The route layer enforces this too; defense in depth.
drop policy if exists "tenant admins update dsr_requests" on public.dsr_requests;
create policy "tenant admins update dsr_requests" on public.dsr_requests
  for update using (
    exists (
      select 1
      from public.user_role_assignments a
      join public.role_definitions     r on r.id = a.role_id
      where a.user_id  = auth.uid()
        and a.tenant_id = dsr_requests.tenant_id
        and r.key in ('owner', 'workspace_admin', 'platform_owner')
    )
    or exists (
      select 1 from public.tenants where id = dsr_requests.tenant_id and user_id = auth.uid()
    )
  );

-- No DELETE — audit trail required.

-- ─── 10. RLS — breach_notifications ──────────────────────────────────────
alter table public.breach_notifications enable row level security;

-- SELECT — tenants read rows for their own tenant OR rows with NULL
-- tenant_id (platform-wide breaches affect everyone).
drop policy if exists "tenant members read breach_notifications" on public.breach_notifications;
create policy "tenant members read breach_notifications" on public.breach_notifications
  for select using (
    breach_notifications.tenant_id is null
    or exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid() and tenant_id = breach_notifications.tenant_id
    )
    or exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and tenant_id = breach_notifications.tenant_id
    )
    or exists (
      select 1 from public.tenants where id = breach_notifications.tenant_id and user_id = auth.uid()
    )
  );

-- INSERT/UPDATE/DELETE — super-admin only (platform-scope assignment or
-- legacy super_admin role). Same pattern as public_incidents (067).
drop policy if exists "super admin write breach_notifications" on public.breach_notifications;
create policy "super admin write breach_notifications" on public.breach_notifications
  for all
  to authenticated
  using (
    exists (
      select 1 from public.user_role_assignments ura
      join public.role_definitions rd on rd.id = ura.role_id
      where ura.user_id = auth.uid()
        and ura.tenant_id is null
        and rd.scope = 'platform'
    )
    or exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.tenant_id is null
        and ur.role     = 'super_admin'
    )
  )
  with check (
    exists (
      select 1 from public.user_role_assignments ura
      join public.role_definitions rd on rd.id = ura.role_id
      where ura.user_id = auth.uid()
        and ura.tenant_id is null
        and rd.scope = 'platform'
    )
    or exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.tenant_id is null
        and ur.role     = 'super_admin'
    )
  );

-- ─── 11. messages.blocked_reason — consent-block telemetry ───────────────
-- The message-sender worker writes 'No marketing consent on file (DPDPA)'
-- here when a marketing template is blocked. Free-text so adjacent reasons
-- (no_template_approved, recipient_opted_out, etc.) can use the same column.
alter table public.messages
  add column if not exists blocked_reason text;

comment on column public.messages.blocked_reason is
  'When a send is short-circuited before hitting the channel API, the reason is recorded here so the inbox + analytics can surface "blocked: no consent" instead of silently dropping the row. Pairs with status=''blocked_no_consent'' or similar.';

-- ─── Sanity check (run after migration) ──────────────────────────────────
-- \d+ public.consent_events
-- \d+ public.contact_consent_state
-- \d+ public.dsr_requests
-- \d+ public.breach_notifications
-- select column_name from information_schema.columns
--   where table_name='tenants' and column_name='data_residency';
-- select column_name from information_schema.columns
--   where table_name='messages' and column_name='blocked_reason';
-- select tgname from pg_trigger where tgname='trg_consent_event_materialize_state';
