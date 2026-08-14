-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 20260814100000 — Naruto Platform OS §5/§6: onboarding wizard.
--
-- ADDITIVE + idempotent. Two tables:
--   1. tenant_onboarding_checklists — one row per tenant, the whole 8-step
--      checklist as JSONB. Shared object: the /naruto wizard and (later) the
--      merchant dashboard both read/write it. Progress syncs both ways because
--      it is one row, not two mirrors.
--   2. tenant_outlets — locations captured in Step 2 (outlets & hours). Source
--      of truth for the /naruto onboarding flow.
--
-- RLS is enabled with NO public policy: platform reads/writes go through the
-- service role (bypasses RLS) via the capability-gated API. Cross-tenant reads
-- are therefore impossible for a normal tenant JWT.
--
-- WIRE(naruto): the merchant-dashboard surface (spec §5 — "every step also
-- completable by the merchant in their own dashboard") needs a tenant-scoped
-- RLS policy so an org member can read/update ONLY their own checklist +
-- outlets, e.g.:
--   create policy onboarding_self on tenant_onboarding_checklists
--     for all using (tenant_id = auth_tenant_id()) with check (tenant_id = auth_tenant_id());
-- Add it when that surface ships (mirror the tenant-scoped policy other
-- per-tenant tables already use). Until then the shared object is /naruto-only.
--
-- WIRE(naruto): tenant_outlets is the onboarding source of truth. The live
-- storefront keeps its own outlets in storefront-api. When a tenant goes live,
-- reconcile (push these into /admin/outlets) — one-way, onboarding → storefront.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Onboarding checklist (one row / tenant, whole object as JSONB) ─────────
create table if not exists public.tenant_onboarding_checklists (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  -- { create: {status, who_completed?, blocking_reason?, updated_at?}, outlets: {...}, ... }
  steps      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenant_onboarding_checklists enable row level security;

-- ── 2. Outlets captured in Step 2 ────────────────────────────────────────────
create table if not exists public.tenant_outlets (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  name               text not null,
  address            text,
  timezone           text,
  -- [{ day:0-6, open:'09:00', close:'22:00', closed:bool }]
  opening_hours      jsonb not null default '[]'::jsonb,
  -- { dine_in:bool, pickup:bool, delivery:bool }
  fulfilment         jsonb not null default '{}'::jsonb,
  delivery_radius_km numeric,
  -- optional [{ name, pincodes:[] }] — used when zones, not a radius, define delivery
  delivery_zones     jsonb,
  -- { tables } for horeca · { chairs, stations } for salon
  capacity           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists tenant_outlets_tenant_idx on public.tenant_outlets(tenant_id);

alter table public.tenant_outlets enable row level security;
