-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 20260814 (b) — Naruto §5 Step 3: catalog import undo store.
--
-- Backs the CSV/Excel import pipeline's 24h rollback (spec §5 Step 3:
-- "dry-run always → commit → rollback 24h"). One row per COMMITTED import batch,
-- holding the pre-image needed to reverse it exactly.
--
-- The catalog itself is NOT stored here — items live in the tenant's lead_rows
-- (Database→Tables, via lib/catalog.ts). This table only records, per commit,
-- which rows the batch touched and their prior state, so a rollback can delete
-- the rows it created and restore the rows it updated.
--
-- ADDITIVE + idempotent. RLS is intentionally NOT enabled: the only writer/reader
-- is the platform import service (service-role client, capability-gated at the
-- route via requirePlatformCapability('onboarding.import.run')). No tenant-user
-- path reaches this table.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.catalog_import_batches (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  actor_user_id      uuid,
  vertical           text,
  slug               text,
  categories_table_id text,
  items_table_id      text,
  -- {created, updated, skipped, errors} — the applied summary shown in the UI.
  summary            jsonb not null default '{}'::jsonb,
  -- Reverse-image for rollback:
  --   { items:      [{ id, data }]  data=null → row CREATED by this batch (rollback deletes it)
  --                                 data=obj  → prior row state (rollback restores it)
  --     categories: [{ id }] }      category rows CREATED by this batch (rollback deletes if unreferenced)
  pre_image          jsonb not null default '{}'::jsonb,
  -- Double-clicked commit must not import twice (spec §1.2 "all writes idempotent and keyed").
  idempotency_key    text,
  status             text not null default 'committed',   -- committed | rolled_back
  reason             text,
  created_at         timestamptz not null default now(),
  rolled_back_at     timestamptz,
  -- Rollback allowed only while now() < expires_at AND status = 'committed'.
  expires_at         timestamptz not null default (now() + interval '24 hours')
);

create index if not exists catalog_import_batches_tenant_time
  on public.catalog_import_batches (tenant_id, created_at desc);

-- Idempotency is per-tenant: the same key from two different tenants is fine.
create unique index if not exists catalog_import_batches_idem
  on public.catalog_import_batches (tenant_id, idempotency_key)
  where idempotency_key is not null;
