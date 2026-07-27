-- Real-estate vertical — property listings (per-tenant, mirrors ledger_entries RLS).
create table if not exists public.listings (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  title        text not null,
  kind         text not null default 'sale',          -- 'sale' | 'rent'
  property_type text,                                  -- flat/villa/plot/office/…
  price        numeric,
  bedrooms     int,
  bathrooms    int,
  area_sqft    numeric,
  locality     text,
  city         text,
  status       text not null default 'available',      -- available | under_offer | sold | rented
  description  text,
  cover_image  text,
  by_email     text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.listings drop constraint if exists listings_kind_check;
alter table public.listings add constraint listings_kind_check check (kind in ('sale','rent'));
alter table public.listings drop constraint if exists listings_status_check;
alter table public.listings add constraint listings_status_check check (status in ('available','under_offer','sold','rented'));
create index if not exists listings_tenant_idx on public.listings (tenant_id, created_at desc);
alter table public.listings enable row level security;
drop policy if exists listings_tenant_members on public.listings;
create policy listings_tenant_members on public.listings for all to public
  using (tenant_id in (select current_user_tenant_ids()))
  with check (tenant_id in (select current_user_tenant_ids()));
