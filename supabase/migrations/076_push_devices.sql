-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 076 — Mobile push device tokens (P0.10).
--
-- BRIEF: Persist Expo push tokens posted by the mobile app on sign-in so
-- the BE can target this user's installed devices for inbox / broadcast /
-- system notifications. Mobile already POSTs `/api/devices/register`
-- fire-and-forget — until now that token was dropped on the floor.
--
-- Contract (matches mobile/src/lib/push.ts → devicesApi.register):
--   { expo_push_token: 'ExponentPushToken[…]', platform: 'ios'|'android',
--     app_version: '1.0.0' }
--
-- One row per (user_id, expo_push_token). Re-registering on app start
-- upserts `last_seen_at` so the worker can prune stale tokens later.
--
-- RLS: a user can ONLY see/manage their own device rows. tenant_id is
-- stamped at register-time so cross-tenant analytics can still aggregate
-- without breaking the per-user isolation.
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.push_devices (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  user_id         uuid not null references auth.users(id)     on delete cascade,
  expo_push_token text not null,
  platform        text not null check (platform in ('ios', 'android', 'web')),
  app_version     text,
  device_label    text,
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  -- One row per (user, token). Re-registration upserts last_seen_at.
  -- (user_id, not tenant_id, because the same physical device only ever
  -- belongs to one human — but that human might switch tenants and we
  -- still want the same token row.)
  unique (user_id, expo_push_token)
);

create index if not exists idx_push_devices_user
  on public.push_devices(user_id);

create index if not exists idx_push_devices_tenant
  on public.push_devices(tenant_id);

comment on table public.push_devices is
  'Expo push tokens registered by the mobile app. One row per (user, token); re-registration upserts last_seen_at. Used by sendExpoPush() to fan out inbox / broadcast / system notifications to a user''s installed devices.';

-- ─── RLS — a user can only see / write their own device rows ─────────────────
alter table public.push_devices enable row level security;

drop policy if exists push_devices_self_read   on public.push_devices;
drop policy if exists push_devices_self_insert on public.push_devices;
drop policy if exists push_devices_self_update on public.push_devices;
drop policy if exists push_devices_self_delete on public.push_devices;

create policy push_devices_self_read on public.push_devices
  for select to authenticated
  using (user_id = auth.uid());

create policy push_devices_self_insert on public.push_devices
  for insert to authenticated
  with check (user_id = auth.uid());

create policy push_devices_self_update on public.push_devices
  for update to authenticated
  using      (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy push_devices_self_delete on public.push_devices
  for delete to authenticated
  using (user_id = auth.uid());
