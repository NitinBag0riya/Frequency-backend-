-- Fix meta_ad_accounts.ad_account_id UNIQUE — required for the FBLfB upsert
-- (onConflict:ad_account_id) to actually land. Without it Postgres errors
-- silently through supabase-js, so every tenant that connected Meta Ads got
-- a valid tenant_integrations row but zero mirrored ad accounts — making
-- /ads/meta/creatives, /ads/meta/campaigns, /ads/meta/ctwa etc. render
-- "No ad accounts found. Reconnect Meta Ads".
--
-- This migration:
--   1. Backfills meta_ad_accounts from tenant_integrations.metadata.ad_accounts
--      for tenants that connected before this fix (Sofastory + anyone else).
--   2. Dedupes by ad_account_id (keep oldest row) in case partial inserts
--      landed with duplicate ad_account_ids.
--   3. Adds the unique constraint that lets ON CONFLICT (ad_account_id) work.

insert into public.meta_ad_accounts (tenant_id, ad_account_id, name, currency)
select ti.tenant_id, a->>'id' as ad_account_id, a->>'name' as name, a->>'currency' as currency
from public.tenant_integrations ti,
     jsonb_array_elements(coalesce(ti.metadata->'ad_accounts','[]'::jsonb)) as a
where ti.key = 'meta_ads'
  and a->>'id' is not null
on conflict do nothing;

delete from public.meta_ad_accounts a using public.meta_ad_accounts b
  where a.ad_account_id = b.ad_account_id and a.created_at > b.created_at;

alter table public.meta_ad_accounts
  add constraint meta_ad_accounts_ad_account_id_key unique (ad_account_id);

notify pgrst, 'reload schema';
