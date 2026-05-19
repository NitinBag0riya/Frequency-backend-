-- 097_wa_commerce_khaata
--
-- Phase 4 of the post-deploy roadmap. WhatsApp-native commerce for the
-- Indian khaata pattern (daily delivery + monthly settlement). MVP
-- schema — order capture + ledger + standing orders. Delivery
-- operations (route planning, delivery-boy app, photo proof) ship in
-- a follow-up migration once the data model proves out in pilot.
--
-- ─── What this migration creates ──────────────────────────────────────────
--
-- 1. catalog_items — vendor's product list. alt_names[] supports the
--    Hindi/English code-switch matching ("atta" / "गेहूं आटा" / "wheat flour").
--
-- 2. khaata_accounts — per-(tenant, contact) running tab + credit
--    limit + trust score.
--
-- 3. khaata_transactions — append-only line items (order / settlement /
--    adjustment / refund). The balance on khaata_accounts is maintained
--    by trigger so reads don't need to aggregate.
--
-- 4. standing_orders — recurring order template (daily milk etc.) with
--    skip_dates[] + pause_from/to.
--
-- 5. monthly_settlements — one row per (account, month). Drives the
--    auto-bill cron at month-end.

set check_function_bodies = off;

-- pg_trgm needed for the catalog_items name trigram search index below.
-- pgvector was enabled by migration 096. Both ship with Supabase.
create extension if not exists pg_trgm;

-- ─── 1. catalog_items ────────────────────────────────────────────────────

