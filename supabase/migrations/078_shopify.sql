-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 078 — Shopify integration (P1 #11)
--
-- BRIEF: First-class Shopify support so D2C tenants can wire
--   - order events (orders/create, orders/paid, orders/cancelled, orders/fulfilled)
--   - abandoned-cart recovery (checkouts/create, checkouts/update + 10-min poller)
--   - COD confirmation flows (orders/create where payment method matches COD)
-- into Frequency's WA / Telegram / Instagram pipelines via the chat-driven
-- workflow builder. Competitors (Wati, AiSensy) ship Shopify apps day one;
-- without this Frequency is a non-starter for the D2C ICP.
--
-- Three tables:
--   1. shopify_stores             — one row per (tenant, shop_domain).
--                                   Encrypted access_token + per-store webhook
--                                   secret. uninstalled_at soft-delete (audit
--                                   trail, not row removal).
--   2. shopify_order_events       — append-only event log written by the
--                                   /api/webhooks/shopify handler. Dedup via
--                                   unique (store_id, shopify_order_id, topic)
--                                   so Shopify retries are idempotent.
--   3. shopify_abandoned_checkouts — upsert target for checkouts/create|update.
--                                    nudge_sent_at + recovered_at let the
--                                    poller / webhook decide who's still
--                                    eligible for the recovery flow.
--
-- RLS model:
--   shopify_stores                 — tenant CRUD on own rows; service-role
--                                    bypasses for OAuth callback writes.
--   shopify_order_events           — append-only via service role; tenants
--                                    SELECT only. authenticated INSERT/UPDATE/
--                                    DELETE explicitly REVOKED to prevent a
--                                    compromised tenant token from forging
--                                    Shopify events.
--   shopify_abandoned_checkouts    — same pattern as order_events.
--
-- Idempotent — safe to re-run. No `||` inside COMMENT ON (PG rejects string
-- concatenation in those — 076 hit that bug; comments here are single
-- string literals).
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. shopify_stores ───────────────────────────────────────────────────────
create table if not exists public.shopify_stores (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  shop_domain              text not null,
  shop_name                text,
  access_token_encrypted   text not null,
  scope                    text not null,
  installed_at             timestamptz not null default now(),
  uninstalled_at           timestamptz,
  webhook_secret           text not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (tenant_id, shop_domain)
);

create index if not exists idx_shopify_stores_tenant on public.shopify_stores(tenant_id);
create index if not exists idx_shopify_stores_shop   on public.shopify_stores(shop_domain);

comment on table public.shopify_stores is
  'Shopify Admin OAuth installations. One row per (tenant, shop_domain). access_token_encrypted is AES-256-GCM (src/lib/crypto.ts). webhook_secret is generated per-install and used to HMAC-verify inbound webhook calls. uninstalled_at is set (not row deleted) when app/uninstalled fires, so the order-event audit trail keeps its FK target.';

alter table public.shopify_stores enable row level security;

drop policy if exists "shopify_stores_tenant" on public.shopify_stores;
-- Tenant RLS — same pattern as lead_tables (013). Read/write gated by tenant
-- ownership or membership in user_roles. Service-role writes (OAuth callback,
-- webhook handler) bypass RLS entirely.
create policy "shopify_stores_tenant" on public.shopify_stores
  for all using (
    exists (select 1 from public.tenants tn where tn.id = shopify_stores.tenant_id and tn.user_id = auth.uid())
    or exists (select 1 from public.user_roles r where r.tenant_id = shopify_stores.tenant_id and r.user_id = auth.uid())
  );

-- ─── 2. shopify_order_events ─────────────────────────────────────────────────
create table if not exists public.shopify_order_events (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  store_id              uuid not null references public.shopify_stores(id) on delete cascade,
  shopify_order_id      text not null,
  shopify_order_number  text,
  topic                 text not null,
  customer_email        text,
  customer_phone        text,
  customer_first_name   text,
  customer_last_name    text,
  total_inr_paise       bigint,
  currency              text,
  financial_status      text,
  fulfillment_status    text,
  payment_method        text,
  raw_payload           jsonb not null,
  matched_contact_id    uuid references public.contacts(id),
  workflow_run_id       uuid,
  received_at           timestamptz not null default now(),
  unique (store_id, shopify_order_id, topic)
);

create index if not exists idx_soe_tenant_received on public.shopify_order_events(tenant_id, received_at desc);
create index if not exists idx_soe_phone           on public.shopify_order_events(customer_phone) where customer_phone is not null;
create index if not exists idx_soe_store           on public.shopify_order_events(store_id);

comment on table public.shopify_order_events is
  'Append-only log of Shopify order webhooks. One row per (store_id, shopify_order_id, topic) — Shopify delivers each event with at-least-once semantics so we dedup on the unique constraint and silently swallow duplicates. total_inr_paise is the canonical money column (Shopify ships strings in major units; the webhook handler converts). matched_contact_id is filled when phone/email matches an existing contact so workflows can reference {{trigger.contact_id}}.';

alter table public.shopify_order_events enable row level security;
revoke insert, update, delete on public.shopify_order_events from authenticated;
revoke insert, update, delete on public.shopify_order_events from anon;

drop policy if exists "shopify_order_events_tenant_read" on public.shopify_order_events;
create policy "shopify_order_events_tenant_read" on public.shopify_order_events
  for select to authenticated
  using (
    exists (select 1 from public.tenants tn where tn.id = shopify_order_events.tenant_id and tn.user_id = auth.uid())
    or exists (select 1 from public.user_roles r where r.tenant_id = shopify_order_events.tenant_id and r.user_id = auth.uid())
  );

-- ─── 3. shopify_abandoned_checkouts ──────────────────────────────────────────
create table if not exists public.shopify_abandoned_checkouts (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  store_id               uuid not null references public.shopify_stores(id) on delete cascade,
  shopify_checkout_id    text not null,
  checkout_url           text not null,
  customer_phone         text,
  customer_email         text,
  customer_first_name    text,
  total_inr_paise        bigint,
  abandoned_at           timestamptz not null,
  recovered_at           timestamptz,
  nudge_sent_at          timestamptz,
  raw_payload            jsonb not null,
  created_at             timestamptz not null default now(),
  unique (store_id, shopify_checkout_id)
);

create index if not exists idx_sac_tenant_abandoned  on public.shopify_abandoned_checkouts(tenant_id, abandoned_at desc);
create index if not exists idx_sac_recovery_pending  on public.shopify_abandoned_checkouts(tenant_id)
  where recovered_at is null and nudge_sent_at is null;

comment on table public.shopify_abandoned_checkouts is
  'Open Shopify checkouts that have not converted. Poller (src/workers/shopify-abandoned-cart-poller.ts) runs every 5 minutes and fires the shopify_abandoned_cart workflow trigger for rows where abandoned_at < now() - 10 min AND recovered_at IS NULL AND nudge_sent_at IS NULL AND customer_phone IS NOT NULL. recovered_at is stamped when orders/create arrives matching this checkout_id (best-effort — Shopify does not always emit this link).';

alter table public.shopify_abandoned_checkouts enable row level security;
revoke insert, update, delete on public.shopify_abandoned_checkouts from authenticated;
revoke insert, update, delete on public.shopify_abandoned_checkouts from anon;

drop policy if exists "shopify_abandoned_checkouts_tenant_read" on public.shopify_abandoned_checkouts;
create policy "shopify_abandoned_checkouts_tenant_read" on public.shopify_abandoned_checkouts
  for select to authenticated
  using (
    exists (select 1 from public.tenants tn where tn.id = shopify_abandoned_checkouts.tenant_id and tn.user_id = auth.uid())
    or exists (select 1 from public.user_roles r where r.tenant_id = shopify_abandoned_checkouts.tenant_id and r.user_id = auth.uid())
  );
