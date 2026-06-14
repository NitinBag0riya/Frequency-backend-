-- 20260614000000_zomato_orders
-- Channel orders ingested from Zomato's Order-Management integration.
--
-- The Zomato "Order Relay" webhook pushes new orders to a per-tenant URL minted
-- at connect time (see routes/connectors/zomato.ts). Each relayed order — and
-- every subsequent status/rider/rating/complaint/cancellation event — is
-- normalised and upserted here so the operator order board can show Zomato
-- orders alongside the storefront's own.
--
-- SCAFFOLD: the exact Zomato payload field names are behind a partner-gated
-- OpenAPI spec, so `payload` keeps the full raw event and the mapped columns
-- are filled in by mapZomatoOrder() — refine the mapping once the spec is in
-- hand. Writes happen via the backend service role; RLS is service-role-only.

create table if not exists public.zomato_orders (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  -- Zomato's own order id (unique per tenant) — the upsert key for status updates.
  zomato_order_id text not null,
  -- Normalised lifecycle: placed | confirmed | rejected | ready | assigned |
  -- picked_up | delivered | cancelled (maps from Zomato's event types).
  status          text not null default 'placed',
  outlet_ref      text,
  customer_name   text,
  -- Zomato only ever exposes MASKED contact numbers — never store a raw number.
  customer_phone_masked text,
  item_count      int  not null default 0,
  gross_amount    numeric(12,2),
  currency        text not null default 'INR',
  rating          int,
  placed_at       timestamptz,
  -- Last raw event type Zomato sent for this order (relay, status_update, …).
  last_event_type text,
  -- Full raw payload of the latest event — the source of truth until the field
  -- mapping is finalised against the partner spec.
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists zomato_orders_tenant_order_uniq
  on public.zomato_orders (tenant_id, zomato_order_id);
create index if not exists zomato_orders_tenant_status_idx
  on public.zomato_orders (tenant_id, status, placed_at desc);

-- RLS on, no permissive policies: only the backend service role (which bypasses
-- RLS) reads/writes. The dashboard reaches this table through the API, never
-- directly, so we don't expose a client policy yet.
alter table public.zomato_orders enable row level security;

comment on table public.zomato_orders is
  'Orders ingested from the Zomato Order-Management webhook (scaffold — see routes/connectors/zomato.ts).';
