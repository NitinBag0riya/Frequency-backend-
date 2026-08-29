-- Tenant-scoped snapshot of aggregator session cookies (encrypted at rest).
--
-- Motivation: Zomato's X-Zomato-Mx-Auth-Token is a SESSION cookie (no expires)
-- so Chromium keeps it in RAM only. Frequency Desktop already persists it to
-- disk between restarts (see sessionCookieSnapshot.ts), but ONE-DEVICE only.
-- This table backs the snapshot up per-TENANT so:
--   1. Any new Frequency Desktop install by the same merchant restores
--      instantly — no re-login.
--   2. Server-side workers (Naruto ops, cron backfills, aggregator reads/writes
--      when the desktop isn't running) can use the merchant's live session
--      cookies directly.
--
-- Security: `snapshot_encrypted` is AES-256-GCM ciphertext with an app-layer
-- key stored in the FE/BE env (not in Supabase). A DB leak alone does NOT
-- expose the cookies. Rotate the app key + re-encrypt existing rows on
-- rotation; readers detect stale key_version and force a fresh upload from
-- the merchant's current install.
--
-- RLS: writable by the tenant's own service (via merchant JWT), readable by
-- the tenant + platform ops. Never by another tenant.
create table if not exists public.tenant_aggregator_sessions (
  tenant_id     uuid primary key references public.tenants(id) on delete cascade,
  -- AES-256-GCM: {iv, tag, ciphertext} base64-encoded json envelope
  snapshot_encrypted text not null,
  -- Which app-key version encrypted this row. Bump when key rotates so readers
  -- know to reject a snapshot they can't decrypt (rather than crash silently).
  key_version   int not null default 1,
  -- Sanity metrics — how many cookies were in the last snapshot, per channel.
  -- Not sensitive; useful for the FE to show "session backed up 4 min ago".
  counts        jsonb not null default '{}'::jsonb,
  last_snapshot_at timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.tenant_aggregator_sessions enable row level security;

-- No policies here — the routes will use the service_role key. The merchant
-- write endpoint scopes the tenant from the JWT (req.tenantId), never from
-- request body, so cross-tenant writes are impossible at the app layer.

create index if not exists tenant_aggregator_sessions_updated_idx
  on public.tenant_aggregator_sessions(updated_at desc);
