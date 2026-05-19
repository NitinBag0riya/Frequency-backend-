-- 075_breach_fanout.sql — DPDPA §8(6) breach notification fan-out plumbing.
--
-- P0.7 shipped the audit-trail half: breach_notifications + the super-admin
-- UI to record incidents and flip notified_authority_at / notified_users_at
-- flags. The email fan-out itself was stubbed (the route just stamped a
-- timestamp and the operator emailed people out-of-band).
--
-- This migration finishes it. We add:
--   1. Append-only per-recipient send log (breach_notification_recipients).
--      One row per (breach, recipient_email) — idempotent upserts so retries
--      and re-PATCHes never double-send.
--   2. tenants.data_fiduciary_{email,name} — the DPDPA-required Data
--      Fiduciary contact on each tenant. Surfaced in PrivacyCenterPage.
--   3. breach_notifications.{scope, affected_tenant_ids, fanout_queued_at,
--      notification_template} — drives the worker:
--        scope='platform'  → email every tenant's owner + DF contact
--        scope='subset'    → email only listed tenants
--      fanout_queued_at is the idempotency guard — set when the PATCH
--      handler enqueues the BullMQ job, checked to skip re-enqueues.
--
-- RLS posture: tenants read their own recipient rows; super-admin (platform
-- scope via user_role_assignments) reads all. UPDATE/DELETE for authenticated
-- is REVOKED — the worker writes via service-role, which bypasses RLS.

-- ─── 1. tenants — Data Fiduciary contact ─────────────────────────────────
-- The DPDPA §10 "Data Protection Officer / Data Fiduciary contact". Plain
-- text email + display name. Optional today; the worker falls back to
-- tenants.user_id's owner email if unset. Tenant settings UI exposes it.
alter table public.tenants
  add column if not exists data_fiduciary_email text,
  add column if not exists data_fiduciary_name  text;

comment on column public.tenants.data_fiduciary_email is
  'DPDPA §10 Data Fiduciary / DPO email contact. Used by the breach fan-out worker as a notification recipient alongside the tenant owner.';

-- ─── 2. breach_notifications — fan-out columns ───────────────────────────
-- scope: 'platform' = every tenant (and we ignore affected_tenant_ids);
--         'subset'  = only tenants listed in affected_tenant_ids.
-- affected_tenant_ids: jsonb array of tenant uuids. Use jsonb (not uuid[])
--   to match the codebase convention (affected_data_classes is jsonb too).
-- notification_template: optional handlebars-ish override. Worker falls
--   back to a built-in factual template when null.
-- fanout_queued_at: idempotency stamp. Set by the PATCH handler the moment
--   it enqueues the BullMQ job; checked on re-PATCH to skip duplicates.
alter table public.breach_notifications
  add column if not exists scope                 text not null default 'subset'
    check (scope in ('platform','subset')),
  add column if not exists affected_tenant_ids   jsonb not null default '[]'::jsonb,
  add column if not exists notification_template text,
  add column if not exists fanout_queued_at      timestamptz;

comment on column public.breach_notifications.scope is
  'platform = email every tenant''s owner+DF contact; subset = only tenants listed in affected_tenant_ids. tenant_id (legacy) is preserved for the single-tenant common case.';
comment on column public.breach_notifications.fanout_queued_at is
  'Idempotency guard for the BullMQ fan-out job. Set when the PATCH handler enqueues; checked to skip re-enqueue on repeat PATCH.';

-- ─── 3. breach_notification_recipients — per-send audit ─────────────────
-- Append-only. One row per (breach, recipient_email). Worker upserts on
-- the unique constraint so a re-run of the same job never produces
-- duplicate rows or duplicate sends.
create table if not exists public.breach_notification_recipients (
  id                 uuid primary key default gen_random_uuid(),
  breach_id          uuid not null references public.breach_notifications(id) on delete cascade,
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  recipient_email    text not null,
  recipient_name     text,
  recipient_role     text not null check (recipient_role in ('owner','data_fiduciary','admin')),
  send_status        text not null default 'queued'
    check (send_status in ('queued','sent','failed','bounced')),
  resend_message_id  text,
  error              text,
  queued_at          timestamptz not null default now(),
  sent_at            timestamptz,
  failed_at          timestamptz,
  unique (breach_id, recipient_email)
);

create index if not exists idx_bnr_breach
  on public.breach_notification_recipients (breach_id);
create index if not exists idx_bnr_tenant
  on public.breach_notification_recipients (tenant_id);
create index if not exists idx_bnr_queued
  on public.breach_notification_recipients (send_status)
  where send_status = 'queued';

comment on table public.breach_notification_recipients is
  'Append-only per-recipient send log for DPDPA breach notifications. UPDATE/DELETE revoked from authenticated — only the worker (service-role) mutates send_status. Unique (breach_id, recipient_email) makes upserts idempotent.';

-- ─── 4. RLS — breach_notification_recipients ─────────────────────────────
alter table public.breach_notification_recipients enable row level security;

-- SELECT: tenant members read their own tenant's recipient rows.
-- Super-admin reads everything via the platform-scope policy below.
drop policy if exists "tenant members read breach_notification_recipients"
  on public.breach_notification_recipients;
create policy "tenant members read breach_notification_recipients"
  on public.breach_notification_recipients
  for select using (
    exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid()
        and tenant_id = breach_notification_recipients.tenant_id
    )
    or exists (
      select 1 from public.user_roles
      where user_id = auth.uid()
        and tenant_id = breach_notification_recipients.tenant_id
    )
    or exists (
      select 1 from public.tenants
      where id = breach_notification_recipients.tenant_id
        and user_id = auth.uid()
    )
  );

-- SELECT (super-admin): anyone with a platform-scope role assignment reads
-- everything. Same pattern as the existing super-admin policy on
-- breach_notifications.
drop policy if exists "super admin read breach_notification_recipients"
  on public.breach_notification_recipients;
create policy "super admin read breach_notification_recipients"
  on public.breach_notification_recipients
  for select using (
    exists (
      select 1
      from public.user_role_assignments ura
      join public.role_definitions rd on rd.id = ura.role_id
      where ura.user_id = auth.uid()
        and ura.tenant_id is null
        and rd.scope = 'platform'
    )
  );

-- No INSERT / UPDATE / DELETE policy for authenticated. The worker mutates
-- via service-role, which bypasses RLS. Defense-in-depth: explicitly revoke
-- write privileges on the table from the authenticated role so even if
-- someone forgot RLS, table-level perms still block writes.
revoke insert, update, delete on public.breach_notification_recipients from authenticated;
revoke insert, update, delete on public.breach_notification_recipients from anon;

-- ─── 5. Verify ──────────────────────────────────────────────────────────
-- \d+ public.breach_notification_recipients
-- select policyname from pg_policies where tablename = 'breach_notification_recipients';
-- select column_name from information_schema.columns where table_name = 'breach_notifications' and column_name in ('scope','affected_tenant_ids','fanout_queued_at','notification_template');
-- select column_name from information_schema.columns where table_name = 'tenants' and column_name in ('data_fiduciary_email','data_fiduciary_name');
