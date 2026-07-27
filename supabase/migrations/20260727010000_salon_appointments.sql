-- Salon/services vertical — appointments (per-tenant, mirrors listings RLS).
create table if not exists public.appointments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  customer_name  text,
  customer_phone text,
  service        text,
  stylist        text,
  starts_at      timestamptz not null,
  duration_min   int not null default 30,
  status         text not null default 'booked',   -- booked|confirmed|completed|no_show|cancelled
  price          numeric,
  note           text,
  by_email       text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check check (status in ('booked','confirmed','completed','no_show','cancelled'));
create index if not exists appointments_tenant_start_idx on public.appointments (tenant_id, starts_at);
alter table public.appointments enable row level security;
drop policy if exists appointments_tenant_members on public.appointments;
create policy appointments_tenant_members on public.appointments for all to public
  using (tenant_id in (select current_user_tenant_ids()))
  with check (tenant_id in (select current_user_tenant_ids()));
