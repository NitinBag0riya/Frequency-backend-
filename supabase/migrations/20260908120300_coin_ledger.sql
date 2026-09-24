-- ─────────────────────────────────────────────────────────────────────────────
-- coin_ledger — every loyalty-coin earn/redeem/expire/adjust event.
--
-- Today, coin balance is a scalar on the storefront-api guest record. HQ needs
-- the raw event stream so it can show a customer's coin history and compute
-- net balance per party. Rows are inserted by:
--   1. Backfill: scripts/backfill-coin-ledger.ts — walks existing orders,
--      emits an 'earn' row per order with coinsEarned > 0.
--   2. Sync worker (workers/coin-ledger-sync.ts) — periodic catch-up from
--      the storefront-api order stream (see report: mutation lives in a
--      different repo, so we cannot write inline).
--
-- Uniqueness: (tenant_id, kind, order_id, party_key) prevents double-earn on
-- re-runs. order_id may be null for manual 'adjust' rows (still unique by uuid).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.coin_ledger (
  id         uuid        primary key default gen_random_uuid(),
  tenant_id  uuid        not null references public.tenants(id) on delete cascade,
  party_key  text        not null,           -- storefront-api guest key (phone last-10, else uid)
  phone      text,
  delta      integer     not null,           -- earn: +N, redeem/expire: -N, adjust: signed
  kind       text        not null,
  order_id   text,
  at         timestamptz not null default now()
);

alter table public.coin_ledger drop constraint if exists coin_ledger_kind_check;
alter table public.coin_ledger add constraint coin_ledger_kind_check
  check (kind in ('earn','redeem','adjust','expire'));

-- Idempotency guard for backfills + sync worker (a NULL in a UNIQUE column is
-- always considered distinct, so manual 'adjust' rows without an order_id still
-- coexist — good, we don't want the worker to swallow them).
create unique index if not exists coin_ledger_tenant_kind_order_party_uidx
  on public.coin_ledger (tenant_id, kind, order_id, party_key)
  where order_id is not null;

create index if not exists coin_ledger_tenant_party_at_idx
  on public.coin_ledger (tenant_id, party_key, at desc);

alter table public.coin_ledger enable row level security;

do $$ begin
  create policy coin_ledger_tenant_read on public.coin_ledger
    for select to public
    using (tenant_id in (select current_user_tenant_ids()));
exception when duplicate_object then null; end $$;
