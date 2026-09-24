-- Migration — meta_audiences.remote_id
--
-- The existing meta_audiences table (migration 016 + 062) tracks audiences
-- CREATED via Frequency's own /api/meta-ads/audiences endpoint. It keys off
-- meta_audience_id, but the sync path that mirrors a tenant's EXISTING
-- Ads-Manager audiences needs a stable upsert key. Meta's Graph API returns
-- `id` for every customaudience — that's what we store in remote_id.
--
-- Kept separate from meta_audience_id (nullable, unique) so existing
-- code + data are untouched:
--   • Rows created through our POST /audiences continue to set
--     meta_audience_id verbatim (and remote_id via the same value on
--     next sync tick, or via the new sync helper on create).
--   • Rows mirrored from the sync helper always set remote_id.
--
-- Unique per tenant so two tenants can share the same Meta audience id
-- (rare but possible with agency accounts).

alter table public.meta_audiences
  add column if not exists remote_id text;

create unique index if not exists meta_audiences_tenant_remote_id
  on public.meta_audiences (tenant_id, remote_id)
  where remote_id is not null;

comment on column public.meta_audiences.remote_id is
  'Meta customaudience id as returned by Graph GET /{act_id}/customaudiences. '
  'Upsert key for src/lib/meta-graph-sync.ts:syncCustomAudiences(). Distinct '
  'from meta_audience_id (which is the write-side identifier for audiences '
  'we created ourselves via POST /audiences).';

notify pgrst, 'reload schema';
