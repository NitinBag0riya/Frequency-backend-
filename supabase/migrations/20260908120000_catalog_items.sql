-- ─────────────────────────────────────────────────────────────────────────────
-- catalog_items — per-tenant mirror of the storefront menu.
--
-- The live menu lives in storefront-api's file/blob store (per-tenant
-- {items,categories}). HQ needs it queryable from Supabase to compute
-- menu-health (missing image / no recipe / disabled) without hitting each
-- tenant's storefront-api. `workers/catalog-sync.ts` mirrors it every 5 min.
--
-- Read-only for tenant members (writes are server-side only via service role).
-- Idempotent DDL; policies wrapped in a duplicate_object guard so re-apply is a
-- no-op. BETA-only apply — main session runs supabase db push.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.catalog_items (
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  item_id      text        not null,
  name         text        not null,
  category     text,
  price_inr    numeric,
  image_url    text,
  has_recipe   boolean     not null default false,
  is_available boolean     not null default true,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, item_id)
);

create index if not exists catalog_items_tenant_updated_idx
  on public.catalog_items (tenant_id, updated_at desc);

alter table public.catalog_items enable row level security;

do $$ begin
  create policy catalog_items_tenant_read on public.catalog_items
    for select to public
    using (tenant_id in (select current_user_tenant_ids()));
exception when duplicate_object then null; end $$;
