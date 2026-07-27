alter table public.appointments add column if not exists assigned_to uuid;
create index if not exists appointments_assigned_idx on public.appointments (tenant_id, assigned_to);
