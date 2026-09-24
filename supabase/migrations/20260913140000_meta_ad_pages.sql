-- Migration — meta_ad_pages
--
-- Stores the Facebook Pages a tenant has connected via Meta Ads / Facebook
-- Login for Business. The Lead Ads webhook (POST /webhooks/meta with
-- field=leadgen) receives the page_id of the page the form was published
-- against; we look up the tenant + PAGE access token (not the user token)
-- here to fetch the actual lead payload from Graph.
--
-- Rows are upserted in two places:
--   1. On the FBLfB callback (routes/meta-business-assets.ts) — enumerates
--      /me/accounts for the connected user and stores every page with a
--      leadgen-capable access_token.
--   2. On the classic meta_ads callback (routes/meta-ads.ts) — same pattern.
--
-- page_access_token is encrypted at rest (crypto.encrypt / .decrypt in
-- src/crypto.ts) — service-role-only read path via the webhook handler.

create table if not exists public.meta_ad_pages (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  page_id             text not null,
  name                text,
  page_access_token   text,                       -- encrypted (src/crypto.ts)
  subscribed_leadgen  boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (page_id)
);

create index if not exists meta_ad_pages_tenant on public.meta_ad_pages (tenant_id);

alter table public.meta_ad_pages enable row level security;
create policy "Tenant manages own ad_pages" on public.meta_ad_pages
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

comment on table public.meta_ad_pages is
  'Facebook Pages connected via Meta Ads / FBLfB. Powers Lead Ads webhook '
  '(routes/meta-webhook.ts) tenant resolution + page_access_token lookup.';

notify pgrst, 'reload schema';
