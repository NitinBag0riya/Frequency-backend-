-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 014 — data_source_subscriptions
--
-- Connects an internal `lead_tables` row to an external data source (Google
-- Sheet today; Airtable / CSV URL tomorrow). The data-source-sync worker
-- (workers/data-source-sync.ts) polls each due subscription every
-- `sync_interval_minutes` minutes and upserts rows into `lead_rows`, so the
-- user's CRM stays in sync with the external system without manual import.
--
-- Architecture choice: poll-based, not webhook-based, for the MVP.
--   - Google Sheets webhooks (Drive push notifications via watch channels)
--     require a publicly-reachable HTTPS endpoint and channel renewal logic.
--     We can layer that on later by adding a `webhook_channel_id` column.
--   - Airtable webhooks require base-level auth + signing key handling.
--     Same staged approach.
--
-- Indexes:
--   - sub_due (next_sync_at WHERE status='active'): hot path for the worker.
--   - sub_table (lead_table_id): used by the FE to show "this table is synced".
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.data_source_subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid references public.tenants(id) on delete cascade not null,
  lead_table_id         uuid references public.lead_tables(id) on delete cascade not null,
  source_type           text not null check (source_type in ('google_sheet', 'airtable', 'csv_url')),
  -- Source-specific config — for google_sheet: { spreadsheet_id, tab_name }
  --                          for airtable:     { base_id, table_id, view_id? }
  --                          for csv_url:      { url, auth? }
  source_config         jsonb not null default '{}'::jsonb,
  -- Maps source column → lead_columns.key (or .name). Empty = auto-detect by name.
  column_mappings       jsonb not null default '{}'::jsonb,
  sync_interval_minutes int  not null default 5 check (sync_interval_minutes >= 1),
  last_synced_at        timestamptz,
  next_sync_at          timestamptz default now(),
  status                text not null default 'active' check (status in ('active','paused','error')),
  last_error            text,
  rows_imported         int  not null default 0,
  rows_updated          int  not null default 0,
  created_by            uuid,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

alter table public.data_source_subscriptions enable row level security;

-- Owner-or-team access via tenant ownership. Service-role bypasses RLS so the
-- worker can read/write regardless.
create policy "data_sources_tenant" on public.data_source_subscriptions
  for all using (
    exists (
      select 1 from public.tenants t
      where t.id = data_source_subscriptions.tenant_id
        and (t.user_id = auth.uid())
    )
    or exists (
      select 1 from public.user_roles r
      where r.tenant_id = data_source_subscriptions.tenant_id
        and r.user_id = auth.uid()
    )
  );

-- Hot-path index used by the sync worker every 5 min.
create index if not exists sub_due
  on public.data_source_subscriptions(next_sync_at)
  where status = 'active';

create index if not exists sub_table
  on public.data_source_subscriptions(lead_table_id);

create index if not exists sub_tenant
  on public.data_source_subscriptions(tenant_id, created_at desc);

-- ── lead_tables: surface the link back so list pages can show a "synced" pill
alter table public.lead_tables
  add column if not exists synced_from_subscription_id
    uuid references public.data_source_subscriptions(id) on delete set null;
