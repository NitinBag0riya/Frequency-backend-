-- ─────────────────────────────────────────────────────────────────────────────
-- Order stock from vendors — "Suppliers" (HoReCa-only).
--
-- A café/restaurant keeps a short list of suppliers (name + WhatsApp number),
-- builds a stock order (item + qty + unit), and sends it on their OWN WhatsApp
-- (wa.me — no template API). When the goods arrive they "update what came"
-- (qty + price actually delivered), which posts ONE vendor payable into the
-- existing Khata ledger (`ledger_entries`) so "You owe <supplier>" rolls up
-- with the rest of the khata.
--
-- Mirrors the org_tasks/khata tenant-RLS pattern (current_user_tenant_ids()).
-- Idempotent DDL (IF NOT EXISTS / ON CONFLICT). BETA-only apply.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── vendors ─────────────────────────────────────────────────────────────────
create table if not exists public.vendors (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  phone      text,                              -- last-10 digits (India), like the khata party key
  address    text,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists vendors_tenant_idx on public.vendors (tenant_id);

alter table public.vendors enable row level security;
drop policy if exists vendors_tenant_members on public.vendors;
create policy vendors_tenant_members on public.vendors for all to public
  using (tenant_id in (select current_user_tenant_ids()))
  with check (tenant_id in (select current_user_tenant_ids()));

-- ─── purchase_orders (a "stock order") ───────────────────────────────────────
create table if not exists public.purchase_orders (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  vendor_id       uuid references public.vendors(id) on delete set null,
  outlet_ref      text,                          -- delivery outlet id (storefront outlet)
  status          text not null default 'draft', -- draft|sent|received|cancelled
  lines           jsonb not null default '[]',   -- [{name, qty, unit, qtyReceived?, price?}]
  note            text,
  ledger_entry_id text,                          -- the khata payable posted on receive (idempotency guard)
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  received_at     timestamptz
);

alter table public.purchase_orders drop constraint if exists purchase_orders_status_check;
alter table public.purchase_orders add constraint purchase_orders_status_check
  check (status in ('draft','sent','received','cancelled'));

create index if not exists purchase_orders_tenant_idx        on public.purchase_orders (tenant_id);
create index if not exists purchase_orders_tenant_status_idx on public.purchase_orders (tenant_id, status);
create index if not exists purchase_orders_vendor_idx        on public.purchase_orders (vendor_id);

alter table public.purchase_orders enable row level security;
drop policy if exists purchase_orders_tenant_members on public.purchase_orders;
create policy purchase_orders_tenant_members on public.purchase_orders for all to public
  using (tenant_id in (select current_user_tenant_ids()))
  with check (tenant_id in (select current_user_tenant_ids()));

-- ─── Entitlements: register the `suppliers` feature (HoReCa-only, Store) ──────
insert into public.features (key, name, description, category, verticals, default_enabled, gate_style, sort_order) values
  ('suppliers', 'Order stock', 'Order stock from suppliers over WhatsApp; goods-receipt posts a khata payable', 'store', '{horeca}', false, 'locked_teaser', 46)
on conflict (key) do update set
  name = excluded.name, description = excluded.description, category = excluded.category,
  verticals = excluded.verticals, gate_style = excluded.gate_style, sort_order = excluded.sort_order,
  updated_at = now();

-- Grant to growth / scale / enterprise (the entitlements-resolver path the FE
-- nav mirror reads). Idempotent.
insert into public.plan_features (plan_id, feature_key)
select p.id, 'suppliers' from public.plans p where p.id in ('growth','scale','enterprise')
on conflict (plan_id, feature_key) do nothing;

-- checkPermission() still reads the legacy plans.features text[] whitelist, so
-- keep it in lockstep for plans without the '*' wildcard (growth). scale +
-- enterprise already carry '*'.
update public.plans
   set features = array_append(features, 'suppliers')
 where id = 'growth'
   and not (features @> array['suppliers']::text[]);
