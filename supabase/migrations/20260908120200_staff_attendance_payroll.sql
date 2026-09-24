-- ─────────────────────────────────────────────────────────────────────────────
-- staff_attendance + staff_payroll — HR-lite for HoReCa/Salon staff.
--
--   staff_attendance: append-only clock-in/out/break events, one row per event.
--                     Written by POST /api/staff/attendance (dashboard/POS).
--   staff_payroll:    per-period payroll amounts + status.
--                     Written by POST /api/staff/payroll (upsert on the natural
--                     key: tenant_id + staff_email + period_start).
--
-- Reads scoped to tenant members via current_user_tenant_ids().
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.staff_attendance (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  outlet_id   text,
  staff_email text        not null,
  staff_name  text,
  kind        text        not null,
  at          timestamptz not null default now(),
  note        text
);

alter table public.staff_attendance drop constraint if exists staff_attendance_kind_check;
alter table public.staff_attendance add constraint staff_attendance_kind_check
  check (kind in ('in','out','break-start','break-end'));

create index if not exists staff_attendance_tenant_at_idx
  on public.staff_attendance (tenant_id, at desc);
create index if not exists staff_attendance_tenant_staff_idx
  on public.staff_attendance (tenant_id, staff_email, at desc);

alter table public.staff_attendance enable row level security;

do $$ begin
  create policy staff_attendance_tenant_read on public.staff_attendance
    for select to public
    using (tenant_id in (select current_user_tenant_ids()));
exception when duplicate_object then null; end $$;


create table if not exists public.staff_payroll (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  staff_email  text        not null,
  period_start date        not null,
  period_end   date        not null,
  amount_inr   numeric     not null default 0,
  status       text        not null default 'pending',
  due_on       date,
  paid_on      date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, staff_email, period_start)
);

alter table public.staff_payroll drop constraint if exists staff_payroll_status_check;
alter table public.staff_payroll add constraint staff_payroll_status_check
  check (status in ('pending','paid'));

create index if not exists staff_payroll_tenant_due_idx
  on public.staff_payroll (tenant_id, due_on);

alter table public.staff_payroll enable row level security;

do $$ begin
  create policy staff_payroll_tenant_read on public.staff_payroll
    for select to public
    using (tenant_id in (select current_user_tenant_ids()));
exception when duplicate_object then null; end $$;
