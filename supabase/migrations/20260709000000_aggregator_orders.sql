-- 20260709000000_aggregator_orders
-- Source-agnostic food-aggregator order pipeline (Zomato / Swiggy).
--
-- Unlike zomato_orders (which is bound to the direct partner webhook), these
-- two tables are NORMALISED across whatever *source* is currently feeding the
-- tenant's aggregator orders:
--
--   source = 'dynoapis'      -- interim: DynoAPIs desktop client on the merchant's
--                               machine pushes orders to our per-tenant webhook
--                               and pulls back the decisions we queue here.
--   source = 'urbanpiper'    -- middleware partner (future adapter)
--   source = 'zomato_direct' -- official partner API once approved (future)
--   source = 'swiggy_direct'
--
-- The FE/BE talk only to the normalised /api/connectors/aggregator/* API; the
-- active adapter (see src/connectors/aggregator/) decides HOW a decision reaches
-- the aggregator. For the DynoAPIs adapter that is a PULL model: the merchant's
-- machine polls our webhook for pending actions, executes them against Zomato/
-- Swiggy itself, and posts the result back — our servers never touch the
-- aggregators directly.

create table if not exists public.aggregator_orders (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  source                text not null default 'dynoapis',      -- dynoapis|urbanpiper|zomato_direct|swiggy_direct
  channel               text not null,                          -- zomato|swiggy
  -- The aggregator's own order id (unique per tenant+channel) — upsert key.
  external_order_id     text not null,
  outlet_ref            text,                                   -- restaurant / outlet id at the aggregator
  -- Normalised lifecycle: new | preparing | ready | picked_up | delivered |
  -- rejected | cancelled  (mapped by the adapter from the source's own states).
  status                text not null default 'new',
  -- Raw source-specific status string, kept for change-detection / debugging.
  status_identifier     text,
  customer_name         text,
  customer_phone_masked text,                                   -- aggregators mask this — never store raw
  item_count            int  not null default 0,
  gross_amount          numeric(12,2),
  currency              text not null default 'INR',
  placed_at             timestamptz,
  -- Operator decision queued for the source to execute (pull model).
  --   pending_action: accept | ready | reject | null(none)
  pending_action        text,
  pending_prep_time     int,                                    -- minutes, for accept
  pending_reason        text,                                   -- for reject
  pending_queued_at     timestamptz,
  -- Result the source reported after executing the decision.
  last_action_result    jsonb,
  -- Full raw order payload of the latest event from the source.
  payload               jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists aggregator_orders_tenant_channel_order_uniq
  on public.aggregator_orders (tenant_id, channel, external_order_id);
create index if not exists aggregator_orders_tenant_status_idx
  on public.aggregator_orders (tenant_id, status, placed_at desc);
-- Fast lookup of orders with a decision still waiting to be pulled by the source.
create index if not exists aggregator_orders_pending_idx
  on public.aggregator_orders (tenant_id, outlet_ref, channel)
  where pending_action is not null;

-- Queue of stock (item / category) on-off toggles waiting for the source to
-- execute, plus their results. Same pull model as order decisions.
create table if not exists public.aggregator_stock_actions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  source       text not null default 'dynoapis',
  channel      text not null,                                   -- zomato|swiggy
  outlet_ref   text not null,
  entity_type  text not null,                                   -- item|category
  entity_id    text not null,
  in_stock     boolean not null,
  status       text not null default 'pending',                -- pending|done|failed
  result       jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists aggregator_stock_pending_idx
  on public.aggregator_stock_actions (tenant_id, outlet_ref, channel, status)
  where status = 'pending';

-- RLS on, no permissive policies: only the backend service role (which bypasses
-- RLS) reads/writes. The dashboard reaches these tables through the API only.
alter table public.aggregator_orders        enable row level security;
alter table public.aggregator_stock_actions enable row level security;

comment on table public.aggregator_orders is
  'Normalised Zomato/Swiggy orders, source-agnostic (dynoapis|urbanpiper|*_direct). See src/routes/connectors/aggregator.ts.';
comment on table public.aggregator_stock_actions is
  'Queued item/category stock toggles for the active aggregator source to execute (pull model).';
