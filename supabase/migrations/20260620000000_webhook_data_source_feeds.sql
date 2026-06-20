-- Webhook feeds as first-class data sources: a table can have several webhook
-- push sources (Meta, 99acres, …), each with its OWN ingest token + mapping,
-- exactly like its Google Sheet / Airtable mirror feeds. Unifies every input
-- under data_source_subscriptions so the "Data sources" tab is uniform.

alter table public.data_source_subscriptions
  drop constraint if exists data_source_subscriptions_source_type_check;
alter table public.data_source_subscriptions
  add constraint data_source_subscriptions_source_type_check
  check (source_type in ('google_sheet', 'airtable', 'csv_url', 'webhook'));

-- Per-feed ingest token (only set for source_type='webhook'). Unique so the
-- ingest path can resolve a POST → the exact feed → its table + mapping.
alter table public.data_source_subscriptions
  add column if not exists ingest_token text;
create unique index if not exists dss_ingest_token_uniq
  on public.data_source_subscriptions(ingest_token)
  where ingest_token is not null;
