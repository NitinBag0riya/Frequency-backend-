-- ─────────────────────────────────────────────────────────────────────────────
-- wastage_entries — per-tenant mirror of the storefront-api day-end wastage log
-- (a subset of `stockLedger` rows where reason='wastage').
--
-- HQ needs the last-N-days rollup queryable from Supabase.
-- `workers/wastage-sync.ts` upserts every 15 min. `id` is the storefront-api
-- ledger entry id so re-runs are idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.wastage_entries (
  id              text        primary key,   -- ledger entry id from storefront-api
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,
  outlet_id       text,
  ingredient_id   text,
  ingredient_name text,
  qty             numeric     not null default 0,
  unit            text,
  value_inr       numeric     not null default 0,
  reason          text,
  at              timestamptz not null default now()
);

create index if not exists wastage_entries_tenant_at_idx
  on public.wastage_entries (tenant_id, at desc);

alter table public.wastage_entries enable row level security;

do $$ begin
  create policy wastage_entries_tenant_read on public.wastage_entries
    for select to public
    using (tenant_id in (select current_user_tenant_ids()));
exception when duplicate_object then null; end $$;
