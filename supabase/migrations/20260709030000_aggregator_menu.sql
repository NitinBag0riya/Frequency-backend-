-- 20260709030000_aggregator_menu
-- Stores the aggregator (Zomato/Swiggy) menu the DynoAPIs client pushes, so an
-- onboarded restaurant's EXISTING items/categories land in our POS (day-one
-- catalog) and drive the stock-toggle UI.
--
-- Dedup identity: the aggregator's own entity id, scoped by outlet. A Zomato
-- res_id and a Swiggy res_id never collide, so (tenant, outlet_ref, entity_type,
-- entity_id) is a stable natural key — re-syncs UPDATE in place, never dupe.
-- `channel` is best-effort (resolved from orders when known); it's informational
-- because DynoAPIs applies stock actions by outlet_ref, not channel.

create table if not exists public.aggregator_menu (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  source        text not null default 'dynoapis',
  channel       text,                          -- zomato|swiggy|null(unknown yet)
  outlet_ref    text not null,
  entity_type   text not null,                 -- item | category
  entity_id     text not null,                 -- aggregator's own id
  name          text,
  in_stock      boolean not null default true,
  price         numeric(12,2),
  currency      text not null default 'INR',
  category_ref  text,                          -- parent category id (for items)
  raw           jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists aggregator_menu_natural_key
  on public.aggregator_menu (tenant_id, outlet_ref, entity_type, entity_id);
create index if not exists aggregator_menu_tenant_outlet_idx
  on public.aggregator_menu (tenant_id, outlet_ref, entity_type);

-- Per-outlet full-menu sync state. `pending_full_sync` true (or no row) makes the
-- next DynoAPIs `GET /:resId/items` poll return getAllItems:true, so the client
-- fetches + pushes the whole menu. Fresh outlets start pending → auto day-one pull.
create table if not exists public.aggregator_menu_sync (
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  outlet_ref        text not null,
  pending_full_sync boolean not null default true,
  last_synced_at    timestamptz,
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, outlet_ref)
);

alter table public.aggregator_menu      enable row level security;
alter table public.aggregator_menu_sync enable row level security;

comment on table public.aggregator_menu is
  'Zomato/Swiggy menu items+categories pushed by DynoAPIs. Natural key (tenant,outlet,type,entity_id) → dedup. Drives the stock-toggle UI + day-one catalog. See src/routes/connectors/aggregator.ts.';