create table if not exists public.catalog_items (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  name                text not null check (length(name) between 1 and 200),
  alt_names           text[] not null default '{}',  -- ["atta", "गेहूं आटा", "wheat flour"]
  unit                text not null default 'piece', -- piece | kg | g | L | mL | packet
  price_paise         bigint not null default 0 check (price_paise >= 0),
  category            text,
  image_url           text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_catalog_items_tenant_active
  on public.catalog_items(tenant_id, active);

create index if not exists idx_catalog_items_name_trgm
  on public.catalog_items using gin (lower(name) gin_trgm_ops);

-- alt_names GIN index (array membership). Common query pattern is
-- `where alt_names && ARRAY['atta', 'aata']` for fuzzy multilang lookup.
create index if not exists idx_catalog_items_alt_names
  on public.catalog_items using gin (alt_names);

comment on table public.catalog_items is
  'Vendor product catalogue. alt_names supports Hindi/English code-switch matching. price_paise is per unit (e.g. ₹65/L for milk). Bulk-import from photo of price list is a future ingest worker.';

-- ─── 2. khaata_accounts ──────────────────────────────────────────────────

create table if not exists public.khaata_accounts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  contact_id          uuid not null references public.contacts(id) on delete cascade,
  balance_paise       bigint not null default 0,
  -- credit_limit defines when the vendor's order-capture flow blocks
  -- new orders or just warns. 200 = ₹2, low default for new accounts.
  credit_limit_paise  bigint not null default 20000  -- ₹200
                      check (credit_limit_paise >= 0),
  -- "Bill me on day-of-month X". 1 = first of month (most common in
  -- India). 31 collapses to last-of-month.
  settlement_day      smallint not null default 1 check (settlement_day between 1 and 31),
  last_settled_at     timestamptz,
  -- 0..1; auto-bumped by the trust scorer when settlements land on time.
  trust_score         numeric(4,3) not null default 0.300
                      check (trust_score between 0 and 1),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists ux_khaata_accounts_tenant_contact
  on public.khaata_accounts(tenant_id, contact_id);

create index if not exists idx_khaata_accounts_tenant_balance
  on public.khaata_accounts(tenant_id, balance_paise desc);

-- ─── 3. khaata_transactions ─────────────────────────────────────────────

create table if not exists public.khaata_transactions (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.khaata_accounts(id) on delete cascade,
  conversation_phone  text,                              -- inbox keying
  message_id          text,                              -- the source message
  -- order             — customer placed an order, balance += amount
  -- settlement        — customer paid, balance -= amount
  -- adjustment        — manual vendor correction (cash from drawer, etc.)
  -- refund            — vendor returned money, balance -= amount
  type                text not null check (type in ('order','settlement','adjustment','refund')),
  items_json          jsonb not null default '[]'::jsonb,
  amount_paise        bigint not null,                   -- signed; +ve = customer owes more
  delivered_at        timestamptz,
  paid_at             timestamptz,
  razorpay_payment_id text,
  notes               text,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now()
);

create index if not exists idx_khaata_transactions_account_time
  on public.khaata_transactions(account_id, created_at desc);

-- Maintain khaata_accounts.balance_paise via trigger. Simple sum: amount
-- is signed (positive on order/adjustment-up, negative on settlement /
-- refund / adjustment-down).
create or replace function public.tg_khaata_transactions_update_balance()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT') then
    update public.khaata_accounts
       set balance_paise = balance_paise + new.amount_paise,
           updated_at = now()
     where id = new.account_id;
  elsif (tg_op = 'DELETE') then
    update public.khaata_accounts
       set balance_paise = balance_paise - old.amount_paise,
           updated_at = now()
     where id = old.account_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_khaata_transactions_update_balance on public.khaata_transactions;
create trigger trg_khaata_transactions_update_balance
  after insert or delete on public.khaata_transactions
  for each row execute function public.tg_khaata_transactions_update_balance();

comment on table public.khaata_transactions is
  'Append-only line items. amount_paise is SIGNED — +ve for order/adjustment-up, -ve for settlement/refund/adjustment-down. Trigger maintains khaata_accounts.balance_paise on every insert/delete so reads avoid aggregation.';

-- ─── 4. standing_orders ──────────────────────────────────────────────────

create table if not exists public.standing_orders (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.khaata_accounts(id) on delete cascade,
  items_json          jsonb not null default '[]'::jsonb,
  frequency           text not null check (frequency in ('daily','weekly','custom_dates')),
  -- ISO-formatted dates the customer has opted to skip (single days).
  skip_dates          date[] not null default '{}',
  -- Pause window (start + end). Used when the customer goes on vacation.
  pause_from          date,
  pause_to            date,
  -- 'morning' | 'evening' | 'afternoon' — informational hint for the
  -- delivery-planning worker; doesn't gate anything yet.
  delivery_window     text default 'morning',
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_standing_orders_active
  on public.standing_orders(account_id) where active = true;

-- ─── 5. monthly_settlements ──────────────────────────────────────────────

create table if not exists public.monthly_settlements (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.khaata_accounts(id) on delete cascade,
  period_start        date not null,
  period_end          date not null,
  total_paise         bigint not null default 0,
  paid_paise          bigint not null default 0,
  razorpay_link_id    text,
  razorpay_payment_id text,
  status              text not null default 'pending'
                      check (status in ('pending','paid','overdue','waived')),
  reminder_sent_at    timestamptz[],                     -- 1st-of-month, 5th, 10th, etc.
  paid_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists ux_monthly_settlements_account_period
  on public.monthly_settlements(account_id, period_start);

-- ─── RLS ──────────────────────────────────────────────────────────────────

alter table public.catalog_items        enable row level security;
alter table public.khaata_accounts      enable row level security;
alter table public.khaata_transactions  enable row level security;
alter table public.standing_orders      enable row level security;
alter table public.monthly_settlements  enable row level security;

drop policy if exists "catalog_items_tenant_rw" on public.catalog_items;
create policy "catalog_items_tenant_rw" on public.catalog_items for all to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
  );

drop policy if exists "khaata_accounts_tenant_rw" on public.khaata_accounts;
create policy "khaata_accounts_tenant_rw" on public.khaata_accounts for all to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
  );

-- Child tables join through khaata_accounts; reusing parent's tenant check.
drop policy if exists "khaata_transactions_tenant_rw" on public.khaata_transactions;
create policy "khaata_transactions_tenant_rw" on public.khaata_transactions for all to authenticated
  using (exists (
    select 1 from public.khaata_accounts a
    where a.id = khaata_transactions.account_id
      and a.tenant_id in (
        select tenant_id from public.user_role_assignments where user_id = auth.uid()
        union
        select tenant_id from public.user_roles where user_id = auth.uid()
      )
  ));

drop policy if exists "standing_orders_tenant_rw" on public.standing_orders;
create policy "standing_orders_tenant_rw" on public.standing_orders for all to authenticated
  using (exists (
    select 1 from public.khaata_accounts a
    where a.id = standing_orders.account_id
      and a.tenant_id in (
        select tenant_id from public.user_role_assignments where user_id = auth.uid()
        union
        select tenant_id from public.user_roles where user_id = auth.uid()
      )
  ));

drop policy if exists "monthly_settlements_tenant_rw" on public.monthly_settlements;
create policy "monthly_settlements_tenant_rw" on public.monthly_settlements for all to authenticated
  using (exists (
    select 1 from public.khaata_accounts a
    where a.id = monthly_settlements.account_id
      and a.tenant_id in (
        select tenant_id from public.user_role_assignments where user_id = auth.uid()
        union
        select tenant_id from public.user_roles where user_id = auth.uid()
      )
  ));

