-- Frequency Khata — customer ledger / udhaar (Khatabook competitor).
--
-- Captures the `ledger_entries` table that was created directly on the project
-- (via the Management API) but never committed as a migration. Idempotent, so
-- applying it against the live DB is a no-op; it exists so the repo is the
-- source of truth for the schema.
--
-- direction: 'debit'  = YOU GAVE (sold on credit / customer's due goes up)
--            'credit' = YOU GOT  (customer paid / due goes down)
-- balance(party) = Σ debit − Σ credit  (positive = customer owes you).
-- source defaults to 'manual'; phase-2 auto-fill writes 'order'/'pos' so the
-- khata fills itself from the transactions we already own.

create table if not exists public.ledger_entries (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  party_key   text not null,               -- stable customer key (phone last-10 or name slug)
  party_name  text,
  party_phone text,
  direction   text not null,               -- 'debit' | 'credit'
  amount      numeric not null,
  source      text not null default 'manual',
  note        text,
  at          timestamptz default now(),   -- business date of the entry
  by_email    text,                        -- operator who recorded it
  created_at  timestamptz default now()
);

alter table public.ledger_entries
  drop constraint if exists ledger_entries_direction_check;
alter table public.ledger_entries
  add constraint ledger_entries_direction_check check (direction in ('debit', 'credit'));

create index if not exists ledger_entries_tenant_party_idx
  on public.ledger_entries (tenant_id, party_key);

alter table public.ledger_entries enable row level security;

-- Tenant members only. current_user_tenant_ids() is the shared helper used by
-- every tenant-scoped table. The server also filters by tenant_id explicitly
-- (service-role client bypasses RLS) — this is defense in depth.
drop policy if exists ledger_entries_tenant_members on public.ledger_entries;
create policy ledger_entries_tenant_members on public.ledger_entries
  for all to public
  using (tenant_id in (select current_user_tenant_ids()))
  with check (tenant_id in (select current_user_tenant_ids()));
