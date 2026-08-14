-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 20260814140000 — Naruto Platform OS §7: internal per-tenant notes.
--
-- The Support console's "Notes" surface: free-text, platform-team-only jottings
-- attached to a tenant ("owner unreachable on WA, emailed instead", "KYC docs
-- rejected twice — chasing"). NOT visible to the tenant.
--
-- ADDITIVE + idempotent. Service-role only, exactly like webhook_dead_letter
-- (migration 064): RLS is ON with NO policies, so every anon/authed/tenant read
-- is blocked and only the service-role client (which the capability-guarded
-- /api/naruto/* routes use) can touch it. Access is gated in code by the wave-1
-- platform capability model (routes/naruto-support.ts), not by RLS policies.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.tenant_notes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  -- The platform user who wrote it (auth.users). Kept for attribution in the
  -- timeline; nullable so a note survives that user's deletion.
  author_user_id uuid,
  author_role    text,               -- canonical platform role key at write time
  body           text not null,
  pinned         boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists tenant_notes_tenant_idx
  on public.tenant_notes(tenant_id, created_at desc);

-- Service-role only. RLS enabled, no policies (deny-all to anon/authed).
alter table public.tenant_notes enable row level security;
