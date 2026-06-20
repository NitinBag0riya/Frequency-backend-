-- "Existing table" as a data source: one lead_table's rows mirror into another,
-- applying the feed's mapping. Adds 'lead_table' to the source_type set; the
-- source table id is stored in source_config.source_table_id.
alter table public.data_source_subscriptions
  drop constraint if exists data_source_subscriptions_source_type_check;
alter table public.data_source_subscriptions
  add constraint data_source_subscriptions_source_type_check
  check (source_type in ('google_sheet', 'airtable', 'csv_url', 'webhook', 'lead_table'));
