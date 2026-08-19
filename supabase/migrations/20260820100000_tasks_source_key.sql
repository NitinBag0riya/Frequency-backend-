-- Frequency Tasks auto-fire: a stable idempotency key for system-generated (SOP) tasks.
-- Lets an event rule (e.g. "khata due crossed a threshold") dedupe — one open task per
-- source instead of a new one on every firing. Nullable + additive; manual tasks leave it null.
alter table if exists public.tasks
  add column if not exists source_key text;

-- Fast "is there already an open task for this source?" lookup (the dedup check).
create index if not exists tasks_tenant_source_key_idx
  on public.tasks (tenant_id, source_key)
  where source_key is not null;

comment on column public.tasks.source_key is
  'Idempotency key for auto-generated SOP tasks (e.g. khata_due:<party_key>); null = manual task.';
