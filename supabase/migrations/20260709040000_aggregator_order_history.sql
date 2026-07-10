-- 20260709040000_aggregator_order_history
-- Backfill of an onboarded restaurant's PAST aggregator orders, so an existing
-- restaurant sees its order history in our POS on day one (not just orders
-- placed after connecting).
--
-- Kept SEPARATE from aggregator_orders (which drives the live board + alerts +
-- pending actions) so hundreds of terminal past orders don't flood the live
-- board. This is the archive/reporting record. Dedup identity mirrors menu:
-- (tenant, outlet_ref, external_order_id).

create table if not exists public.aggregator_order_history (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  source            text not null default 'dynoapis',
  channel           text,                          -- zomato|swiggy|null(unknown)
  outlet_ref        text not null,
  external_order_id text not null,
  status            text,                          -- terminal state as reported
  customer_name     text,
  item_count        int not null default 0,
  gross_amount      numeric(12,2),
  currency          text not null default 'INR',
  placed_at         timestamptz,
  raw               jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists aggregator_order_history_natural_key
  on public.aggregator_order_history (tenant_id, outlet_ref, external_order_id);
create index if not exists aggregator_order_history_tenant_placed_idx
  on public.aggregator_order_history (tenant_id, placed_at desc);

-- Per-outlet history backfill state. pending_full_sync true (or no row) makes the
-- next `GET /:resId/orders/status` poll return orderHistory:true, so the client
-- fetches + pushes history once. One-shot day-one backfill.
create table if not exists public.aggregator_history_sync (
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  outlet_ref        text not null,
  pending_full_sync boolean not null default true,
  last_synced_at    timestamptz,
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, outlet_ref)
);

alter table public.aggregator_order_history enable row level security;
alter table public.aggregator_history_sync  enable row level security;

comment on table public.aggregator_order_history is
  'Backfilled past Zomato/Swiggy orders (day-one history for onboarded restaurants). Archive/reporting — separate from the live aggregator_orders board. See src/routes/connectors/aggregator.ts.';
