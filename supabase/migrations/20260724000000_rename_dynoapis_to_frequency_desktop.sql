-- Rename the interim aggregator source: DynoAPIs → Frequency Desktop.
--
-- The desktop app is now our own Frequency Desktop, and it authenticates every
-- relay with the merchant's logged-in Frequency session instead of a per-tenant
-- ingest token — so this migration also DROPS the now-unused token from
-- tenant_integrations.metadata. Data-only; no schema change.
--
-- Safe to run once on deploy. Idempotent: re-running is a no-op (nothing matches
-- the old 'dynoapis' values on a second pass).

-- 1) The connection row: key, label, and metadata (drop ingest_token, set source).
update tenant_integrations
set key         = 'aggregator_frequency_desktop',
    brand_label = 'Zomato/Swiggy · Frequency Desktop',
    metadata    = (coalesce(metadata, '{}'::jsonb) - 'ingest_token')
                  || jsonb_build_object('source', 'frequency_desktop')
where key = 'aggregator_dynoapis';

-- 2) The `source` tag on every row the old adapter wrote.
update aggregator_orders        set source = 'frequency_desktop' where source = 'dynoapis';
update aggregator_menu          set source = 'frequency_desktop' where source = 'dynoapis';
update aggregator_order_history set source = 'frequency_desktop' where source = 'dynoapis';
update aggregator_heartbeats    set source = 'frequency_desktop' where source = 'dynoapis';
